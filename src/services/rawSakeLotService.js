// 原酒の受入ロットと、蒸留への払出の引き当て。
//
// 瓶詰め→箱詰めは wip_lot_allocations で「どの瓶詰めロットの何本をどの箱詰めに
// 使ったか」を持っている。原酒には同じものが無く、払出行は投入元タンクを持つだけで、
// **そのタンクの中のどの受入ロットを使ったかは記録に無かった**
// （lotTraceService が銘柄別に按分して推定しているだけだった）。
//
// この仕組みは wipLotService をそのまま写している。違うのは数える単位（本 → L）と、
// 「ロットを持たない在庫」の扱いが要らないこと（原酒はすべて受入ロットから来る）。
//
// 実データの原酒ポリは「空にしてから次を入れる」運用なので、古い順に引き当てれば
// ほとんどが一意に決まる（払出79件のうち73件が受入ロット1件で決まる）。

const { getConnection } = require('../db/connection');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');
const { round6 } = require('../utils/stockGuard');
const operationLogService = require('./operationLogService');

/** 引き当ての向きを持つ区分。受入だけが引当元になれる */
const RECEIPT = '受入';

/**
 * 受入ロットに引き当てられている量。
 * 取消済みの払出は数えない（取り消したら引当も戻る）。
 */
function allocatedFromReceipt(db, receiptLedgerId) {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(a.quantity), 0) AS n
           FROM raw_sake_lot_allocations a
           JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
          WHERE a.receipt_ledger_id = ? AND p.is_cancelled = 0`
      )
      .get(receiptLedgerId)?.n ?? 0
  );
}

/** その受入ロットを使っている蒸留（取り消せるかの判断に使う） */
function listDistillationsUsing(db, receiptLedgerId) {
  return db
    .prepare(
      `SELECT DISTINCT p.lot_code, d.distillation_code
         FROM raw_sake_lot_allocations a
         JOIN raw_sake_ledger p    ON p.id = a.payout_ledger_id
         LEFT JOIN distillations d ON d.id = p.distillation_id
        WHERE a.receipt_ledger_id = ? AND p.is_cancelled = 0`
    )
    .all(receiptLedgerId);
}

/** 払出に引き当てられている量 */
function allocatedToPayout(db, payoutLedgerId) {
  return (
    db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM raw_sake_lot_allocations WHERE payout_ledger_id = ?')
      .get(payoutLedgerId)?.n ?? 0
  );
}

/**
 * そのタンクで、まだ引き当てられていない受入ロットを古い順に返す。
 *
 * 取消済みの受入は引当元にしない（残量からも外れている）。
 */
function availableReceipts(db, tankId, { excludePayoutId = null } = {}) {
  return db
    .prepare(
      `SELECT l.id, l.lot_code, l.txn_date, l.quantity,
              COALESCE((
                SELECT SUM(a.quantity) FROM raw_sake_lot_allocations a
                JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
                WHERE a.receipt_ledger_id = l.id AND p.is_cancelled = 0
                  AND (@excludePayoutId IS NULL OR a.payout_ledger_id <> @excludePayoutId)
              ), 0) AS allocated
         FROM raw_sake_ledger l
        WHERE l.to_tank_id = @tankId AND l.txn_type = '受入' AND l.is_cancelled = 0
        ORDER BY l.txn_date, l.id`
    )
    .all({ tankId, excludePayoutId })
    .map((r) => ({ ...r, remaining: round6(r.quantity - r.allocated) }))
    .filter((r) => r.remaining > 0);
}

/**
 * 払出に対して、古い順に引き当てる内訳を作る（書き込みはしない）。
 *
 * **足りなくても throw しない。** 移行データには在庫が足りない払出が実在し
 * （投入元タンクが空欄の R2606-1001 / R2606-1002 など）、ここで止めると
 * 蒸留の登録そのものができなくなる。引けたぶんだけ返し、残りは呼び手が
 * 「未紐付け」として扱う。
 */
function planAllocation(db, { tankId, quantity, preferredReceiptId = null, excludePayoutId = null }) {
  if (tankId == null) return { allocations: [], shortage: quantity };

  const rows = availableReceipts(db, tankId, { excludePayoutId });

  if (preferredReceiptId) {
    const index = rows.findIndex((r) => r.id === preferredReceiptId);
    if (index < 0) {
      throw new BusinessRuleError(
        `指定された受入ロットは残りがないか、このタンクのものではありません (id=${preferredReceiptId})`
      );
    }
    // 指定ロットを先頭に持ってくる。残りは古い順のまま
    const [preferred] = rows.splice(index, 1);
    rows.unshift(preferred);
  }

  const allocations = [];
  let rest = quantity;
  for (const lot of rows) {
    if (rest <= 0) break;
    const take = Math.min(rest, lot.remaining);
    allocations.push({ receiptLedgerId: lot.id, lotCode: lot.lot_code, quantity: round6(take) });
    rest = round6(rest - take);
  }

  return { allocations, shortage: Math.max(rest, 0) };
}

/** 引当行を書き込む */
function saveAllocations(db, payoutLedgerId, allocations) {
  const stmt = db.prepare(
    `INSERT INTO raw_sake_lot_allocations (payout_ledger_id, receipt_ledger_id, quantity)
     VALUES (?, ?, ?)`
  );
  for (const a of allocations) stmt.run(payoutLedgerId, a.receiptLedgerId, a.quantity);
}

/**
 * 払出を作った直後に呼ぶ。古い順で引き当てて書き込む。
 *
 * 蒸留の登録と同じトランザクションの中で呼ばれる想定。
 * 引き当てられなくても蒸留は止めない。
 */
function allocateForPayout(db, payoutLedgerId, { tankId, quantity, preferredReceiptId = null }) {
  const { allocations, shortage } = planAllocation(db, { tankId, quantity, preferredReceiptId });
  saveAllocations(db, payoutLedgerId, allocations);
  return { allocations, shortage };
}

/** 払出1件の引当内訳 */
function listAllocations(payoutLedgerId) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT a.id, a.receipt_ledger_id, a.quantity,
              r.lot_code AS receipt_lot_code, r.txn_date AS receipt_txn_date,
              b.name AS brand_name
         FROM raw_sake_lot_allocations a
         JOIN raw_sake_ledger r      ON r.id = a.receipt_ledger_id
         LEFT JOIN raw_sake_brands b ON b.id = r.raw_sake_brand_id
        WHERE a.payout_ledger_id = ?
        ORDER BY r.txn_date, r.id`
    )
    .all(payoutLedgerId);
}

/**
 * 引き当てが決まっていない払出。
 *
 * 移行で入った払出には引当行が1件も無い。**古い順で引くならどれになるか**を
 * 候補として添える（#32 の仕掛品ロットの紐付けが、受入元/払出先の文字から
 * 当たりを付けているのと同じ役割）。自動では確定しない。
 */
function listUnlinkedPayouts() {
  const db = getConnection();

  const rows = db
    .prepare(
      `SELECT l.id, l.lot_code, l.txn_date, l.txn_type, l.quantity, l.from_tank_id,
              t.code AS from_tank_code, t.name AS from_tank_name,
              d.distillation_code,
              COALESCE((
                SELECT SUM(a.quantity) FROM raw_sake_lot_allocations a
                WHERE a.payout_ledger_id = l.id
              ), 0) AS allocated
         FROM raw_sake_ledger l
         LEFT JOIN tanks t         ON t.id = l.from_tank_id
         LEFT JOIN distillations d ON d.id = l.distillation_id
        WHERE l.txn_type IN ('払出', '欠減') AND l.is_cancelled = 0
        ORDER BY l.txn_date, l.id`
    )
    .all()
    .filter((r) => r.allocated < r.quantity - 0.0005);

  // 候補は「いま引くならどうなるか」。まとめて割り当てるボタンと同じ計算を使う
  return rows.map((r) => {
    const { allocations, shortage } = planAllocation(db, {
      tankId: r.from_tank_id,
      quantity: round6(r.quantity - r.allocated),
      excludePayoutId: r.id,
    });
    return { ...r, remaining: round6(r.quantity - r.allocated), suggestion: allocations, shortage };
  });
}

/**
 * 払出1件の引当を、渡された内訳で**まるごと置き換える**。
 *
 * 足すのではなく置き換えにするのは、同じ画面から2回押したときに二重に積まれないため
 * （wipLotService.replaceAllocations と同じ理由）。
 */
function replaceAllocations(payoutLedgerId, items, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const payout = db
      .prepare(
        `SELECT l.*, d.distillation_code, t.name AS from_tank_name
           FROM raw_sake_ledger l
           LEFT JOIN distillations d ON d.id = l.distillation_id
           LEFT JOIN tanks t         ON t.id = l.from_tank_id
          WHERE l.id = ?`
      )
      .get(payoutLedgerId);
    if (!payout) throw new NotFoundError(`原料受払記録が見つかりません (id=${payoutLedgerId})`);
    if (!['払出', '欠減'].includes(payout.txn_type)) {
      throw new ConflictError(
        `${payout.lot_code} は「${payout.txn_type}」の記録です。引き当てを直せるのは払出だけです`
      );
    }
    if (payout.is_cancelled) {
      throw new ConflictError(`${payout.lot_code} は取消済みです`);
    }

    const total = round6((items ?? []).reduce((sum, i) => sum + i.quantity, 0));
    if (total > payout.quantity + 0.0005) {
      throw new BusinessRuleError(
        `引き当ての合計 ${total}L が払出量 ${payout.quantity}L を超えています`
      );
    }

    // 引当元が受入で、同じタンクのものであること
    for (const item of items ?? []) {
      const receipt = db.prepare('SELECT * FROM raw_sake_ledger WHERE id = ?').get(item.receiptLedgerId);
      if (!receipt) {
        throw new NotFoundError(`引当元の受入が見つかりません (id=${item.receiptLedgerId})`);
      }
      if (receipt.txn_type !== RECEIPT || receipt.is_cancelled) {
        throw new BusinessRuleError(
          `${receipt.lot_code} は引当元にできません（有効な受入だけが引当元になります）`
        );
      }
      if (payout.from_tank_id != null && receipt.to_tank_id !== payout.from_tank_id) {
        throw new BusinessRuleError(
          `${receipt.lot_code} は別のタンクの受入です（${payout.lot_code} の投入元と揃えてください）`
        );
      }
      // この払出ぶんを除いた残りで足りるか
      const remaining = round6(
        receipt.quantity - allocatedFromReceiptExcluding(db, receipt.id, payoutLedgerId)
      );
      if (item.quantity > remaining + 0.0005) {
        throw new BusinessRuleError(
          `${receipt.lot_code} の残りは ${remaining}L です（${item.quantity}L は引き当てられません）`
        );
      }
    }

    const removed = db
      .prepare('DELETE FROM raw_sake_lot_allocations WHERE payout_ledger_id = ?')
      .run(payoutLedgerId).changes;
    saveAllocations(db, payoutLedgerId, items ?? []);

    operationLogService.record({
      user: actor,
      action: 'rawSake.allocation.replace',
      targetType: 'raw_sake_ledger',
      targetId: payoutLedgerId,
      summary:
        `${payout.lot_code}（蒸留 ${payout.distillation_code ?? '—'}）の引き当てを` +
        `${(items ?? []).length}件に置き換え（合計 ${total}L / 払出 ${payout.quantity}L）`,
      detail: { removed, items: items ?? [], payoutQuantity: payout.quantity },
    });

    return { payoutLedgerId, lotCode: payout.lot_code, allocations: listAllocations(payoutLedgerId) };
  });

  return run();
}

/** この払出ぶんを除いた、受入ロットの引当済み量 */
function allocatedFromReceiptExcluding(db, receiptLedgerId, excludePayoutId) {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(a.quantity), 0) AS n
           FROM raw_sake_lot_allocations a
           JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
          WHERE a.receipt_ledger_id = ? AND p.is_cancelled = 0 AND a.payout_ledger_id <> ?`
      )
      .get(receiptLedgerId, excludePayoutId)?.n ?? 0
  );
}

/**
 * 未紐付けの払出を、古い順でまとめて引き当てる。
 *
 * **引き当てられなかった行はそのまま残す。** 移行データには投入元タンクが空欄の
 * 払出が実在し（R2606-1001 / R2606-1002）、そこは埋めようがない。
 * 黙って別のロットに繋がないよう、件数を返して画面に出す。
 */
function backfillFromFifo(actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    // 古い順に処理する。先の払出が引いたぶんが、次の払出の残りに効く
    const targets = db
      .prepare(
        `SELECT l.id, l.lot_code, l.from_tank_id, l.quantity,
                COALESCE((
                  SELECT SUM(a.quantity) FROM raw_sake_lot_allocations a
                  WHERE a.payout_ledger_id = l.id
                ), 0) AS allocated
           FROM raw_sake_ledger l
          WHERE l.txn_type IN ('払出', '欠減') AND l.is_cancelled = 0
          ORDER BY l.txn_date, l.id`
      )
      .all()
      .filter((r) => r.allocated < r.quantity - 0.0005);

    let linked = 0;
    let partial = 0;
    const skipped = [];

    for (const row of targets) {
      const need = round6(row.quantity - row.allocated);
      const { allocations, shortage } = planAllocation(db, {
        tankId: row.from_tank_id,
        quantity: need,
        excludePayoutId: row.id,
      });

      if (!allocations.length) {
        skipped.push({
          lotCode: row.lot_code,
          reason: row.from_tank_id == null ? '投入元タンクが空欄' : '引き当てられる受入が無い',
        });
        continue;
      }

      saveAllocations(db, row.id, allocations);
      linked += 1;
      if (shortage > 0.0005) partial += 1;
    }

    operationLogService.record({
      user: actor,
      action: 'rawSake.allocation.backfill',
      targetType: 'raw_sake_lot_allocations',
      summary:
        `未紐付けの払出を古い順で引き当て（対象${targets.length}件 / 紐付いた${linked}件` +
        `${partial ? ` / うち一部だけ${partial}件` : ''}` +
        `${skipped.length ? ` / 引き当てられなかった${skipped.length}件` : ''}）`,
      detail: { targets: targets.length, linked, partial, skipped },
    });

    return { targets: targets.length, linked, partial, skipped };
  });

  return run();
}

module.exports = {
  allocatedFromReceipt,
  allocatedToPayout,
  listDistillationsUsing,
  availableReceipts,
  planAllocation,
  allocateForPayout,
  listAllocations,
  listUnlinkedPayouts,
  replaceAllocations,
  backfillFromFifo,
};
