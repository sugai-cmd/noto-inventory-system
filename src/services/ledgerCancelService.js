// 記録の取り消し（GAS版 README 3章「記録の取り消し」）。
//
// 瓶詰め・箱詰め・出荷を、理由をつけて取り消す。
// 在庫の現在値はすべて台帳から再計算される（v_product_stock / v_material_stock /
// v_tank_monitor はいずれも is_cancelled の行を 0 として集計する）ため、
// 取消フラグを立てるだけで、商品・仕掛品・資材・タンク残量が同時に戻る。
// 数値を直接書き戻さないので、二重に戻す事故が起きない。

const { getConnection } = require('../db/connection');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

const CANCELLABLE = ['瓶詰', '箱詰', '出荷', '返品'];

/** 取消できる直近の記録を返す（GAS版は直近30件） */
function listCancellable({ limit = 30 } = {}) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT l.id, l.history_code, l.txn_date, l.txn_type, l.quantity, l.counterparty,
              l.is_cancelled, l.cancel_reason, l.cancelled_at,
              p.name AS product_name,
              o.order_no,
              (SELECT COUNT(*) FROM material_stock_ledger m
                WHERE m.product_ledger_id = l.id AND m.is_cancelled = 0) AS material_rows,
              (SELECT COUNT(*) FROM tank_ledger t
                WHERE t.product_ledger_id = l.id AND t.is_cancelled = 0) AS tank_rows
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN orders o ON o.id = l.order_id
       WHERE l.txn_type IN ('瓶詰', '箱詰', '出荷', '返品')
       ORDER BY l.txn_date DESC, l.id DESC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * 商品在庫変動履歴の1行を取り消し、紐付く資材消費・タンク移動もまとめて取り消す。
 */
function cancelProductLedger(ledgerId, { reason } = {}, actor = null) {
  const db = getConnection();
  if (!reason || !String(reason).trim()) {
    throw new BusinessRuleError('取消理由は必須です');
  }

  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM product_stock_ledger WHERE id = ?').get(ledgerId);
    if (!row) throw new NotFoundError(`商品在庫変動履歴が見つかりません (id=${ledgerId})`);
    if (row.is_cancelled) throw new ConflictError(`${row.history_code} は既に取消済みです`);
    if (!CANCELLABLE.includes(row.txn_type)) {
      throw new BusinessRuleError(
        `${row.txn_type} は取消の対象外です（対象: ${CANCELLABLE.join('・')}）`
      );
    }

    // 瓶詰めロットが既に箱詰めで引き当てられていたら、先に箱詰めを取り消してもらう。
    // 先に瓶詰めを消すと、箱詰め済みの本数の出どころが無くなるため。
    if (row.txn_type === '瓶詰') {
      const used = db
        .prepare(
          `SELECT COUNT(*) AS n FROM wip_lot_allocations a
           JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
           WHERE a.bottling_ledger_id = ? AND b.is_cancelled = 0`
        )
        .get(ledgerId);
      if (used.n > 0) {
        throw new ConflictError(
          `${row.history_code} は箱詰めで使われています。先にその箱詰めを取り消してください`
        );
      }
    }

    const stamp = {
      reason: String(reason).trim(),
      by: actor?.id ?? null,
    };

    db.prepare(
      `UPDATE product_stock_ledger
         SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
             cancelled_by = @by, updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...stamp, id: ledgerId });

    // 資材消費とタンク移動は product_ledger_id で紐付いている
    const materials = db
      .prepare(
        `UPDATE material_stock_ledger
           SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
               cancelled_by = @by, updated_at = datetime('now')
         WHERE product_ledger_id = @id AND is_cancelled = 0`
      )
      .run({ ...stamp, id: ledgerId });

    const tanks = db
      .prepare(
        `UPDATE tank_ledger
           SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
               cancelled_by = @by
         WHERE product_ledger_id = @id AND is_cancelled = 0`
      )
      .run({ ...stamp, id: ledgerId });

    // 出荷の取消なら、受注を未着手に戻す（再出荷できるようにする）
    let revertedOrder = null;
    if (row.txn_type === '出荷' && row.order_id) {
      db.prepare(
        `UPDATE orders SET status = '未着手', delivered_on = NULL, updated_at = datetime('now')
         WHERE id = ?`
      ).run(row.order_id);
      revertedOrder = db.prepare('SELECT order_no FROM orders WHERE id = ?').get(row.order_id);
    }

    operationLogService.record({
      user: actor,
      action: 'ledger.cancel',
      targetType: 'product_stock_ledger',
      targetId: ledgerId,
      summary:
        `${row.history_code}（${row.txn_type} ${row.quantity}）を取消` +
        `／資材${materials.changes}件・タンク${tanks.changes}件を復元` +
        (revertedOrder ? `／受注 ${revertedOrder.order_no} を未着手に戻した` : '') +
        `／理由: ${stamp.reason}`,
    });

    return {
      cancelled: db.prepare('SELECT * FROM product_stock_ledger WHERE id = ?').get(ledgerId),
      restoredMaterialRows: materials.changes,
      restoredTankRows: tanks.changes,
      revertedOrderNo: revertedOrder?.order_no ?? null,
      stock: db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(row.product_id),
    };
  });

  return run();
}

module.exports = { listCancellable, cancelProductLedger, CANCELLABLE };
