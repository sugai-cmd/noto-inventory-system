// 蒸留まわりの業務ロジック
// （旧GASの submitRawSakeReceipt / submitDistillationStart / 蒸留完了報告処理 /
//   cancelDistillationDetailItem / getStaleDistillationAlerts 相当）。
//
// 蒸留は1操作で複数台帳に書き込む機能の代表例（DATA_STRUCTURE.md 5章）：
//   開始: 蒸留記録（ヘッダ）＋蒸留明細記録（投入内訳）＋原料受払記録（払出）
//   完了: 蒸留記録の更新＋浄酎容器変動履歴（継足＝浄酎タンクへの充填）＋残渣回収記録
// GAS版はシートごとに順次書いていたため途中失敗で不整合が残ったが、
// ここでは全てSQLiteのトランザクション内で処理する。

const { getConnection } = require('../db/connection');
const { generateCode } = require('../utils/codeGenerator');
const { nextRawSakeLotCode } = require('../utils/rawSakeCode');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

// 蒸留IDのプレフィックスは Distill の 'D'（現行シート踏襲）。
// 受注番号は同じ 'D' だと区別できないため 'O'（Order）に整理した（codeGenerator.js参照）。
const DISTILLATION_PREFIX = 'D';

const STATUS_IN_PROGRESS = '蒸留中';
const STATUS_COMPLETED = '完了';

function nextDistillationCode(db, dateOnly) {
  return generateCode(db, {
    table: 'distillations',
    column: 'distillation_code',
    prefix: DISTILLATION_PREFIX,
    dateOnly,
  });
}

/** 原酒タンクの現在残量（0002_raw_sake_tank_view.sql のビュー） */
function getRawSakeTankVolume(db, tankId) {
  return db.prepare('SELECT * FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(tankId);
}

/**
 * 原酒入荷（受入）。酒蔵から原酒タンクへ受け入れた分を原料受払記録に追加する。
 * 8-2の通り原酒マスタとの紐付けは任意（未登録なら spec_note に自由記述で残す）。
 */
function submitRawSakeReceipt(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(input.toTankId);
    if (!tank) throw new NotFoundError(`受入先タンクが見つかりません (id=${input.toTankId})`);

    if (input.rawSakeBrandId) {
      const brand = db
        .prepare('SELECT id FROM raw_sake_brands WHERE id = ?')
        .get(input.rawSakeBrandId);
      if (!brand) throw new NotFoundError(`原酒銘柄が見つかりません (id=${input.rawSakeBrandId})`);
    }

    const result = db
      .prepare(
        `INSERT INTO raw_sake_ledger
           (lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
            quantity, raw_sake_brand_id, spec_note, note)
         VALUES
           (@lotCode, @txnDate, '受入', NULL, @toRef, @toTankId, NULL,
            @quantity, @rawSakeBrandId, @specNote, @note)`
      )
      .run({
        lotCode: nextRawSakeLotCode(db, '受入', txnDate),
        txnDate,
        toRef: tank.name,
        toTankId: input.toTankId,
        quantity: input.quantity,
        rawSakeBrandId: input.rawSakeBrandId ?? null,
        specNote: input.specNote ?? null,
        note: input.supplier ? `受入元: ${input.supplier}` : (input.note ?? null),
      });

    return {
      rawSakeLedgerId: result.lastInsertRowid,
      tankVolume: getRawSakeTankVolume(db, input.toTankId),
    };
  });

  return run();
}

/**
 * 蒸留開始。複数の原酒ロット（タンク）から投入した内訳を明細として記録し、
 * 同時に原料受払記録へ払出行を作る。
 *
 * @param {object} input
 * @param {string} [input.startedOn]   - 投入開始日（YYYY-MM-DD）
 * @param {string} input.startedTime   - 投入開始時刻（HH:MM）※24時間アラートの起点
 * @param {Array<{tankId:number, volumeL:number, note?:string}>} input.items - 投入内訳
 * @param {string} [input.plannedDuration]
 */
function submitDistillationStart(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const startedOn = input.startedOn ?? today();
    const { startedTime } = input;

    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BusinessRuleError('投入する原酒を1つ以上指定してください');
    }

    // 投入元タンクの残量を先に検査する（GAS版にはなかったガード）
    const drawByTank = new Map();
    for (const item of input.items) {
      drawByTank.set(item.tankId, (drawByTank.get(item.tankId) ?? 0) + item.volumeL);
    }
    for (const [tankId, drawL] of drawByTank) {
      const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(tankId);
      if (!tank) throw new NotFoundError(`投入元タンクが見つかりません (id=${tankId})`);

      const state = getRawSakeTankVolume(db, tankId);
      if (state && state.current_volume_l < drawL) {
        throw new BusinessRuleError(
          `原酒残量が不足しています（${tank.name}: 残${state.current_volume_l}L < 投入${drawL}L）`
        );
      }
    }

    const totalInputL = input.items.reduce((sum, item) => sum + item.volumeL, 0);
    const distillationCode = nextDistillationCode(db, startedOn);

    const summaryParts = input.items.map((item) => {
      const tank = db.prepare('SELECT name FROM tanks WHERE id = ?').get(item.tankId);
      return `${tank.name} ${item.volumeL}L`;
    });

    const headerResult = db
      .prepare(
        `INSERT INTO distillations
           (distillation_code, started_on, started_time, input_summary, total_input_l,
            planned_duration, status)
         VALUES
           (@distillationCode, @startedOn, @startedTime, @inputSummary, @totalInputL,
            @plannedDuration, @status)`
      )
      .run({
        distillationCode,
        startedOn,
        startedTime,
        inputSummary: summaryParts.join(' / '),
        totalInputL,
        plannedDuration: input.plannedDuration ?? null,
        status: STATUS_IN_PROGRESS,
      });
    const distillationId = headerResult.lastInsertRowid;

    const insertLedger = db.prepare(
      `INSERT INTO raw_sake_ledger
         (lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
          quantity, spec_note, note)
       VALUES
         (@lotCode, @txnDate, '払出', @fromTankId, @toRef, NULL, @distillationId,
          @quantity, @specNote, @note)`
    );
    const insertDetail = db.prepare(
      `INSERT INTO distillation_details
         (distillation_id, raw_sake_ledger_id, input_l, source_tank_id, note)
       VALUES
         (@distillationId, @rawSakeLedgerId, @inputL, @sourceTankId, @note)`
    );

    const details = [];
    for (const item of input.items) {
      const ledgerResult = insertLedger.run({
        lotCode: nextRawSakeLotCode(db, '払出', startedOn),
        txnDate: startedOn,
        fromTankId: item.tankId,
        toRef: distillationCode,
        distillationId,
        quantity: item.volumeL,
        specNote: item.specNote ?? null,
        note: item.note ?? null,
      });

      const detailResult = insertDetail.run({
        distillationId,
        rawSakeLedgerId: ledgerResult.lastInsertRowid,
        inputL: item.volumeL,
        sourceTankId: item.tankId,
        note: item.note ?? null,
      });

      details.push({
        detailId: detailResult.lastInsertRowid,
        rawSakeLedgerId: ledgerResult.lastInsertRowid,
        tankId: item.tankId,
        volumeL: item.volumeL,
      });
    }

    return {
      distillationId,
      distillationCode,
      totalInputL,
      details,
    };
  });

  return run();
}

/**
 * 蒸留完了報告。得られた浄酎を払出先タンクへ充填（継足）し、残渣も記録する。
 */
function completeDistillation(distillationId, input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const distillation = db
      .prepare('SELECT * FROM distillations WHERE id = ?')
      .get(distillationId);
    if (!distillation) throw new NotFoundError(`蒸留記録が見つかりません (id=${distillationId})`);
    if (distillation.status === STATUS_COMPLETED) {
      throw new ConflictError(`蒸留 ${distillation.distillation_code} は既に完了しています`);
    }

    const outputTank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(input.outputTankId);
    if (!outputTank) {
      throw new NotFoundError(`払出先タンクが見つかりません (id=${input.outputTankId})`);
    }

    const completedOn = input.completedOn ?? today();

    db.prepare(
      `UPDATE distillations
       SET status = @status,
           output_l = @outputL,
           output_abv = @outputAbv,
           output_tank_id = @outputTankId,
           residue_qty = @residueQty,
           completed_on = @completedOn,
           completed_time = @completedTime
       WHERE id = @id`
    ).run({
      id: distillationId,
      status: STATUS_COMPLETED,
      outputL: input.outputL,
      outputAbv: input.outputAbv ?? null,
      outputTankId: input.outputTankId,
      residueQty: input.residue?.quantity ?? null,
      completedOn,
      completedTime: input.completedTime ?? null,
    });

    // 浄酎容器変動履歴へ「継足」を記録（蒸留IDで紐付け）
    const tankLedgerResult = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            distillation_id, data_kind, note)
         VALUES
           (@txnDate, NULL, '継足', NULL, @toTankId, @quantityL, @abv,
            @distillationId, '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate: completedOn,
        toTankId: input.outputTankId,
        quantityL: input.outputL,
        abv: input.outputAbv ?? null,
        distillationId,
        note: `蒸留 ${distillation.distillation_code} の完了による充填`,
      });

    // 残渣回収記録（任意）
    let residueId = null;
    if (input.residue) {
      const residueResult = db
        .prepare(
          `INSERT INTO distillation_residues
             (distillation_id, collected_on, collected_time, quantity, abv,
              salt_status, salt_input_qty, salt_concentration, destination)
           VALUES
             (@distillationId, @collectedOn, @collectedTime, @quantity, @abv,
              @saltStatus, @saltInputQty, @saltConcentration, @destination)`
        )
        .run({
          distillationId,
          collectedOn: input.residue.collectedOn ?? completedOn,
          collectedTime: input.residue.collectedTime,
          quantity: input.residue.quantity ?? null,
          abv: input.residue.abv ?? null,
          saltStatus: input.residue.saltStatus ?? null,
          saltInputQty: input.residue.saltInputQty ?? null,
          saltConcentration: input.residue.saltConcentration ?? null,
          destination: input.residue.destination ?? null,
        });
      residueId = residueResult.lastInsertRowid;
    }

    return {
      distillation: db.prepare('SELECT * FROM distillations WHERE id = ?').get(distillationId),
      tankLedgerId: tankLedgerResult.lastInsertRowid,
      residueId,
      outputTankVolume: db
        .prepare('SELECT * FROM v_tank_monitor WHERE tank_id = ?')
        .get(input.outputTankId),
    };
  });

  return run();
}

/**
 * 投入明細の部分取消（旧 cancelDistillationDetailItem）。
 * 明細に取消フラグを立て、原料受払記録には「受入」を1行足して原酒を戻す
 * （台帳は履歴として残す方式。DATA_STRUCTURE.md 4-9の「取消時の受入戻し」を踏襲）。
 */
function cancelDistillationDetailItem(detailId, { reason } = {}) {
  const db = getConnection();

  const run = db.transaction(() => {
    const detail = db
      .prepare(
        `SELECT d.*, ds.distillation_code, ds.status AS distillation_status
         FROM distillation_details d
         JOIN distillations ds ON ds.id = d.distillation_id
         WHERE d.id = ?`
      )
      .get(detailId);
    if (!detail) throw new NotFoundError(`蒸留明細が見つかりません (id=${detailId})`);
    if (detail.is_cancelled) {
      throw new ConflictError(`蒸留明細 (id=${detailId}) は既に取消済みです`);
    }
    if (detail.distillation_status === STATUS_COMPLETED) {
      throw new ConflictError(
        `蒸留 ${detail.distillation_code} は完了済みのため、投入明細を取り消せません`
      );
    }

    const txnDate = today();

    db.prepare(
      `UPDATE distillation_details
       SET is_cancelled = 1, note = TRIM(COALESCE(note, '') || ' 取消理由:' || @reason)
       WHERE id = @id`
    ).run({ id: detailId, reason: reason ?? '(未記入)' });

    // 原酒を元のタンクへ戻す
    const restoreResult = db
      .prepare(
        `INSERT INTO raw_sake_ledger
           (lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
            quantity, note)
         VALUES
           (@lotCode, @txnDate, '受入', NULL, @toRef, @toTankId, @distillationId,
            @quantity, @note)`
      )
      .run({
        lotCode: nextRawSakeLotCode(db, '受入', txnDate),
        txnDate,
        toRef: null,
        toTankId: detail.source_tank_id,
        distillationId: detail.distillation_id,
        quantity: detail.input_l,
        note: `蒸留 ${detail.distillation_code} の投入明細取消による戻し`,
      });

    // ヘッダの投入量合計を、取消されていない明細だけで再計算する
    const { total } = db
      .prepare(
        `SELECT COALESCE(SUM(input_l), 0) AS total
         FROM distillation_details
         WHERE distillation_id = ? AND is_cancelled = 0`
      )
      .get(detail.distillation_id);
    db.prepare('UPDATE distillations SET total_input_l = ? WHERE id = ?').run(
      total,
      detail.distillation_id
    );

    return {
      detailId,
      restoredLedgerId: restoreResult.lastInsertRowid,
      totalInputL: total,
      tankVolume: getRawSakeTankVolume(db, detail.source_tank_id),
    };
  });

  return run();
}

/**
 * 24時間以上「蒸留中」のまま完了報告されていない蒸留を返す（旧 getStaleDistillationAlerts）。
 * started_on と started_time を分離して保持している（2.0）ので、
 * ここで結合して経過時間を判定する。
 */
function getStaleDistillationAlerts({ thresholdHours = 24 } = {}) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT d.*,
              ROUND((julianday('now', 'localtime')
                     - julianday(d.started_on || ' ' || d.started_time)) * 24, 1) AS elapsed_hours
       FROM distillations d
       WHERE d.status = @status
         AND d.alert_acknowledged_on IS NULL   -- 「処理済み」にしたものは出さない
         AND julianday('now', 'localtime') - julianday(d.started_on || ' ' || d.started_time)
             > @thresholdDays
       ORDER BY d.started_on, d.started_time`
    )
    .all({ status: STATUS_IN_PROGRESS, thresholdDays: thresholdHours / 24 });
}

/** 一覧・詳細 */
function list({ status, limit = 100 } = {}) {
  const db = getConnection();
  const where = status ? 'WHERE d.status = @status' : '';
  return db
    .prepare(
      `SELECT d.*, t.name AS output_tank_name
       FROM distillations d
       LEFT JOIN tanks t ON t.id = d.output_tank_id
       ${where}
       ORDER BY d.started_on DESC, d.started_time DESC
       LIMIT @limit`
    )
    .all({ status, limit });
}

function findById(id) {
  const db = getConnection();
  const distillation = db
    .prepare(
      `SELECT d.*, t.name AS output_tank_name
       FROM distillations d
       LEFT JOIN tanks t ON t.id = d.output_tank_id
       WHERE d.id = ?`
    )
    .get(id);
  if (!distillation) return null;

  distillation.details = db
    .prepare(
      `SELECT dd.*, t.name AS source_tank_name, l.lot_code
       FROM distillation_details dd
       LEFT JOIN tanks t ON t.id = dd.source_tank_id
       LEFT JOIN raw_sake_ledger l ON l.id = dd.raw_sake_ledger_id
       WHERE dd.distillation_id = ?
       ORDER BY dd.id`
    )
    .all(id);
  distillation.residues = db
    .prepare('SELECT * FROM distillation_residues WHERE distillation_id = ? ORDER BY id')
    .all(id);

  return distillation;
}


/**
 * 未対応アラートの消込（GAS版 README 3章「未対応アラート：『処理済み』で消込」）。
 * 蒸留そのものの状態は変えず、アラート一覧から外すだけ。
 * 実態としてまだ蒸留中なのに一覧が埋まってしまう状況を、記録を残して片付けるための操作。
 */
function acknowledgeStaleAlert(distillationId, { note } = {}, actor = null) {
  const db = getConnection();
  const row = db.prepare('SELECT * FROM distillations WHERE id = ?').get(distillationId);
  if (!row) throw new NotFoundError(`蒸留記録が見つかりません (id=${distillationId})`);
  if (row.alert_acknowledged_on) {
    throw new ConflictError(`${row.distillation_code} のアラートは既に処理済みです`);
  }

  db.prepare(
    `UPDATE distillations
       SET alert_acknowledged_on = @on, alert_acknowledged_by = @by, alert_acknowledged_note = @note
     WHERE id = @id`
  ).run({ id: distillationId, on: today(), by: actor?.id ?? null, note: note ?? null });

  operationLogService.record({
    user: actor,
    action: 'distillation.acknowledgeAlert',
    targetType: 'distillations',
    targetId: distillationId,
    summary: `蒸留 ${row.distillation_code} の未対応アラートを処理済みにした（${note ?? '理由未記入'}）`,
  });

  return db.prepare('SELECT * FROM distillations WHERE id = ?').get(distillationId);
}


/**
 * 蒸留中の投入明細を後から足す（旧 addDistillationDetailItem）。
 * 誤ったタンクで登録したときに、取り消してから正しいタンクで入れ直すための操作。
 * 原料受払記録に「払出」を1行足し、明細を1行足す。開始時と同じ流れ。
 */
function addDistillationDetailItem(distillationId, { tankId, volumeL, note, specNote } = {}, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const distillation = db.prepare('SELECT * FROM distillations WHERE id = ?').get(distillationId);
    if (!distillation) throw new NotFoundError(`蒸留記録が見つかりません (id=${distillationId})`);
    if (distillation.status !== STATUS_IN_PROGRESS) {
      throw new ConflictError(`${distillation.distillation_code} は${distillation.status}なので明細を足せません`);
    }
    if (!(volumeL > 0)) throw new BusinessRuleError('投入量は0より大きい値で入力してください');

    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(tankId);
    if (!tank) throw new NotFoundError(`投入元タンクが見つかりません (id=${tankId})`);

    const state = getRawSakeTankVolume(db, tankId);
    if (state && state.current_volume_l < volumeL) {
      throw new BusinessRuleError(
        `原酒残量が不足しています（${tank.name}: 残${state.current_volume_l}L < 投入${volumeL}L）`
      );
    }

    const txnDate = distillation.started_on;
    const ledgerResult = db
      .prepare(
        `INSERT INTO raw_sake_ledger
           (lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
            quantity, spec_note, note)
         VALUES
           (@lotCode, @txnDate, '払出', @fromTankId, @toRef, NULL, @distillationId,
            @quantity, @specNote, @note)`
      )
      .run({
        lotCode: nextRawSakeLotCode(db, '払出', txnDate),
        txnDate,
        fromTankId: tankId,
        toRef: distillation.distillation_code,
        distillationId,
        quantity: volumeL,
        specNote: specNote ?? null,
        note: note ?? null,
      });

    const detailResult = db
      .prepare(
        `INSERT INTO distillation_details
           (distillation_id, raw_sake_ledger_id, input_l, source_tank_id, note)
         VALUES (@distillationId, @rawSakeLedgerId, @inputL, @sourceTankId, @note)`
      )
      .run({
        distillationId,
        rawSakeLedgerId: ledgerResult.lastInsertRowid,
        inputL: volumeL,
        sourceTankId: tankId,
        note: note ?? null,
      });

    // ヘッダの投入量合計を、取消されていない明細だけで数え直す
    db.prepare(
      `UPDATE distillations
         SET total_input_l = (SELECT COALESCE(SUM(input_l), 0) FROM distillation_details
                              WHERE distillation_id = ? AND is_cancelled = 0)
       WHERE id = ?`
    ).run(distillationId, distillationId);

    operationLogService.record({
      user: actor,
      action: 'distillation.addDetail',
      targetType: 'distillation_details',
      targetId: detailResult.lastInsertRowid,
      summary: `蒸留 ${distillation.distillation_code} に投入明細を追加（${tank.name} ${volumeL}L）`,
    });

    return {
      detailId: detailResult.lastInsertRowid,
      rawSakeLedgerId: ledgerResult.lastInsertRowid,
      tankId,
      volumeL,
      totalInputL: db.prepare('SELECT total_input_l FROM distillations WHERE id = ?')
        .get(distillationId).total_input_l,
    };
  });

  return run();
}

module.exports = {
  addDistillationDetailItem,
  acknowledgeStaleAlert,
  submitRawSakeReceipt,
  submitDistillationStart,
  completeDistillation,
  cancelDistillationDetailItem,
  getStaleDistillationAlerts,
  list,
  findById,
  DISTILLATION_PREFIX,
};
