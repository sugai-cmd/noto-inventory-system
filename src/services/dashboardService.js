// ダッシュボードの集計（GAS版 README 3章 ダッシュボード）。
//
// 未入金アラート／本日の出荷予定／次回注文予測。
// 在庫や売上の集計は既存のビュー・サービスがあるので、ここには重複させない。
//
// 3つとも**取消済みの受注を数えない**（0026）。誤登録を取り消しても
// ここに残っていると、未入金の催促や出荷の準備をしてしまう。

const { getConnection } = require('../db/connection');
const { today } = require('../utils/dateUtil');
const paymentService = require('./paymentService');

/**
 * 入金予定日を過ぎているのに入金が済んでいない受注。
 *
 * **受注番号ごとに束ねる。** 請求書も消し込みも受注番号単位なので、
 * 明細1行ずつ出すと「1件の請求が何行にも見える」「金額を足すと二重になる」。
 *
 * 金額は請求額（invoiceAmount）と、消し込み済みを引いた**残額**を出す。
 * 以前は受注の「合計」欄（total_amount）を出していたが、あの列は式が3通りに
 * 割れていて当てにならない（DATA_STRUCTURE.md 4-1）。一部入金にも追従しない。
 */
function listUnpaidOrders({ asOf } = {}) {
  const db = getConnection();
  const base = asOf ?? today();

  const rows = db
    .prepare(
      `SELECT o.order_no,
              MIN(o.id)              AS id,
              MIN(o.ordered_on)      AS ordered_on,
              MIN(o.payment_due_on)  AS payment_due_on,
              MIN(c.name)            AS customer_name,
              GROUP_CONCAT(p.name || ' ' || o.quantity || '本', ' / ') AS product_name,
              CAST(julianday(@base) - julianday(MIN(o.payment_due_on)) AS INTEGER) AS overdue_days
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products  p ON p.id = o.product_id
       WHERE o.is_cancelled = 0
         AND o.paid_on IS NULL
         AND o.payment_due_on IS NOT NULL
         AND o.payment_due_on < @base
       GROUP BY o.order_no
       ORDER BY MIN(o.payment_due_on)`
    )
    .all({ base });

  return rows.map((r) => {
    const invoice = paymentService.invoiceWithBalance(db, { orderNo: r.order_no });
    return {
      ...r,
      invoiceTotal: invoice?.total ?? null,
      paidAmount: invoice?.allocated ?? 0,
      remainingAmount: invoice?.remaining ?? invoice?.total ?? null,
    };
  });
}

/** 指定日に出荷予定の受注（納入希望日が当日で、まだ発送していないもの） */
function listShipmentsDue({ onDate } = {}) {
  const db = getConnection();
  const target = onDate ?? today();
  return db
    .prepare(
      `SELECT o.id, o.order_no, o.line_no, o.quantity, o.requested_delivery_on, o.delivery_method,
              o.delivery_address, c.name AS customer_name, p.name AS product_name
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products  p ON p.id = o.product_id
       WHERE o.is_cancelled = 0
         AND o.status <> '発送済' AND o.requested_delivery_on = @target
       ORDER BY o.order_no, o.line_no`
    )
    .all({ target });
}

/**
 * 次回注文予測（得意先別）。
 * 直近5回の注文日の間隔を平均して次回を見込む（GAS版と同じ方式）。
 * 間隔のばらつきが小さいほど確度を高く出す。ばらつきの大きい得意先で
 * 「予測日を過ぎたから催促」という誤った判断をしないための目安。
 */
function forecastNextOrders({ limitPerCustomer = 5, minOrders = 3 } = {}) {
  const db = getConnection();

  // 受注番号単位（同じ受注番号の複数明細は1回の注文として数える）
  const rows = db
    .prepare(
      `SELECT c.id AS customer_id, c.name AS customer_name, o.order_no, MIN(o.ordered_on) AS ordered_on
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.is_cancelled = 0
       GROUP BY c.id, o.order_no
       ORDER BY c.id, ordered_on DESC`
    )
    .all();

  const byCustomer = new Map();
  for (const r of rows) {
    if (!byCustomer.has(r.customer_id)) {
      byCustomer.set(r.customer_id, { name: r.customer_name, dates: [] });
    }
    const entry = byCustomer.get(r.customer_id);
    if (entry.dates.length < limitPerCustomer) entry.dates.push(r.ordered_on);
  }

  const result = [];
  for (const [customerId, { name, dates }] of byCustomer) {
    if (dates.length < minOrders) continue; // 回数が少ないと間隔が意味を持たない

    const ascending = [...dates].sort();
    const intervals = [];
    for (let i = 1; i < ascending.length; i += 1) {
      intervals.push(daysBetween(ascending[i - 1], ascending[i]));
    }
    if (!intervals.length) continue;

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean <= 0) continue;

    const variance =
      intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / mean; // 変動係数。小さいほど注文間隔が安定している

    const lastOrderedOn = ascending[ascending.length - 1];
    result.push({
      customerId,
      customerName: name,
      lastOrderedOn,
      orderCount: ascending.length,
      averageIntervalDays: Math.round(mean),
      predictedNextOn: addDays(lastOrderedOn, Math.round(mean)),
      confidence: cv <= 0.25 ? '高' : cv <= 0.5 ? '中' : '低',
    });
  }

  return result.sort((a, b) => a.predictedNextOn.localeCompare(b.predictedNextOn));
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { listUnpaidOrders, listShipmentsDue, forecastNextOrders };
