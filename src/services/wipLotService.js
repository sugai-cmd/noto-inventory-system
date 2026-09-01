// 仕掛品ロット（瓶詰め1件＝1ロット）の残量計算と引当。
//
// GAS版の箱詰めは「仕掛品のロット一覧から選び、選んだロットで足りない分は
// 次に古いロットから自動的に補う」という挙動（README 3章 瓶詰め・箱詰め）。
// 従来のこちらの実装は仕掛品の合計しか見ておらず、どのロットを箱詰めしたかが
// 残らなかったため、ロット単位の追跡と取消の復元ができなかった。

const { getConnection } = require('../db/connection');
const { BusinessRuleError } = require('../utils/errors');

/** 瓶詰めロットの残量（瓶詰め本数 − 箱詰めで引き当てた本数）を古い順に返す */
function listLots(productId, { includeEmpty = false } = {}) {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT l.id, l.history_code, l.txn_date, l.product_id, l.quantity,
              COALESCE((
                SELECT SUM(a.quantity) FROM wip_lot_allocations a
                JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
                WHERE a.bottling_ledger_id = l.id AND b.is_cancelled = 0
              ), 0) AS allocated
       FROM product_stock_ledger l
       WHERE l.txn_type = '瓶詰' AND l.is_cancelled = 0
         AND (@productId IS NULL OR l.product_id = @productId)
       ORDER BY l.txn_date, l.id`
    )
    .all({ productId: productId ?? null });

  return rows
    .map((r) => ({ ...r, remaining: r.quantity - r.allocated }))
    .filter((r) => includeEmpty || r.remaining > 0);
}

/**
 * 箱詰め本数をロットに割り付ける。
 * 指定ロットがあればそれを最優先で使い、足りない分は古いロットから順に補う。
 *
 * @returns {{bottlingLedgerId:number, quantity:number}[]}
 */
function allocate(db, { productId, quantity, preferredLotId = null }) {
  const rows = db
    .prepare(
      `SELECT l.id, l.history_code, l.txn_date, l.quantity,
              COALESCE((
                SELECT SUM(a.quantity) FROM wip_lot_allocations a
                JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
                WHERE a.bottling_ledger_id = l.id AND b.is_cancelled = 0
              ), 0) AS allocated
       FROM product_stock_ledger l
       WHERE l.txn_type = '瓶詰' AND l.is_cancelled = 0 AND l.product_id = ?
       ORDER BY l.txn_date, l.id`
    )
    .all(productId)
    .map((r) => ({ ...r, remaining: r.quantity - r.allocated }))
    .filter((r) => r.remaining > 0);

  if (preferredLotId) {
    const index = rows.findIndex((r) => r.id === preferredLotId);
    if (index < 0) {
      throw new BusinessRuleError(
        `指定されたロットは残量がないか、この商品の瓶詰めロットではありません (id=${preferredLotId})`
      );
    }
    // 指定ロットを先頭に持ってくる。残りは古い順のまま。
    const [preferred] = rows.splice(index, 1);
    rows.unshift(preferred);
  }

  const allocations = [];
  let rest = quantity;
  for (const lot of rows) {
    if (rest <= 0) break;
    const take = Math.min(rest, lot.remaining);
    allocations.push({ bottlingLedgerId: lot.id, historyCode: lot.history_code, quantity: take });
    rest -= take;
  }

  if (rest > 0) {
    // 瓶詰め履歴のないぶん（商品マスタの初期仕掛品在庫。移行データの起点）は
    // ロットを持たないので、残りをそこから充当できるかを見る。
    const stock = db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(productId);
    const lotTotal = rows.reduce((sum, r) => sum + r.remaining, 0);
    const withoutLot = (stock?.wip_stock ?? 0) - lotTotal;

    if (withoutLot >= rest) {
      // ロットなしぶんは引当行を作らない（紐付けるロットが存在しないため）
      rest = 0;
    } else {
      const available = quantity - rest + Math.max(withoutLot, 0);
      throw new BusinessRuleError(
        `仕掛品在庫が不足しています（引き当てできるのは${available}本、必要${quantity}本）`
      );
    }
  }
  return allocations;
}

/** 割り当て結果を保存する */
function saveAllocations(db, boxingLedgerId, allocations) {
  const stmt = db.prepare(
    `INSERT INTO wip_lot_allocations (boxing_ledger_id, bottling_ledger_id, quantity)
     VALUES (?, ?, ?)`
  );
  for (const a of allocations) stmt.run(boxingLedgerId, a.bottlingLedgerId, a.quantity);
}

/**
 * 滞留している仕掛品ロット（瓶詰めから既定7日以上、残量あり）。
 * GAS版の「仕掛品滞留アラート」に相当する。
 */
function listStaleLots({ thresholdDays = 7 } = {}) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT l.id, l.history_code, l.txn_date, p.name AS product_name,
              l.quantity,
              COALESCE((
                SELECT SUM(a.quantity) FROM wip_lot_allocations a
                JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
                WHERE a.bottling_ledger_id = l.id AND b.is_cancelled = 0
              ), 0) AS allocated,
              CAST(julianday('now', 'localtime') - julianday(l.txn_date) AS INTEGER) AS elapsed_days
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       WHERE l.txn_type = '瓶詰' AND l.is_cancelled = 0
         AND julianday('now', 'localtime') - julianday(l.txn_date) >= @thresholdDays
       ORDER BY l.txn_date`
    )
    .all({ thresholdDays })
    .map((r) => ({ ...r, remaining: r.quantity - r.allocated }))
    .filter((r) => r.remaining > 0);
}

module.exports = { listLots, allocate, saveAllocations, listStaleLots };
