// 得意先に請求している金額を出す。**ここだけが出す。**
//
// 同じ金額を2か所で計算すると必ずずれる。実際、受注の「合計」欄（total_amount）は
// 移行データ103件が `売価×1.1`、14件が `(売価+送料)×1.1`、移植後のコードが
// `売価+送料` と**3通りに割れていた**（DATA_STRUCTURE.md 4-1）。
// 消し込みは「請求した額」と突き合わせる機能なので、ここがずれると残額が永久に0にならない。
//
// ## どの式が「請求している額」か
//
// マネーフォワードの納品書CSV（csvExportService.exportMoneyForward）が
// 実際に得意先へ出している額なので、それに合わせる（利用者の判断）。
//
//   小計 = 売価の合計 + 送料
//   税   = round(小計 × 10%)
//   請求額 = 小計 + 税
//
// ⚠ 送料は PR E 以降すでに税込（繰り上げ50円((運賃+段ボール)×1.1)）なので、
// この式では送料に二重に税が乗っている。**いま実際に請求している額がこれ**なので
// 消し込みはこれに合わせたが、式そのものの是非は別件（backlog）。
//
// 受注一覧の集計（orderModel.summary）は「税は売価にだけ掛ける」考え方で、
// こことは意図的に違う。あちらは社内の売上集計、こちらは得意先への請求額。

const { getConnection } = require('../db/connection');
// 税率は送料の計算と同じ値を使う（2か所に書くと改定のときに片方だけ残る）
const { TAX_RATE } = require('./shippingFeeService');

/** 小計から税込の請求額を出す */
function taxedTotal(subtotal) {
  const tax = Math.round(subtotal * TAX_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

/**
 * 受注番号1つぶんの請求。
 *
 * 1受注で複数商品なら明細が複数行になるが、納品書は受注番号単位で1枚出る。
 * **取消済みの明細は数えない**（0026）。
 *
 * @returns {{orderNo, lines, customerId, customerName, salesAmount, shippingFee,
 *            subtotal, tax, total, invoicedOn, paymentDueOn, deliveredOn}|null}
 */
function orderInvoice(db, orderNo) {
  const lines = db
    .prepare(
      `SELECT o.*, c.name AS customer_name, p.name AS product_name
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN products  p ON p.id = o.product_id
        WHERE o.order_no = @orderNo AND o.is_cancelled = 0
        ORDER BY o.line_no`
    )
    .all({ orderNo });
  if (!lines.length) return null;

  const salesAmount = lines.reduce((sum, l) => sum + (l.sales_amount ?? 0), 0);
  // 送料は受注番号に対して1つ（1行目にだけ載っている）。合計すれば1つぶんになる
  const shippingFee = lines.reduce((sum, l) => sum + (l.shipping_fee ?? 0), 0);
  const head = lines[0];

  return {
    kind: '受注',
    orderNo,
    lines,
    customerId: head.customer_id,
    customerName: head.customer_name,
    productSummary: lines.map((l) => `${l.product_name} ${l.quantity}本`).join(' / '),
    salesAmount,
    shippingFee,
    // 日付は明細で揃っているはずだが、揃っていなければ一番早いものを使う
    // （請求日が入った行と入っていない行が混ざることがありうる）
    invoicedOn: lines.map((l) => l.invoiced_on).filter(Boolean).sort()[0] ?? null,
    paymentDueOn: lines.map((l) => l.payment_due_on).filter(Boolean).sort()[0] ?? null,
    deliveredOn: lines.map((l) => l.delivered_on).filter(Boolean).sort()[0] ?? null,
    ...taxedTotal(salesAmount + shippingFee),
  };
}

/** 委託販売実績報告1件ぶんの請求。式は受注と同じ */
function consignmentInvoice(db, reportId) {
  const row = db
    .prepare(
      `SELECT r.*, c.name AS customer_name, p.name AS product_name
         FROM consignment_reports r
         JOIN customers c ON c.id = r.customer_id
         JOIN products  p ON p.id = r.product_id
        WHERE r.id = ?`
    )
    .get(reportId);
  if (!row) return null;

  const salesAmount = row.sales_amount ?? 0;
  const shippingFee = row.shipping_fee ?? 0;
  return {
    kind: '委託',
    reportId: row.id,
    reportNo: row.report_no,
    reportMonth: row.report_month,
    customerId: row.customer_id,
    customerName: row.customer_name,
    productSummary: `${row.product_name} ${row.quantity}本`,
    salesAmount,
    shippingFee,
    invoicedOn: row.invoiced_on,
    paymentDueOn: row.payment_due_on,
    deliveredOn: null,
    ...taxedTotal(salesAmount + shippingFee),
  };
}

module.exports = { taxedTotal, orderInvoice, consignmentInvoice, TAX_RATE };
