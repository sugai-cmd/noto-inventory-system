// 売上目標（旧GASの setSalesTarget 相当）と、ダッシュボードの当月進捗率。

const { getConnection } = require('../db/connection');
const { BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

/** 目標を設定する。同じ月に再設定したら上書きする。 */
function setSalesTarget({ targetMonth, targetAmount, note }, actor = null) {
  const db = getConnection();

  if (!/^\d{4}-\d{2}$/.test(targetMonth ?? '')) {
    throw new BusinessRuleError('対象月はYYYY-MM形式で指定してください');
  }

  db.prepare(
    `INSERT INTO sales_targets (target_month, target_amount, note)
     VALUES (@targetMonth, @targetAmount, @note)
     ON CONFLICT(target_month) DO UPDATE SET
       target_amount = excluded.target_amount,
       note = excluded.note`
  ).run({ targetMonth, targetAmount, note: note ?? null });

  operationLogService.record({
    user: actor,
    action: 'sales_target.set',
    targetType: 'sales_targets',
    summary: `${targetMonth} の売上目標を ${targetAmount.toLocaleString('ja-JP')}円 に設定`,
  });

  return db.prepare('SELECT * FROM sales_targets WHERE target_month = ?').get(targetMonth);
}

function list({ limit = 24 } = {}) {
  const db = getConnection();
  return db
    .prepare('SELECT * FROM sales_targets ORDER BY target_month DESC LIMIT ?')
    .all(limit);
}

/**
 * 実績を数えるときの日付。
 *
 * 画面から来た文字列をそのままSQLに入れない。ここに載っている名前だけを通し、
 * それ以外は既定（納品日）に落とす。列名はこの表から取り出した固定の文字列。
 */
const BASIS = {
  delivered: { column: 'delivered_on', label: '納品日' },
  ordered: { column: 'ordered_on', label: '受注日' },
  payment_due: { column: 'payment_due_on', label: '入金予定日' },
};
const DEFAULT_BASIS = 'delivered';

/** 請求日・入金日から回収の状態を出す（そのための列は増やさない） */
function paymentStatusOf(row) {
  if (row.paid_on) return '入金済';
  if (row.invoiced_on) return '未入金';
  return '未請求';
}

/** 円の合計。REALの足し算で出る小数のごみを落とす */
function sumAmount(rows) {
  return Math.round(rows.reduce((total, r) => total + (r.sales_amount ?? 0), 0) * 100) / 100;
}

/**
 * 指定月の売上実績と目標の対比（ダッシュボードの「当月進捗率」）。
 *
 * 既定は納品日ベース（売上として立つのは出荷したとき、という考え方）。
 * ただし納品日が空の受注はどの月にも入らないため、実データでは117件中11件が
 * 実績に出てこない。受注日・入金予定日に切り替えられるようにしてある。
 *
 * **委託はどの基準でも報告月で数える**（利用者の判断）。委託は受注と別の表で、
 * 報告された月にしか売上が立たないため。
 *
 * 実績も件数も**明細の配列から出す**。別々に集計すると、
 * 画面の合計と、開いた内訳の合計が食い違いうる。
 *
 * @param {string} targetMonth - YYYY-MM
 * @param {object} [options]
 * @param {string} [options.basis] - delivered / ordered / payment_due
 */
function getMonthlyProgress(targetMonth, { basis = DEFAULT_BASIS } = {}) {
  const db = getConnection();

  if (!/^\d{4}-\d{2}$/.test(targetMonth ?? '')) {
    throw new BusinessRuleError('対象月はYYYY-MM形式で指定してください');
  }

  const basisKey = Object.prototype.hasOwnProperty.call(BASIS, basis) ? basis : DEFAULT_BASIS;
  const { column, label } = BASIS[basisKey];

  const target = db
    .prepare('SELECT * FROM sales_targets WHERE target_month = ?')
    .get(targetMonth);

  // 買取分。基準の日付がその月にある受注
  const purchaseRows = db
    .prepare(
      `SELECT o.id, o.order_no, o.line_no, o.ordered_on, o.delivered_on,
              o.invoiced_on, o.paid_on, o.payment_due_on,
              o.quantity, o.sales_amount,
              c.name AS customer_name, p.name AS product_name
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN products  p ON p.id = o.product_id
        WHERE o.${column} IS NOT NULL
          AND substr(o.${column}, 1, 7) = @month
          AND (o.sales_method IS NULL OR o.sales_method <> '委託')
        ORDER BY o.${column}, o.order_no, o.line_no`
    )
    .all({ month: targetMonth })
    .map((r) => ({ ...r, payment_status: paymentStatusOf(r) }));

  // 委託分。基準を変えても報告月のまま
  const consignmentRows = db
    .prepare(
      `SELECT r.id, r.report_no, r.report_month, r.quantity, r.sales_amount,
              r.invoiced_on, r.paid_on, r.payment_due_on,
              c.name AS customer_name, p.name AS product_name
         FROM consignment_reports r
         JOIN customers c ON c.id = r.customer_id
         JOIN products  p ON p.id = r.product_id
        WHERE r.report_month = @month
        ORDER BY r.report_no`
    )
    .all({ month: targetMonth })
    .map((r) => ({ ...r, payment_status: paymentStatusOf(r) }));

  const purchaseAmount = sumAmount(purchaseRows);
  const consignmentAmount = sumAmount(consignmentRows);
  const actualAmount = Math.round((purchaseAmount + consignmentAmount) * 100) / 100;
  const targetAmount = target?.target_amount ?? null;

  return {
    targetMonth,
    targetAmount,
    actualAmount,
    basis: basisKey,
    basisLabel: label,
    basisColumn: column,
    breakdown: {
      purchase: { amount: purchaseAmount, count: purchaseRows.length, rows: purchaseRows },
      consignment: {
        amount: consignmentAmount,
        count: consignmentRows.length,
        rows: consignmentRows,
      },
    },
    // 目標未設定なら進捗率は出さない（0%と誤解されないようnullにする）
    progressRate: targetAmount ? Math.round((actualAmount / targetAmount) * 1000) / 10 : null,
    remainingAmount: targetAmount ? Math.max(targetAmount - actualAmount, 0) : null,
  };
}

module.exports = { setSalesTarget, list, getMonthlyProgress, BASIS, DEFAULT_BASIS };
