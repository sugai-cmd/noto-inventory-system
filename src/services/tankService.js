// タンク間の移動まわりの業務ロジック
// （旧GASの submitTankTransfer / submitTaxFreeTransfer 相当）。
//
// 浄酎容器変動履歴（tank_ledger）は to_tank_id を加算・from_tank_id を減算として
// 集計するため（3章 v_tank_monitor）、受払の種類ごとにどちらの列を埋めるかが決まる：
//   容器移動   : from と to の両方（タンク間の付け替え）
//   未納税移出 : from のみ（社外へ出るので受入先タンクはない）
//   継足       : to のみ（蒸留完了時。distillationService側で記録）
//   瓶詰       : from のみ（bottlingService側で記録）

const { getConnection } = require('../db/connection');

/** 棚卸で入れた度数は「タンク全体を測った値」として扱う区分 */
const MEASURED_TXN_TYPES = new Set(['棚卸調整', '欠減']);
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');
const { generateUid } = require('../utils/uid');
const operationLogService = require('./operationLogService');

function getTank(db, id, label) {
  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
  if (!tank) throw new NotFoundError(`${label}が見つかりません (id=${id})`);
  return tank;
}

function getVolume(db, tankId) {
  return db.prepare('SELECT * FROM v_tank_monitor WHERE tank_id = ?').get(tankId);
}

/**
 * 払出元の残量が足りるかを検査する（GAS版にはなかったガード）。
 */
function assertEnoughVolume(db, tank, quantityL) {
  const state = getVolume(db, tank.id);
  if (state && state.current_volume_l < quantityL) {
    throw new BusinessRuleError(
      `タンク残量が不足しています（${tank.name}: 残${state.current_volume_l}L < 払出${quantityL}L）`
    );
  }
}

/**
 * 受入先の容量に収まるかを検査する。
 * 最大容量が未登録のタンクは検査をスキップする。
 */
function assertCapacity(db, tank, quantityL) {
  if (tank.max_volume_l == null) return;
  const state = getVolume(db, tank.id);
  const after = (state?.current_volume_l ?? 0) + quantityL;
  if (after > tank.max_volume_l) {
    throw new BusinessRuleError(
      `受入先タンクの容量を超えます（${tank.name}: ${after}L > 最大${tank.max_volume_l}L）`
    );
  }
}

/**
 * 容器移動。タンクAからタンクBへ中身を移す。
 * 1行で from/to 両方を埋めるので、ビュー側では自動的に払出＋受入として集計される。
 */
function submitTankTransfer(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    if (input.fromTankId === input.toTankId) {
      throw new BusinessRuleError('移動元と移動先に同じタンクは指定できません');
    }

    const fromTank = getTank(db, input.fromTankId, '移動元タンク');
    const toTank = getTank(db, input.toTankId, '移動先タンク');

    assertEnoughVolume(db, fromTank, input.quantityL);
    assertCapacity(db, toTank, input.quantityL);

    // 度数の指定がなければ移動元の度数を引き継ぐ。
    // **tanks.current_abv は使わない。** あの列は割合（0.34）と％（35）が混ざっており、
    // そのまま台帳へ書くと、％で揃っている tank_ledger.abv に 0.34 が1行混ざる
    const abv = input.abv ?? tankAbv(db, fromTank.id);

    const result = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            data_kind, note)
         VALUES
           (@txnDate, @fromTankId, '容器移動', NULL, @toTankId, @quantityL, @abv,
            '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: input.fromTankId,
        toTankId: input.toTankId,
        quantityL: input.quantityL,
        abv,
        note: input.note ?? null,
      });

    // 移動先の理論度数を、移動後の加重平均で更新する
    updateBlendedAbv(db, toTank.id, input.quantityL, abv);

    return {
      tankLedgerId: result.lastInsertRowid,
      from: { ...pickTank(fromTank), after: getVolume(db, fromTank.id) },
      to: { ...pickTank(toTank), after: getVolume(db, toTank.id) },
    };
  });

  return run();
}

/**
 * 未納税移出。社外（他の酒造場等）へ未納税のまま搬出する。
 * 受入先タンクは自社内にないので to_tank_id は NULL とし、搬出先は note に残す。
 */
function submitTaxFreeTransfer(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();
    const fromTank = getTank(db, input.fromTankId, '払出元タンク');

    assertEnoughVolume(db, fromTank, input.quantityL);

    const noteParts = [`搬出先: ${input.destination}`];
    if (input.note) noteParts.push(input.note);

    const result = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            data_kind, note)
         VALUES
           (@txnDate, @fromTankId, '未納税移出', NULL, NULL, @quantityL, @abv,
            '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: input.fromTankId,
        quantityL: input.quantityL,
        abv: input.abv ?? tankAbv(db, fromTank.id),
        note: noteParts.join(' / '),
      });

    return {
      tankLedgerId: result.lastInsertRowid,
      from: { ...pickTank(fromTank), after: getVolume(db, fromTank.id) },
      destination: input.destination,
    };
  });

  return run();
}

/**
 * タンクごとの度数を、浄酎容器変動履歴から計算する。
 *
 * **tanks.current_abv は使わない。** あの列は旧シートの「理論アルコール度数」を
 * そのまま取り込んだもので、単位が混ざっている（実データで
 * ステンレスタンク1=0.34・2=0.35 は割合、出荷用ポリタンク3=35 は％）。
 * 一律に100倍すると出荷用ポリタンク3が 3500% になる。
 * 一方 tank_ledger.abv は全件％（30.22〜39.8）で揃っているので、そちらから出す。
 *
 * 数え方は **v_tank_monitor の CASE と揃える**。受け側（to_tank_id）を先に見て加算し、
 * 払出（from_tank_id）は受け側と同じタンクでないときだけ減算する。
 * 実データに from_tank_id = to_tank_id の行が1件あり、ビューはそれを加算としてだけ
 * 数えている。ここがずれると、液量が画面の表示と食い違う。
 *
 * @returns {Map<number, {volume: number, abv: number|null}>}
 */
function computeTankState(db) {
  const state = new Map(
    db
      .prepare('SELECT id, initial_volume_l FROM tanks')
      .all()
      .map((t) => [t.id, { volume: t.initial_volume_l ?? 0, abv: null }])
  );

  const rows = db
    .prepare(
      `SELECT txn_type, from_tank_id, to_tank_id, quantity_l, abv
         FROM tank_ledger
        WHERE is_cancelled = 0
        ORDER BY txn_date, id`
    )
    .all();

  for (const row of rows) {
    const source = row.from_tank_id != null ? state.get(row.from_tank_id) : null;
    // 度数を持たない容器移動は、出す側のその時点の度数を引き継ぐ（実データで12件中11件）
    const incomingAbv = row.abv ?? (source ? source.abv : null);
    // 棚卸はタンク全体を測った値なので、混ぜずに置き換える。
    // 度数が分からないタンクを直す手段は、いまのところこれだけ
    const measured = MEASURED_TXN_TYPES.has(row.txn_type) && row.abv != null;

    const target = row.to_tank_id != null ? state.get(row.to_tank_id) : null;
    if (target) {
      if (measured) {
        target.abv = row.abv;
      } else if (incomingAbv != null && row.quantity_l > 0) {
        const after = target.volume + row.quantity_l;
        target.abv =
          target.volume <= 0 || target.abv == null
            ? incomingAbv
            : (target.volume * target.abv + row.quantity_l * incomingAbv) / after;
      }
      target.volume += row.quantity_l;
    }

    if (row.from_tank_id != null && row.from_tank_id !== row.to_tank_id && source) {
      // 払出は度数を変えない（薄まりも濃くもならない）。棚卸だけは測定値で置き換える
      if (measured) source.abv = row.abv;
      source.volume -= row.quantity_l;
    }
  }

  return state;
}

/**
 * タンクID → 度数(％)。分からなければ null。
 * 液量も一緒に要るときは computeTankState を使う。
 */
function computeTankAbv(db) {
  return new Map(
    [...computeTankState(db)].map(([id, s]) => [
      id,
      s.abv == null ? null : Math.round(s.abv * 100) / 100,
    ])
  );
}

/** 1本ぶんの度数。台帳から計算した値を返す（分からなければ null） */
function tankAbv(db, tankId) {
  return computeTankAbv(db).get(tankId) ?? null;
}

/**
 * 受入によって変化したタンクの理論アルコール度数を加重平均で更新する。
 * 現行システムの「加重平均で自動計算される度数」（4-13 G列）に相当する。
 *
 * 受入前の液量・度数と、受け入れた液量・度数から算出する。
 * どちらかの度数が不明な場合は更新せず、既存値をそのまま残す。
 */
function updateBlendedAbv(db, tankId, addedVolumeL, addedAbv) {
  if (addedAbv == null) return;

  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(tankId);
  const after = getVolume(db, tankId)?.current_volume_l ?? 0;
  const before = after - addedVolumeL;

  // 受入前が空、または元の度数が不明なら、受け入れた液の度数がそのままタンクの度数になる
  if (before <= 0 || tank.current_abv == null) {
    db.prepare('UPDATE tanks SET current_abv = ? WHERE id = ?').run(addedAbv, tankId);
    return;
  }

  const blended = (before * tank.current_abv + addedVolumeL * addedAbv) / after;
  db.prepare('UPDATE tanks SET current_abv = ? WHERE id = ?').run(
    Math.round(blended * 100) / 100,
    tankId
  );
}

function pickTank(tank) {
  return { id: tank.id, code: tank.code, name: tank.name };
}

/**
 * 並べ替えに使ってよい列。画面から来た文字列をそのままSQLに入れない
 * （materialService.LEDGER_SORTABLE と同じ作法）。
 */
const TANK_LEDGER_SORTABLE = {
  txn_date: 'l.txn_date',
  txn_type: 'l.txn_type',
  from_tank_name: 'ft.name',
  to_tank_name: 'tt.name',
  quantity_l: 'l.quantity_l',
  abv: 'l.abv',
  is_cancelled: 'l.is_cancelled',
};
const TANK_LEDGER_DEFAULT_SORT = 'txn_date';

const TANK_LEDGER_JOINS = `
       FROM tank_ledger l
       LEFT JOIN tanks ft ON ft.id = l.from_tank_id
       LEFT JOIN tanks tt ON tt.id = l.to_tank_id
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN distillations d ON d.id = l.distillation_id`;

/**
 * タンクの入出庫履歴（浄酎容器変動履歴）。
 *
 * **タンクの条件は必ず括弧でくくる。**
 * 以前は `WHERE l.from_tank_id = @tankId OR l.to_tank_id = @tankId` と
 * 裸で書いてあった。条件がこれ1つだけのうちは正しく動くが、AND を足した途端に
 * `A AND B OR C` と読まれて（SQLでは AND が OR より強い）、
 * **タンクで絞ったつもりが他のタンクの行まで混ざる**。
 *
 * @returns {{rows: object[], total: number}} total は同じ絞り込みでの全件数
 */
function listLedger({
  tankId,
  limit = 200,
  offset = 0,
  sort = TANK_LEDGER_DEFAULT_SORT,
  order = 'desc',
  txnType = null,
  cancelled = null,
  from = null,
  to = null,
} = {}) {
  const db = getConnection();

  const where = [];
  const params = {};

  if (tankId) {
    // 括弧を外さないこと（上のコメント参照）
    where.push('(l.from_tank_id = @tankId OR l.to_tank_id = @tankId)');
    params.tankId = tankId;
  }
  if (txnType) {
    where.push('l.txn_type = @txnType');
    params.txnType = txnType;
  }
  if (cancelled !== null) {
    where.push('l.is_cancelled = @cancelled');
    params.cancelled = cancelled ? 1 : 0;
  }
  if (from) {
    where.push('l.txn_date >= @from');
    params.from = from;
  }
  if (to) {
    where.push('l.txn_date <= @to');
    params.to = to;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const column = TANK_LEDGER_SORTABLE[sort] ?? TANK_LEDGER_SORTABLE[TANK_LEDGER_DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 同じ日付の行が実行のたびに入れ替わらないよう、idを第2キーにする
  const orderSql = `${column} ${direction}, l.id ${direction}`;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total ${TANK_LEDGER_JOINS} ${whereSql}`)
    .get(params);

  const rows = db
    .prepare(
      `SELECT l.*, ft.name AS from_tank_name, tt.name AS to_tank_name,
              p.name AS product_name, d.distillation_code
       ${TANK_LEDGER_JOINS}
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return { rows, total };
}

/**
 * 絞り込みのプルダウンに出す値。**実データにあるものだけ**を返す。
 *
 * 受払区分はスキーマの CHECK に7種あるが、`取消戻し` のように実データが
 * 1件も無いものを並べても選べるだけ無駄になる
 * （operationLogService.listFilterOptions と同じ考え方）。
 */
function listLedgerFilterOptions() {
  const db = getConnection();
  return {
    txnTypes: db
      .prepare('SELECT DISTINCT txn_type FROM tank_ledger WHERE txn_type IS NOT NULL ORDER BY txn_type')
      .all()
      .map((r) => r.txn_type),
  };
}

/**
 * タンクの新規登録（旧 registerTank）。
 * 容器IDのプレフィックスは種別を表す（T=ステンレスタンク、B=木樽、SP=原酒ポリタンク、
 * U=残渣タンク、G=一斗瓶、JP=出荷用ポリタンク、Q=QBテナー、DISTL=蒸留機）。
 */
/** 中身の種類の値を確かめる（ALTER TABLE では CHECK を足せないのでここで止める） */
function assertContentsKind(contentsKind) {
  if (!TANK_KINDS.includes(contentsKind)) {
    throw new BusinessRuleError(
      `中身の種類は ${TANK_KINDS.join('・')} のいずれかです: ${contentsKind}`
    );
  }
}

/** この容器に入出庫の記録があるか（取消済みも数える。記録があった事実は消えない） */
function hasLedgerRows(db, tankId) {
  const row = db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM tank_ledger
                  WHERE from_tank_id = @id OR to_tank_id = @id) AS jochu,
         EXISTS (SELECT 1 FROM raw_sake_ledger
                  WHERE from_tank_id = @id OR to_tank_id = @id) AS genshu`
    )
    .get({ id: tankId });
  return Boolean(row.jochu || row.genshu);
}

function registerTank(input, actor = null) {
  const db = getConnection();

  const code = (input.code ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!code) throw new BusinessRuleError('容器IDを入力してください');
  if (!name) throw new BusinessRuleError('容器名称を入力してください');

  if (db.prepare('SELECT id FROM tanks WHERE code = ?').get(code)) {
    throw new BusinessRuleError(`容器ID「${code}」は既に使われています`);
  }
  if (db.prepare('SELECT id FROM tanks WHERE name = ?').get(name)) {
    throw new BusinessRuleError(`容器名称「${name}」は既に使われています`);
  }

  const initialVolumeL = input.initialVolumeL ?? 0;
  if (input.maxVolumeL != null && initialVolumeL > input.maxVolumeL) {
    throw new BusinessRuleError('初期在庫量が最大容量を超えています');
  }

  // 中身の種類。未指定なら容器IDの接頭辞から決める（CSV取込など既存の呼び出しを壊さず、
  // 列が NULL のまま増えないようにする）
  const contentsKind = input.contentsKind ?? tankKind(code);
  assertContentsKind(contentsKind);

  const result = db
    .prepare(
      `INSERT INTO tanks
         (uid, code, name, container_type, contents_kind, max_volume_l, location, status,
          gauge_constant, initial_volume_l, current_volume_l, current_abv, note)
       VALUES
         (@uid, @code, @name, @containerType, @contentsKind, @maxVolumeL, @location, @status,
          @gaugeConstant, @initialVolumeL, @initialVolumeL, @currentAbv, @note)`
    )
    .run({
      uid: generateUid(db, 'tanks'),
      code,
      name,
      containerType: input.containerType ?? null,
      contentsKind,
      maxVolumeL: input.maxVolumeL ?? null,
      location: input.location ?? null,
      status: input.status ?? '稼働中',
      gaugeConstant: input.gaugeConstant ?? null,
      initialVolumeL,
      currentAbv: input.currentAbv ?? null,
      note: input.note ?? null,
    });

  operationLogService.record({
    user: actor,
    action: 'tank.create',
    targetType: 'tanks',
    targetId: result.lastInsertRowid,
    summary: `タンク「${code} ${name}」を登録`,
  });

  return db.prepare('SELECT * FROM tanks WHERE id = ?').get(result.lastInsertRowid);
}

function updateTank(id, input, actor = null) {
  const db = getConnection();
  const before = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
  if (!before) return null;

  // 中身の種類は、台帳に1行でも記録があれば変えられない。
  // 変えると今入っている残量が浄酎モニターと原酒在庫の間を飛び移り、
  // 過去の棚卸・集計と合わなくなる（登録直後の打ち間違いは直せる）。
  const contentsKindGiven = input.contentsKind != null;
  if (contentsKindGiven) {
    assertContentsKind(input.contentsKind);
    if (input.contentsKind !== tankContentsKind(before) && hasLedgerRows(db, id)) {
      throw new BusinessRuleError(
        `${before.code} ${before.name} は入出庫の記録があるため、中身の種類を変えられません。` +
          '新しい容器として登録してください'
      );
    }
  }

  db.prepare(
    `UPDATE tanks SET
       name = COALESCE(@name, name),
       container_type = COALESCE(@containerType, container_type),
       contents_kind = CASE WHEN @contentsKindGiven = 1 THEN @contentsKind ELSE contents_kind END,
       max_volume_l = COALESCE(@maxVolumeL, max_volume_l),
       location = COALESCE(@location, location),
       status = COALESCE(@status, status),
       gauge_constant = COALESCE(@gaugeConstant, gauge_constant),
       note = COALESCE(@note, note)
     WHERE id = @id`
  ).run({
    id,
    name: input.name ?? null,
    containerType: input.containerType ?? null,
    contentsKind: input.contentsKind ?? null,
    contentsKindGiven: contentsKindGiven ? 1 : 0,
    maxVolumeL: input.maxVolumeL ?? null,
    location: input.location ?? null,
    status: input.status ?? null,
    gaugeConstant: input.gaugeConstant ?? null,
    note: input.note ?? null,
  });

  operationLogService.record({
    user: actor,
    action: 'tank.update',
    targetType: 'tanks',
    targetId: id,
    summary: `タンク（id=${id}）を編集`,
  });

  return db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
}


// --- 容器IDの自動採番と廃棄 -------------------------------------------------

// 容器種別ごとのプレフィックス（DATA_STRUCTURE.md タンクマスタ、
// GAS版 README 3章「種別選択でプレフィックス自動切替」）。
// perReceipt: 原酒の入荷ごとに増える容器。ポリタンクのように使い回す設備ではなく、
// 中身を使い切ったら返す器なので、連番だけでは「いつ入ってきたどの器か」が残らない。
// この印がある種別は容器IDに入荷年月を入れて採番する（Q-2610-01）。
const TANK_PREFIXES = {
  ステンレスタンク: { prefix: 'T' },
  木樽: { prefix: 'B' },
  原酒ポリタンク: { prefix: 'SP' },
  残渣タンク: { prefix: 'U' },
  一斗瓶: { prefix: 'G' },
  出荷用ポリタンク: { prefix: 'JP' },
  QBテナー: { prefix: 'Q', perReceipt: true },
  蒸留機: { prefix: 'DISTL' },
};

/** 原酒タンクの容器IDプレフィックス（移行データの既定値を決めるのに使う） */
const RAW_SAKE_TANK_PREFIX = TANK_PREFIXES['原酒ポリタンク'].prefix;

/** 残渣タンクの容器IDプレフィックス */
const RESIDUE_TANK_PREFIX = TANK_PREFIXES['残渣タンク'].prefix;

/** 中身で分けた容器の種類。画面の見出しにもこの文字をそのまま使う */
const TANK_KINDS = ['浄酎', '原酒', '残渣'];

/** 中身の種類ごとの既定プレフィックス（容器種別が採番表に無いときの頼り先） */
const PREFIX_BY_KIND = {
  原酒: RAW_SAKE_TANK_PREFIX,
  残渣: RESIDUE_TANK_PREFIX,
  浄酎: TANK_PREFIXES['ステンレスタンク'].prefix,
};

/**
 * 容器IDの接頭辞から中身を推測する。**これは移行用の代用**。
 *
 * 容器種別（container_type）では判定できなかった。旧シートから移行した実データの
 * 種別は「PE」「QBテナー」など**材質や通称**で入っており、「原酒」を含む行は
 * 1件も無い。原酒ポリ（SP）も出荷用ポリ（JP）も container_type が同じ 'PE' で、
 * 一斗瓶10本は容器IDが G- ではなく T- で採番されている。
 * そのため当時は容器IDの接頭辞（DATA_STRUCTURE.md タンクマスタの採番規則）で代用した。
 *
 * **いまの正は tanks.contents_kind**（0028）。この関数は列が未設定のときの
 * 落ち先としてだけ残す。接頭辞に縛られていたせいで、原酒を入れる別種の容器
 * （QBテナー・樽など）を登録しても原酒入荷・蒸留の画面に出てこなかった。
 */
function tankKind(code) {
  if (isRawSakeTankCode(code)) return '原酒';
  if (typeof code === 'string' && code.startsWith(`${RESIDUE_TANK_PREFIX}-`)) return '残渣';
  return '浄酎';
}

/** @deprecated 接頭辞による代用。中身は tankContentsKind / isRawSakeTank で見る */
function isRawSakeTankCode(code) {
  return typeof code === 'string' && code.startsWith(`${RAW_SAKE_TANK_PREFIX}-`);
}

/**
 * 容器の中身の種類。**tanks.contents_kind を正とし、未設定のときだけ接頭辞に落ちる。**
 *
 * 原酒と残渣は tank_ledger に1行も持たない。原酒の残量は raw_sake_ledger
 * （v_raw_sake_tank_volume）から出るので、浄酎のモニターに混ぜると必ず 0L で並ぶ。
 */
function tankContentsKind(tank) {
  const kind = tank?.contents_kind;
  if (TANK_KINDS.includes(kind)) return kind;
  return tankKind(tank?.code);
}

/** 原酒を入れる容器か。容器種別・容器IDは問わない */
function isRawSakeTank(tank) {
  return tankContentsKind(tank) === '原酒';
}

/**
 * 中身の種類を SQL で出す式。**tankContentsKind と同じ規則を1か所で持つため**に用意する。
 *
 * 列が NULL の行があるので、JS と同じく容器IDの接頭辞に落ちる必要がある。
 * 移行ローダー（scripts/loaders/tanks.js・knownTanks.js）は contents_kind を入れずに
 * タンクを作るので、列だけで絞ると業務データを入れ直した直後に
 * **すべての容器が原酒入荷・蒸留・残渣回収の画面から消える**。
 *
 * @param {string} alias tanks のテーブル別名
 */
function contentsKindSql(alias = 't') {
  return (
    `COALESCE(${alias}.contents_kind, CASE` +
    ` WHEN ${alias}.code LIKE '${RAW_SAKE_TANK_PREFIX}-%' THEN '原酒'` +
    ` WHEN ${alias}.code LIKE '${RESIDUE_TANK_PREFIX}-%' THEN '残渣'` +
    " ELSE '浄酎' END)"
  );
}

function listTankPrefixes() {
  return Object.entries(TANK_PREFIXES).map(([containerType, { prefix, perReceipt }]) => ({
    containerType,
    prefix,
    perReceipt: Boolean(perReceipt),
  }));
}

/**
 * 次の容器IDを作る。
 *
 * - 採番表にある容器種別 … 既存コードの書き方（区切り文字と桁数）に合わせるので、
 *   移行した過去データが T-01 でも T01 でも、その並びを引き継げる
 * - 入荷年月（receivedYm）付き … `Q-2610-01`。その年月の中で連番を振る。
 *   旧形式（`^Q[-_]?\d+$`）には当たらないので過去データと衝突しない
 * - 採番表に無い容器種別 … 中身の種類から接頭辞を決める（原酒→SP／残渣→U／浄酎→T）。
 *   以前はここで例外を投げていたため、新しい種別の容器は容器IDを自分で考えるしかなかった
 */
function nextTankCode({ containerType, contentsKind, receivedYm } = {}) {
  const db = getConnection();
  const known = TANK_PREFIXES[containerType];
  const prefix = known ? known.prefix : PREFIX_BY_KIND[contentsKind];
  if (!prefix) {
    throw new BusinessRuleError(
      `容器種別が未対応です: ${containerType}（${Object.keys(TANK_PREFIXES).join('・')}）。` +
        `中身の種類（${TANK_KINDS.join('・')}）を選べば採番できます`
    );
  }

  const codes = db.prepare('SELECT code FROM tanks').all();

  if (receivedYm) {
    const yymm = toTankYymm(receivedYm);
    // 同じ接頭辞・同じ入荷年月のものだけを見て連番を振る
    const pattern = new RegExp(`^${prefix}-${yymm}-(\\d+)$`);
    let max = 0;
    let width = 2;
    for (const row of codes) {
      const matched = pattern.exec(row.code ?? '');
      if (!matched) continue;
      const value = Number.parseInt(matched[1], 10);
      if (value > max) {
        max = value;
        width = matched[1].length;
      }
    }
    const next = String(max + 1).padStart(width, '0');
    return { code: `${prefix}-${yymm}-${next}`, prefix, containerType, receivedYm };
  }

  // 同じプレフィックスで「区切り＋数字」で終わるコードだけを見る。
  // 例: T-01 / T01。SPとSは別物なので、数字の直前までを厳密に一致させる。
  // 年月入り（Q-2610-01）は数字の後ろに -01 が続くのでここには当たらない。
  const pattern = new RegExp(`^${prefix}([-_]?)(\\d+)$`);
  let separator = '-';
  let width = 3; // 既存データが無いときはGAS版と同じ T-001 形式にする
  let max = 0;

  for (const row of codes) {
    const matched = pattern.exec(row.code ?? '');
    if (!matched) continue;
    const [, sep, digits] = matched;
    const value = Number.parseInt(digits, 10);
    if (value > max) {
      max = value;
      separator = sep;
      width = digits.length;
    }
  }

  const next = String(max + 1).padStart(width, '0');
  return { code: `${prefix}${separator}${next}`, prefix, containerType };
}

/** 入荷年月（2026-10 / 2026-10-08）を容器IDに入れる YYMM にする */
function toTankYymm(receivedYm) {
  const matched = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(receivedYm).trim());
  if (!matched) {
    throw new BusinessRuleError(`入荷年月は YYYY-MM で入れてください: ${receivedYm}`);
  }
  const [, year, month] = matched;
  if (Number(month) < 1 || Number(month) > 12) {
    throw new BusinessRuleError(`入荷年月の月が範囲外です: ${receivedYm}`);
  }
  return `${year.slice(2)}${month}`;
}

/**
 * 廃棄。行は消さずに廃棄日を入れる。
 * 過去の入出庫履歴がこのタンクを参照しているので、削除すると履歴が読めなくなる。
 */
function discardTank(id, { discardedOn, reason } = {}, actor = null) {
  const db = getConnection();
  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
  if (!tank) throw new NotFoundError(`タンクが見つかりません (id=${id})`);
  if (tank.discarded_on) throw new ConflictError(`${tank.name} は既に廃棄済みです（${tank.discarded_on}）`);

  // 残量は中身の種類によって見るビューが違う。原酒は tank_ledger に1行も持たないので
  // v_tank_monitor では必ず 0L に見え、中身が残っていても廃棄できてしまっていた
  // （廃棄した容器は原酒在庫・投入元から外れるので、残っていた原酒が消えて見える）。
  const volume =
    tankContentsKind(tank) === '原酒'
      ? db.prepare('SELECT * FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(id)
      : getVolume(db, id);
  if (volume && volume.current_volume_l > 0) {
    throw new BusinessRuleError(
      `${tank.name} には残量が ${volume.current_volume_l}L あります。空にしてから廃棄してください`
    );
  }

  db.prepare(
    `UPDATE tanks SET discarded_on = @discardedOn, discard_reason = @reason, status = '廃棄'
     WHERE id = @id`
  ).run({ id, discardedOn: discardedOn ?? today(), reason: reason ?? null });

  operationLogService.record({
    user: actor,
    action: 'tank.discard',
    targetType: 'tanks',
    targetId: id,
    summary: `タンク ${tank.code} ${tank.name} を廃棄（理由: ${reason ?? '未記入'}）`,
  });

  return db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
}

/** 廃棄していないタンクだけを返す（選択肢に使う） */
function listTanks({ includeDiscarded = false } = {}) {
  const db = getConnection();
  const where = includeDiscarded ? '' : 'WHERE discarded_on IS NULL';
  return db.prepare(`SELECT * FROM tanks ${where} ORDER BY code`).all();
}

module.exports = {
  computeTankState,
  computeTankAbv,
  tankAbv,
  RAW_SAKE_TANK_PREFIX,
  RESIDUE_TANK_PREFIX,
  TANK_KINDS,
  isRawSakeTankCode,
  tankKind,
  tankContentsKind,
  isRawSakeTank,
  contentsKindSql,
  submitTankTransfer,
  submitTaxFreeTransfer,
  listLedger,
  listLedgerFilterOptions,
  registerTank,
  updateTank,
  listTanks,
  listTankPrefixes,
  nextTankCode,
  discardTank,
  TANK_PREFIXES,
};
