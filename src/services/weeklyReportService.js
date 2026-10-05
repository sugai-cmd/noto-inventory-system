// 週次報告用の集計（NOTOメンバーMTGの「売り上げ、在庫状況」）。
//
// 毎朝 scripts/export-weekly-report.js がこの集計を作り、Googleスプレッドシートへ送る。
// 会議の議事録は、クラウド上のClaudeがそのスプレッドシートを読んで作る
// （このシステムはTailscale内にあり、クラウドからは直接読めないため）。
//
// **読むだけ。** DBには何も書かない。
//
// 金額の考え方は既存の画面と揃える。
//   - 売上は**売価（sales_amount、税抜）**で数える（salesTargetService と同じ）。
//   - 請求・入金の金額は「売価 ＋ 売価の消費税 ＋ 送料」で出し直す（orderModel.summary と同じ）。
//     total_amount は移行データと今のコードで式が揃っていないので読まない。
//   - 取消済みの受注（is_cancelled）は数えない。
//   - 委託は受注と別の表。売上は報告月で数える（salesTargetService と同じ判断）。
//     入金予定・入金は委託の報告の入金予定日・入金日で数える。

const { getConnection } = require('../db/connection');
const { today } = require('../utils/dateUtil');
const { TAX_RATE } = require('./shippingFeeService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 円の合計。REALの足し算で出る小数のごみを落とす */
function yen(value) {
  return Math.round((value ?? 0) * 100) / 100;
}

/** 売価と送料から、請求・入金ベースの税込額を出す（丸めは合計に一度だけ） */
function taxIncluded(salesAmount, shippingFee) {
  const sales = salesAmount ?? 0;
  return yen(sales + Math.round(sales * TAX_RATE) + (shippingFee ?? 0));
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthOf(dateOnly) {
  return dateOnly.slice(0, 7);
}

function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 基準日の前の週（月曜〜日曜） */
function previousWeek(asOf) {
  const dow = new Date(`${asOf}T00:00:00Z`).getUTCDay(); // 0=日
  const mondayThisWeek = addDays(asOf, -((dow + 6) % 7));
  const from = addDays(mondayThisWeek, -7);
  return { from, to: addDays(from, 6) };
}

/** 受注日ベースの売上（買取）を期間で数える */
function orderedSales(db, from, to) {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT order_no)        AS orders,
              COUNT(*)                        AS lines,
              COALESCE(SUM(quantity), 0)      AS quantity,
              COALESCE(SUM(sales_amount), 0)  AS sales
         FROM orders
        WHERE is_cancelled = 0
          AND ordered_on BETWEEN @from AND @to
          AND (sales_method IS NULL OR sales_method <> '委託')`
    )
    .get({ from, to });
}

/**
 * 月の売上（受注日ベース）。monthTo を渡すとその日までの累計にする。
 * 委託は報告月で数えるため、累計でも月の分をそのまま足す。
 */
function monthlyOrderedSales(db, month, monthTo = null) {
  const from = `${month}-01`;
  const to = monthTo ?? `${month}-31`;
  const purchase = orderedSales(db, from, to);
  const consignment = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS quantity,
              COALESCE(SUM(sales_amount), 0) AS sales
         FROM consignment_reports WHERE report_month = ?`
    )
    .get(month);

  const target = db.prepare('SELECT target_amount FROM sales_targets WHERE target_month = ?').get(month);
  const sales = yen(purchase.sales + consignment.sales);
  const targetAmount = target?.target_amount ?? null;

  return {
    month,
    from,
    to: monthTo ?? null,
    salesExclTax: sales,
    purchaseSales: yen(purchase.sales),
    consignmentSales: yen(consignment.sales),
    orders: purchase.orders,
    quantity: purchase.quantity + consignment.quantity,
    targetAmount,
    progressRate: targetAmount ? Math.round((sales / targetAmount) * 1000) / 10 : null,
  };
}

/** 入金予定日が月内にあるもの（買取＋委託）。入金済・未入金に分ける */
function monthlyPaymentDue(db, month) {
  const rows = db
    .prepare(
      `SELECT sales_amount, shipping_fee, paid_on FROM orders
        WHERE is_cancelled = 0 AND substr(payment_due_on, 1, 7) = @month
       UNION ALL
       SELECT sales_amount, shipping_fee, paid_on FROM consignment_reports
        WHERE substr(payment_due_on, 1, 7) = @month`
    )
    .all({ month });

  const sum = (list) =>
    taxIncluded(
      list.reduce((t, r) => t + (r.sales_amount ?? 0), 0),
      list.reduce((t, r) => t + (r.shipping_fee ?? 0), 0)
    );
  const paid = rows.filter((r) => r.paid_on);
  const unpaid = rows.filter((r) => !r.paid_on);

  return {
    month,
    dueAmount: sum(rows),
    paidAmount: sum(paid),
    unpaidAmount: sum(unpaid),
    dueLines: rows.length,
    unpaidLines: unpaid.length,
  };
}

/** 入金日が期間内にあるもの（実際に入ったお金） */
function receivedBetween(db, from, to) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(sales_amount), 0) AS sales, COALESCE(SUM(shipping_fee), 0) AS shipping,
              COUNT(*) AS lines
         FROM (
           SELECT sales_amount, shipping_fee FROM orders
            WHERE is_cancelled = 0 AND paid_on BETWEEN @from AND @to
           UNION ALL
           SELECT sales_amount, shipping_fee FROM consignment_reports
            WHERE paid_on BETWEEN @from AND @to
         )`
    )
    .get({ from, to });
  return { amount: taxIncluded(row.sales, row.shipping), lines: row.lines };
}

/** 入金予定日を過ぎても入金日が入っていないもの */
function overdue(db, asOf) {
  const rows = db
    .prepare(
      `SELECT o.order_no, o.payment_due_on, o.sales_amount, o.shipping_fee, c.name AS customer_name
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.is_cancelled = 0 AND o.paid_on IS NULL
          AND o.payment_due_on IS NOT NULL AND o.payment_due_on < @asOf
       UNION ALL
       SELECT r.report_no, r.payment_due_on, r.sales_amount, r.shipping_fee, c.name
         FROM consignment_reports r JOIN customers c ON c.id = r.customer_id
        WHERE r.paid_on IS NULL
          AND r.payment_due_on IS NOT NULL AND r.payment_due_on < @asOf
       ORDER BY payment_due_on`
    )
    .all({ asOf });

  // 1つの伝票番号に明細が複数あるので、番号ごとにまとめる
  const byNo = new Map();
  for (const r of rows) {
    const cur = byNo.get(r.order_no) ?? {
      no: r.order_no,
      customer: r.customer_name,
      paymentDueOn: r.payment_due_on,
      sales: 0,
      shipping: 0,
    };
    cur.sales += r.sales_amount ?? 0;
    cur.shipping += r.shipping_fee ?? 0;
    byNo.set(r.order_no, cur);
  }
  const items = [...byNo.values()].map((r) => ({
    no: r.no,
    customer: r.customer,
    paymentDueOn: r.paymentDueOn,
    amount: taxIncluded(r.sales, r.shipping),
  }));
  return {
    count: items.length,
    amount: yen(items.reduce((t, r) => t + r.amount, 0)),
    items,
  };
}

/** 月の受注日ベース売上を得意先別・商品別に（委託は報告月で足す） */
function breakdown(db, month, monthTo) {
  const from = `${month}-01`;
  const to = monthTo ?? `${month}-31`;
  const query = (keyCol, joinSql) =>
    db
      .prepare(
        `SELECT name, SUM(quantity) AS quantity, SUM(sales) AS sales FROM (
           SELECT ${keyCol} AS name, o.quantity, o.sales_amount AS sales
             FROM orders o ${joinSql.replaceAll('X', 'o')}
            WHERE o.is_cancelled = 0 AND o.ordered_on BETWEEN @from AND @to
              AND (o.sales_method IS NULL OR o.sales_method <> '委託')
           UNION ALL
           SELECT ${keyCol} AS name, r.quantity, r.sales_amount
             FROM consignment_reports r ${joinSql.replaceAll('X', 'r')}
            WHERE r.report_month = @month
         ) GROUP BY name ORDER BY sales DESC`
      )
      .all({ from, to, month })
      .map((r) => ({ name: r.name, quantity: r.quantity, salesExclTax: yen(r.sales) }));

  return {
    byCustomer: query('c.name', 'JOIN customers c ON c.id = X.customer_id'),
    byProduct: query('p.name', 'JOIN products p ON p.id = X.product_id'),
  };
}

function stock(db) {
  const products = db
    .prepare(
      `SELECT name, product_stock, wip_stock FROM v_product_stock
        WHERE product_stock <> 0 OR wip_stock <> 0 ORDER BY name`
    )
    .all()
    .map((r) => ({ name: r.name, productStock: r.product_stock, wipStock: r.wip_stock }));

  // 適正在庫数を下回った資材（適正在庫数が未設定のものは判定しない）
  const materialsToOrder = db
    .prepare(
      `SELECT s.name, s.current_stock, m.unit, m.proper_stock_qty, m.supplier_name, m.lead_time_days
         FROM v_material_stock s JOIN materials m ON m.id = s.material_id
        WHERE m.proper_stock_qty IS NOT NULL AND s.current_stock < m.proper_stock_qty
        ORDER BY s.name`
    )
    .all()
    .map((r) => ({
      name: r.name,
      currentStock: r.current_stock,
      unit: r.unit,
      properStock: r.proper_stock_qty,
      supplier: r.supplier_name,
      leadTimeDays: r.lead_time_days,
    }));

  // 浄酎の容器（廃棄済みと空は出さない）
  const tanks = db
    .prepare(
      `SELECT t.code, v.name, v.current_volume_l, v.max_volume_l, v.fill_rate
         FROM v_tank_monitor v JOIN tanks t ON t.id = v.tank_id
        WHERE t.discarded_on IS NULL AND ABS(v.current_volume_l) > 0.0001
        ORDER BY t.code`
    )
    .all()
    .map((r) => ({
      code: r.code,
      name: r.name,
      volumeL: yen(r.current_volume_l),
      maxVolumeL: r.max_volume_l,
      fillRate: r.fill_rate != null ? Math.round(r.fill_rate * 1000) / 10 : null,
    }));

  // 原酒のタンク（原酒台帳に動きがあり、残っているもの）
  const rawSakeTanks = db
    .prepare(
      `SELECT v.code, v.name, v.current_volume_l, v.max_volume_l
         FROM v_raw_sake_tank_volume v JOIN tanks t ON t.id = v.tank_id
        WHERE t.discarded_on IS NULL AND ABS(v.current_volume_l) > 0.0001
          AND EXISTS (SELECT 1 FROM raw_sake_ledger l
                       WHERE l.from_tank_id = v.tank_id OR l.to_tank_id = v.tank_id)
        ORDER BY v.code`
    )
    .all()
    .map((r) => ({ code: r.code, name: r.name, volumeL: yen(r.current_volume_l), maxVolumeL: r.max_volume_l }));

  return { products, materialsToOrder, tanks, rawSakeTanks };
}

/**
 * 週次報告の集計を作る。
 *
 * @param {object} [options]
 * @param {string} [options.asOf] - 集計日 YYYY-MM-DD（既定は今日）。この日の朝の時点として、前日までを数える
 */
function buildReport({ asOf } = {}) {
  const date = asOf ?? today();
  if (!DATE_RE.test(date)) throw new Error(`集計日はYYYY-MM-DD形式で指定してください: "${date}"`);

  const db = getConnection();
  const throughDate = addDays(date, -1); // 朝に集計するので前日までを数える
  const month = monthOf(throughDate);
  const prevMonth = previousMonth(month);
  const week = previousWeek(date);

  return {
    generatedAt: new Date().toISOString(),
    asOf: date,
    throughDate,
    month,
    previousWeek: week,
    // 前週の月曜が前月にある＝この週の報告で前月の締めを報告する
    reportPreviousMonth: monthOf(week.from) !== monthOf(date),
    current: {
      // 受注日ベース：月初から前日までの累計
      ordered: monthlyOrderedSales(db, month, throughDate),
      // 入金予定日ベース：入金予定日が当月にあるもの
      paymentDue: monthlyPaymentDue(db, month),
      // 当月に実際に入金されたもの（月初から前日まで）
      received: receivedBetween(db, `${month}-01`, throughDate),
    },
    week: {
      ...week,
      ordered: orderedSales(db, week.from, week.to),
      received: receivedBetween(db, week.from, week.to),
    },
    previousMonth: {
      ordered: monthlyOrderedSales(db, prevMonth),
      paymentDue: monthlyPaymentDue(db, prevMonth),
    },
    overdue: overdue(db, date),
    breakdown: breakdown(db, month, throughDate),
    stock: stock(db),
  };
}

module.exports = { buildReport, previousWeek, taxIncluded };
