// 仕掛品ロット（瓶詰め1件＝1ロット）の残量計算と引当。
//
// GAS版の箱詰めは「仕掛品のロット一覧から選び、選んだロットで足りない分は
// 次に古いロットから自動的に補う」という挙動（README 3章 瓶詰め・箱詰め）。
// 従来のこちらの実装は仕掛品の合計しか見ておらず、どのロットを箱詰めしたかが
// 残らなかったため、ロット単位の追跡と取消の復元ができなかった。

const { getConnection } = require('../db/connection');
const { BusinessRuleError, NotFoundError, ConflictError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

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
 * 瓶詰めロットに引き当てられている本数。
 * 取消済みの箱詰めは数えない（取り消したら引当も戻る）。
 */
const ALLOCATED_SUBQUERY = `
  COALESCE((
    SELECT SUM(a.quantity) FROM wip_lot_allocations a
    JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
    WHERE a.bottling_ledger_id = l.id AND b.is_cancelled = 0
  ), 0)`;

/**
 * 引当が足りていない箱詰めを返す。
 *
 * 移行で入った箱詰めには引当行が1件も無い。旧シートは「どの瓶詰めロットを使ったか」を
 * 受入元/払出先の欄に**文字**（L2607-0072 のような商品履歴ID）で書いていただけで、
 * 移行スクリプトはそれを product_stock_ledger.counterparty にそのまま入れている。
 * IDでの紐付け（wip_lot_allocations）は作られない。
 *
 * counterparty に書かれた文字が、同じ商品の瓶詰め行の history_code と一致するときは
 * **候補**として添える。自動では紐付けない。同じ欄にはタンク名・得意先・
 * 「棚卸し過剰分」も混ざっており、機械で当てると別のロットに繋がるため。
 */
function listUnlinkedBoxings({ productId = null } = {}) {
  const db = getConnection();

  return db
    .prepare(
      `SELECT x.id, x.history_code, x.txn_date, x.quantity, x.counterparty,
              x.product_id, p.name AS product_name,
              COALESCE((
                SELECT SUM(a.quantity) FROM wip_lot_allocations a
                WHERE a.boxing_ledger_id = x.id
              ), 0) AS allocated,
              hint.id           AS hint_ledger_id,
              hint.history_code AS hint_history_code,
              hint.txn_date     AS hint_txn_date
         FROM product_stock_ledger x
         JOIN products p ON p.id = x.product_id
         -- counterparty の文字が、同じ商品の瓶詰め行の履歴IDと一致するか
         LEFT JOIN product_stock_ledger hint
                ON hint.history_code = x.counterparty
               AND hint.txn_type = '瓶詰'
               AND hint.is_cancelled = 0
               AND hint.product_id = x.product_id
        WHERE x.txn_type = '箱詰' AND x.is_cancelled = 0
          AND (@productId IS NULL OR x.product_id = @productId)
        ORDER BY x.txn_date DESC, x.id DESC`
    )
    .all({ productId })
    .map((r) => ({ ...r, unallocated: r.quantity - r.allocated }))
    .filter((r) => r.unallocated > 0);
}

/** 箱詰め1件の引当内訳 */
function listAllocations(boxingLedgerId) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT a.id, a.bottling_ledger_id, a.quantity,
              l.history_code AS bottling_history_code, l.txn_date AS bottling_txn_date
         FROM wip_lot_allocations a
         JOIN product_stock_ledger l ON l.id = a.bottling_ledger_id
        WHERE a.boxing_ledger_id = ?
        ORDER BY l.txn_date, l.id`
    )
    .all(boxingLedgerId);
}

/**
 * 箱詰め1件の引当を、渡された内訳で**まるごと置き換える**。
 *
 * 足すのではなく置き換えにするのは、同じ画面から2回押したときに二重に積まれないため。
 * 引当行の書き込みは今まで箱詰めの新規登録（submitBoxing）からしか無く、
 * あとから直す手段が無かった。
 */
function replaceAllocations(boxingLedgerId, items, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const boxing = db
      .prepare(
        `SELECT l.*, p.name AS product_name FROM product_stock_ledger l
          JOIN products p ON p.id = l.product_id WHERE l.id = ?`
      )
      .get(boxingLedgerId);
    if (!boxing) throw new NotFoundError(`箱詰めの記録が見つかりません (id=${boxingLedgerId})`);
    if (boxing.txn_type !== '箱詰') {
      throw new ConflictError(
        `id=${boxingLedgerId} は「${boxing.txn_type}」の記録です。紐付けを直せるのは箱詰めだけです`
      );
    }
    if (boxing.is_cancelled) {
      throw new ConflictError(`${boxing.history_code} は取消済みです。紐付けは直せません`);
    }

    const before = listAllocations(boxingLedgerId);

    const total = items.reduce((sum, i) => sum + i.quantity, 0);
    if (total > boxing.quantity) {
      throw new BusinessRuleError(
        `割り当ての合計 ${total} 本が、箱詰めの本数 ${boxing.quantity} 本を超えています`
      );
    }

    const findLot = db.prepare(
      `SELECT l.id, l.history_code, l.quantity, l.product_id, l.is_cancelled, l.txn_type,
              ${ALLOCATED_SUBQUERY} AS allocated,
              COALESCE((
                SELECT SUM(a.quantity) FROM wip_lot_allocations a
                WHERE a.bottling_ledger_id = l.id AND a.boxing_ledger_id = @boxingId
              ), 0) AS allocated_here
         FROM product_stock_ledger l WHERE l.id = @lotId`
    );

    for (const item of items) {
      const lot = findLot.get({ lotId: item.bottlingLedgerId, boxingId: boxingLedgerId });
      if (!lot) throw new NotFoundError(`瓶詰めロットが見つかりません (id=${item.bottlingLedgerId})`);
      if (lot.txn_type !== '瓶詰' || lot.is_cancelled) {
        throw new ConflictError(`id=${item.bottlingLedgerId} は有効な瓶詰めロットではありません`);
      }
      if (lot.product_id !== boxing.product_id) {
        throw new BusinessRuleError(
          `${lot.history_code} は別の商品の瓶詰めです。同じ商品のロットだけ選べます`
        );
      }
      // いま置き換えようとしている箱詰めのぶんは、残量から除いて数える
      const remaining = lot.quantity - (lot.allocated - lot.allocated_here);
      if (item.quantity > remaining) {
        throw new BusinessRuleError(
          `${lot.history_code} の残量は ${remaining} 本です（${item.quantity} 本は割り当てられません）`
        );
      }
    }

    db.prepare('DELETE FROM wip_lot_allocations WHERE boxing_ledger_id = ?').run(boxingLedgerId);
    saveAllocations(db, boxingLedgerId, items);

    return { boxing, before, after: listAllocations(boxingLedgerId) };
  });

  const { boxing, before, after } = run();

  operationLogService.record({
    user: actor,
    action: 'wipLot.relink',
    targetType: 'product_stock_ledger',
    targetId: boxingLedgerId,
    summary: `${boxing.history_code} の仕掛品ロットの紐付けを直しました（${after.length}件）`,
    // 直す前の内訳も残す。間違えたときに戻せるようにするため
    detail: {
      before: before.map((a) => ({ lot: a.bottling_history_code, quantity: a.quantity })),
      after: after.map((a) => ({ lot: a.bottling_history_code, quantity: a.quantity })),
    },
  });

  return { boxingLedgerId, historyCode: boxing.history_code, allocations: after };
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

module.exports = {
  listLots,
  allocate,
  saveAllocations,
  listStaleLots,
  listUnlinkedBoxings,
  listAllocations,
  replaceAllocations,
};
