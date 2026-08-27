// CSV出力（旧GASのゆうパック用／マネーフォワード用CSV生成 相当）。
//
// 出力先の仕様は外部システム側で決まっており、現行の列構成を推定して実装している。
// 実運用のテンプレートに合わせて列を調整できるよう、列定義は各関数の先頭にまとめてある。

const { getConnection } = require('../db/connection');

/** CSV1セル分のエスケープ */
function cell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  // Excel/ゆうパック側での文字化けを避けるためBOM付きCRLFで出力する
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function fetchOrders(db, { orderIds, from, to, status }) {
  const where = [];
  const params = {};

  if (orderIds?.length) {
    // better-sqlite3は配列バインドに対応しないため、件数分のプレースホルダを展開する
    const placeholders = orderIds.map((_, i) => `@id${i}`).join(',');
    where.push(`o.id IN (${placeholders})`);
    orderIds.forEach((id, i) => { params[`id${i}`] = id; });
  }
  if (from) { where.push('o.ordered_on >= @from'); params.from = from; }
  if (to) { where.push('o.ordered_on <= @to'); params.to = to; }
  if (status) { where.push('o.status = @status'); params.status = status; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT o.*, c.name AS customer_name, c.address AS customer_address,
              c.payment_term_months, c.payment_term_day,
              p.name AS product_name, p.volume_ml
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products  p ON p.id = o.product_id
       ${whereSql}
       ORDER BY o.ordered_on, o.order_no`
    )
    .all(params);
}

/**
 * ゆうパック（送り状発行）用CSV。
 * 宛先情報と品名・個数を出力する。配送先が空の場合は得意先マスタの住所を使う。
 */
function exportYuPack(filter = {}) {
  const db = getConnection();
  const orders = fetchOrders(db, filter);

  const headers = [
    'お届け先郵便番号',
    'お届け先住所',
    'お届け先名称',
    '品名',
    '個数',
    '荷送人名称',
    'ご依頼主住所',
    '備考',
  ];

  const rows = orders.map((o) => [
    '', // 郵便番号は現行データに列がないため空欄（送り状側で補完）
    o.delivery_address || o.customer_address || '',
    o.customer_name,
    `${o.product_name}${o.volume_ml ? `(${o.volume_ml}ml)` : ''}`,
    o.quantity,
    'NOTO Naorai株式会社',
    '',
    o.order_no,
  ]);

  return { csv: toCsv(headers, rows), count: rows.length };
}

/**
 * マネーフォワード（売上仕訳）用CSV。
 * 1受注1行で、売上金額・取引先・請求/入金予定日を出力する。
 */
function exportMoneyForward(filter = {}) {
  const db = getConnection();
  const orders = fetchOrders(db, filter);

  const headers = [
    '取引日',
    '取引先',
    '品目',
    '数量',
    '単価',
    '売上金額',
    '送料',
    '合計金額',
    '請求日',
    '入金予定日',
    '入金日',
    '伝票番号',
    '備考',
  ];

  const rows = orders.map((o) => [
    o.delivered_on || o.ordered_on, // 売上計上日は納品日、未発送なら受注日
    o.customer_name,
    o.product_name,
    o.quantity,
    o.unit_price,
    o.sales_amount,
    o.shipping_fee,
    o.total_amount,
    o.invoiced_on || '',
    o.payment_due_on || '',
    o.paid_on || '',
    o.order_no,
    o.note || '',
  ]);

  return { csv: toCsv(headers, rows), count: rows.length };
}

/** 商品在庫モニターのCSV出力（棚卸の突合用に印刷して使う想定） */
function exportProductStock() {
  const db = getConnection();
  const rows = db.prepare('SELECT * FROM v_product_stock ORDER BY name').all();
  return {
    csv: toCsv(
      ['商品名称', '商品（完成品）', '仕掛品', '実測（記入欄）'],
      rows.map((r) => [r.name, r.product_stock, r.wip_stock, ''])
    ),
    count: rows.length,
  };
}

/** 資材在庫モニターのCSV出力（7-1で新設した集計） */
function exportMaterialStock() {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT s.name, s.current_stock, m.unit, m.proper_stock_qty, m.supplier_name, m.lead_time_days
       FROM v_material_stock s
       JOIN materials m ON m.id = s.material_id
       ORDER BY s.name`
    )
    .all();

  return {
    csv: toCsv(
      ['資材名', '現在庫', '単位', '適正在庫数', '発注先', 'リードタイム(日)', '実測（記入欄）'],
      rows.map((r) => [
        r.name,
        r.current_stock,
        r.unit ?? '',
        r.proper_stock_qty ?? '',
        r.supplier_name ?? '',
        r.lead_time_days ?? '',
        '',
      ])
    ),
    count: rows.length,
  };
}

/** タンクモニターのCSV出力 */
function exportTankMonitor() {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT t.code, v.name, v.current_volume_l, v.max_volume_l, v.fill_rate, t.current_abv
       FROM v_tank_monitor v
       JOIN tanks t ON t.id = v.tank_id
       ORDER BY t.code`
    )
    .all();

  return {
    csv: toCsv(
      ['容器ID', '容器名称', '現在液量(L)', '最大容量(L)', '貯蔵率', 'アルコール度数', '実測（記入欄）'],
      rows.map((r) => [
        r.code,
        r.name,
        r.current_volume_l,
        r.max_volume_l ?? '',
        r.fill_rate != null ? (r.fill_rate * 100).toFixed(1) + '%' : '',
        r.current_abv ?? '',
        '',
      ])
    ),
    count: rows.length,
  };
}

module.exports = {
  exportYuPack,
  exportMoneyForward,
  exportProductStock,
  exportMaterialStock,
  exportTankMonitor,
};
