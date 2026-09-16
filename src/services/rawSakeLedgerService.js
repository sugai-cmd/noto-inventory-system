// 原料受払記録（raw_sake_ledger）の一覧・取り消し・編集。
//
// この台帳は画面から一切見えず、直す手段も無かった（一覧のAPIはあったが、
// どの画面からも呼ばれていなかった）。#44 で原酒タンクの棚卸を作ったので、
// 入った行を見て、間違えたら直せる必要がある。
//
// 瓶詰め・箱詰め（#35）と資材（#42）と同じ形にする:
//   取り消しは is_cancelled を立てるだけで、数量は書き戻さない
//   （v_raw_sake_tank_volume が取消済みを0として数えるので残量は自動で戻る。
//    二重に戻す事故が起きない）。
//   編集は台帳の行そのものを書き換える。**原酒受払IDは変えない**
//   （番号はロットの名前で外から参照されている。月をまたぐ日付に直しても R2607- のまま）。
//
// distillationService に置かなかったのは、あちらが既に1300行を超えているため。
// 引き当て（rawSakeLotService）と対になるので、原酒の台帳まわりで揃えている。

const { getConnection } = require('../db/connection');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');
const { round6, assertNotWorseNegative } = require('../utils/stockGuard');
const operationLogService = require('./operationLogService');

/** 棚卸が入れた行。数量を直すと備考の「理論→実測」と食い違うので、直した跡を残す */
const STOCKTAKING_TXN_TYPES = ['棚卸調整', '欠減'];

/** 受入のときだけ直せる項目（棚卸の行に銘柄や受入元は無い） */
const RECEIPT_ONLY_FIELDS = ['raw_sake_brand_id', 'spec_note', 'source_ref'];

const SELECT_COLUMNS = `
  l.*, ft.name AS from_tank_name, ft.code AS from_tank_code,
  tt.name AS to_tank_name, tt.code AS to_tank_code,
  b.name AS brand_name, d.distillation_code`;

const FROM_JOINS = `
    FROM raw_sake_ledger l
    LEFT JOIN tanks ft            ON ft.id = l.from_tank_id
    LEFT JOIN tanks tt            ON tt.id = l.to_tank_id
    LEFT JOIN raw_sake_brands b   ON b.id  = l.raw_sake_brand_id
    LEFT JOIN distillations d     ON d.id  = l.distillation_id`;

const SELECT_ROW = `SELECT ${SELECT_COLUMNS} ${FROM_JOINS}`;

/**
 * 一覧にだけ付ける引き当ての欄（引当元／引当先）。
 *
 * 受入の行は「この受入のうち何Lがどの蒸留に出たか」、
 * 払出の行は「どの受入ロットから何Lを引いたか」を見たい。向きが逆なので2列いる。
 * 1件を読む getRecord はここを使わず、rawSakeLotService の関数で数える。
 */
const LIST_ALLOCATION_COLUMNS = `
  COALESCE((
    SELECT SUM(a.quantity) FROM raw_sake_lot_allocations a
    JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
    WHERE a.receipt_ledger_id = l.id AND p.is_cancelled = 0
  ), 0) AS allocated_out,
  COALESCE((
    SELECT SUM(a.quantity) FROM raw_sake_lot_allocations a
    WHERE a.payout_ledger_id = l.id
  ), 0) AS allocated_in,
  -- 蒸留明細の状態。明細を差し替え・取消しても**払出の行はそのまま残る**
  -- （打ち消しの「戻し受入」を別に足す作り）ので、この列を見ないと
  -- 一覧だけが「有効」と言い続ける。投入明細の画面と食い違っていた原因。
  (SELECT d.is_cancelled FROM distillation_details d
    WHERE d.raw_sake_ledger_id = l.id) AS detail_cancelled,
  (SELECT d.detail_code FROM distillation_details d
    WHERE d.raw_sake_ledger_id = l.id) AS detail_code,
  (SELECT d.note FROM distillation_details d
    WHERE d.raw_sake_ledger_id = l.id) AS detail_note,
  (
    SELECT GROUP_CONCAT(x.label, '・') FROM (
      SELECT COALESCE(pd.distillation_code, p.lot_code) AS label
        FROM raw_sake_lot_allocations a
        JOIN raw_sake_ledger p            ON p.id  = a.payout_ledger_id
        LEFT JOIN distillations pd        ON pd.id = p.distillation_id
       WHERE a.receipt_ledger_id = l.id AND p.is_cancelled = 0
       ORDER BY p.txn_date, p.id
    ) x
  ) AS allocated_to_labels,
  (
    SELECT GROUP_CONCAT(y.label, '・') FROM (
      SELECT r.lot_code AS label
        FROM raw_sake_lot_allocations a
        JOIN raw_sake_ledger r ON r.id = a.receipt_ledger_id
       WHERE a.payout_ledger_id = l.id
       ORDER BY r.txn_date, r.id
    ) y
  ) AS allocated_from_labels`;

/** その行が効いているタンク（受入・棚卸調整は受入先、払出・欠減は投入元） */
function tankOf(row) {
  return row.to_tank_id ?? row.from_tank_id ?? null;
}

function tankVolumeOf(db, tankId) {
  if (tankId == null) return 0;
  return (
    db.prepare('SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(tankId)
      ?.current_volume_l ?? 0
  );
}

/**
 * 一覧。取消済みも出す（状態は行に付ける）。
 *
 * 絞り込みが無ければ既存の GET / と同じ結果になる。
 */
function listLedger({ txnType = null, tankId = null, cancelled = null, limit = 200 } = {}) {
  const db = getConnection();
  const where = [];
  const params = { limit };

  if (txnType) {
    where.push('l.txn_type = @txnType');
    params.txnType = txnType;
  }
  if (tankId) {
    where.push('(l.from_tank_id = @tankId OR l.to_tank_id = @tankId)');
    params.tankId = tankId;
  }
  if (cancelled !== null) {
    where.push('l.is_cancelled = @cancelled');
    params.cancelled = cancelled ? 1 : 0;
  }

  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS}, ${LIST_ALLOCATION_COLUMNS}
        ${FROM_JOINS}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.txn_date DESC, l.id DESC
        LIMIT @limit`
    )
    .all(params);
}

/**
 * 取り消し・編集の前に通す関門。
 *
 * **蒸留が作った行をここから触らせないのが要点。**
 * 払出（蒸留への投入）はすべて distillation_id を持ち、distillation_details からも
 * 参照されている。蒸留明細を直すと払出行は取り消して入れ直されるので、
 * ここで直しても蒸留を直した瞬間に食い違う。
 * 明細取消の「戻し」受入も distillation_id を持つので、同じ条件で守れる。
 */
function loadOperableRow(db, ledgerId, { forCancel }) {
  const row = db.prepare(`${SELECT_ROW} WHERE l.id = ?`).get(ledgerId);
  if (!row) throw new NotFoundError(`原料受払記録が見つかりません (id=${ledgerId})`);

  if (row.distillation_id != null) {
    throw new BusinessRuleError(
      `${row.lot_code} は蒸留 ${row.distillation_code ?? `id=${row.distillation_id}`} の記録です。` +
        '蒸留タブでその蒸留を直してください' +
        '（こちらで直しても、あちらを直したときに食い違います）'
    );
  }

  if (row.is_cancelled) {
    throw new ConflictError(
      forCancel
        ? `${row.lot_code} は既に取消済みです`
        : `${row.lot_code} は取消済みです。直すなら、もう一度登録してください`
    );
  }

  return row;
}

/** 編集の画面に出す1件ぶんの中身 */
function getRecord(ledgerId) {
  const db = getConnection();
  const row = db.prepare(`${SELECT_ROW} WHERE l.id = ?`).get(ledgerId);
  if (!row) throw new NotFoundError(`原料受払記録が見つかりません (id=${ledgerId})`);

  const rawSakeLotService = require('./rawSakeLotService');
  return {
    row,
    currentVolumeL: tankVolumeOf(db, tankOf(row)),
    linkedTo: row.distillation_id != null ? row.distillation_code : null,
    // 受入なら、この行が蒸留にいくら引き当てられているか（減らせる下限になる）
    allocated: row.txn_type === '受入' ? rawSakeLotService.allocatedFromReceipt(db, ledgerId) : 0,
  };
}

/**
 * 1行を直す。
 *
 * 直せる項目: 日付 / 数量 / 備考、受入ならさらに 銘柄 / スペック / 受入元
 * 直せない項目: タンク・区分・原酒受払ID。別の記録になるので取り消して入れ直してもらう。
 */
function updateRecord(ledgerId, input, actor = null) {
  const db = getConnection();
  const rawSakeLotService = require('./rawSakeLotService');

  const run = db.transaction(() => {
    const row = loadOperableRow(db, ledgerId, { forCancel: false });
    const tankId = tankOf(row);
    const before = tankVolumeOf(db, tankId);

    // 棚卸の行に銘柄や受入元は無い。送られたら黙って入れずに断る
    if (row.txn_type !== '受入') {
      for (const key of ['brandId', 'specNote', 'sourceRef']) {
        if (input[key] !== undefined) {
          throw new BusinessRuleError(
            `${row.lot_code} は「${row.txn_type}」の記録です。銘柄・スペック・受入元は受入にだけ付きます`
          );
        }
      }
    }

    const next = {
      txnDate: input.txnDate ?? row.txn_date,
      quantity: input.quantity ?? row.quantity,
      note: input.note !== undefined ? input.note : row.note,
      brandId: input.brandId !== undefined ? input.brandId : row.raw_sake_brand_id,
      specNote: input.specNote !== undefined ? input.specNote : row.spec_note,
      sourceRef: input.sourceRef !== undefined ? input.sourceRef : row.source_ref,
    };

    // 引き当て済みより少なくは減らせない。
    // その液体はもう蒸留に使われていて、減らすと引当の合計が受入量を超える
    if (row.txn_type === '受入' && next.quantity < row.quantity) {
      const allocated = rawSakeLotService.allocatedFromReceipt(db, ledgerId);
      if (next.quantity < allocated) {
        throw new BusinessRuleError(
          `${row.lot_code} は ${round6(allocated)}L が蒸留に引き当てられています。` +
            `${round6(next.quantity)}L には減らせません（先にその蒸留の引き当てを直してください）`
        );
      }
    }

    // 棚卸の行の備考は「棚卸: 理論100L → 実測95L」。数量だけ直すと嘘になるので跡を残す
    let note = next.note;
    if (STOCKTAKING_TXN_TYPES.includes(row.txn_type) && next.quantity !== row.quantity) {
      note = `${note ? `${note} ` : ''}（編集: 数量 ${round6(row.quantity)} → ${round6(next.quantity)}）`;
    }

    db.prepare(
      `UPDATE raw_sake_ledger
          SET txn_date = @txnDate, quantity = @quantity, note = @note,
              raw_sake_brand_id = @brandId, spec_note = @specNote, source_ref = @sourceRef,
              updated_at = datetime('now')
        WHERE id = @id`
    ).run({ ...next, note, id: ledgerId });

    const after = tankVolumeOf(db, tankId);
    const tankName = row.to_tank_name ?? row.from_tank_name ?? 'タンク';
    assertNotWorseNegative(`${tankName}の残量`, before, after);

    // 台帳の行が書き換わるので、元の値は操作ログにしか残らない
    const changes = {};
    for (const [column, from, to] of [
      ['txn_date', row.txn_date, next.txnDate],
      ['quantity', row.quantity, next.quantity],
      ['note', row.note, note],
      ['raw_sake_brand_id', row.raw_sake_brand_id, next.brandId],
      ['spec_note', row.spec_note, next.specNote],
      ['source_ref', row.source_ref, next.sourceRef],
    ]) {
      if (from !== to) changes[column] = { from, to };
    }

    operationLogService.record({
      user: actor,
      action: 'rawSake.ledger.update',
      targetType: 'raw_sake_ledger',
      targetId: ledgerId,
      summary:
        `${row.lot_code}（${row.txn_type} ${tankName}）を編集` +
        `／${Object.keys(changes).join('・') || '変更なし'}` +
        `／残量 ${round6(before)}L → ${round6(after)}L`,
      detail: { changes, volumeBefore: before, volumeAfter: after },
    });

    return {
      ledgerId,
      lotCode: row.lot_code,
      txnType: row.txn_type,
      changes,
      row: db.prepare('SELECT * FROM raw_sake_ledger WHERE id = ?').get(ledgerId),
      volume: db.prepare('SELECT * FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(tankId),
    };
  });

  return run();
}

/** 1行を取り消す。理由は必須。行は消さずに残る */
function cancelRecord(ledgerId, { reason } = {}, actor = null) {
  const db = getConnection();
  const rawSakeLotService = require('./rawSakeLotService');

  if (!reason || !String(reason).trim()) {
    throw new BusinessRuleError('取消理由は必須です');
  }

  const run = db.transaction(() => {
    const row = loadOperableRow(db, ledgerId, { forCancel: true });

    // 引き当て済みの受入は取り消せない。その液体はもう蒸留に使われている
    if (row.txn_type === '受入') {
      const used = rawSakeLotService.listDistillationsUsing(db, ledgerId);
      if (used.length) {
        throw new ConflictError(
          `${row.lot_code} は蒸留 ${used.map((u) => u.distillation_code ?? u.lot_code).join('・')} に` +
            '引き当てられています。先にその蒸留の引き当てを直してください'
        );
      }
    }

    const tankId = tankOf(row);
    const before = tankVolumeOf(db, tankId);

    db.prepare(
      `UPDATE raw_sake_ledger
          SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
              cancelled_by = @by, updated_at = datetime('now')
        WHERE id = @id`
    ).run({ reason: String(reason).trim(), by: actor?.id ?? null, id: ledgerId });

    // 払出を取り消したら、その払出が握っていた引当も外す（受入ロットの残りが戻る）
    let releasedAllocations = 0;
    if (row.txn_type !== '受入') {
      releasedAllocations = db
        .prepare('DELETE FROM raw_sake_lot_allocations WHERE payout_ledger_id = ?')
        .run(ledgerId).changes;
    }

    const after = tankVolumeOf(db, tankId);
    const tankName = row.to_tank_name ?? row.from_tank_name ?? 'タンク';

    operationLogService.record({
      user: actor,
      action: 'rawSake.ledger.cancel',
      targetType: 'raw_sake_ledger',
      targetId: ledgerId,
      summary:
        `${row.lot_code}（${row.txn_type} ${tankName} ${round6(row.quantity)}L）を取消` +
        `／残量 ${round6(before)}L → ${round6(after)}L` +
        (releasedAllocations ? `／引当${releasedAllocations}件を解除` : '') +
        `／理由: ${String(reason).trim()}`,
      detail: {
        volumeBefore: before,
        volumeAfter: after,
        releasedAllocations,
        reason: String(reason).trim(),
      },
    });

    return {
      cancelled: db.prepare('SELECT * FROM raw_sake_ledger WHERE id = ?').get(ledgerId),
      tank: { id: tankId, name: tankName },
      releasedAllocations,
      volume: db.prepare('SELECT * FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(tankId),
    };
  });

  return run();
}

module.exports = {
  listLedger,
  getRecord,
  updateRecord,
  cancelRecord,
  STOCKTAKING_TXN_TYPES,
  RECEIPT_ONLY_FIELDS,
};
