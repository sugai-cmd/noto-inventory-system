// CSV出力（旧GASのゆうパック用／マネーフォワード用CSV生成 相当）。
//
// ゆうパック・マネーフォワードの列定義は、GAS版 CsvExportCode.gs の実装から移した。
// 在庫系（商品／資材／タンク）のCSVはこちらで追加したもの。

const { getConnection } = require('../db/connection');
const { parseShippingAddress } = require('../utils/shippingAddress');

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

// ============================================================
// ゆうパック出荷予定データCSV（72列・ヘッダー行なし・Shift_JIS）
// マネーフォワード 納品書CSV（csv_type 40202・横型明細7品目・UTF-8 BOM付き）
//
// 列の位置・固定値・自社情報は、GAS版 CsvExportCode.gs の実装をそのまま移した。
// 推測した箇所は無い。
// ============================================================

// 自社（ご依頼主）情報
const SENDER_INFO = {
  corporateName: 'NOTO Naorai株式会社',
  department: '能登浄溜所',
  zip: '9291715',
  prefecture: '石川県',
  city: '鹿島郡中能登町一青',
  address: 'ふ16-2',
  building: '',
  phone: '050-1793-1010',
};

// ゆうパック出力時の固定値
const YUPACK_DEFAULTS = {
  product: '1',        // ゆうパック
  paymentType: '0',    // 元払
  goodsName: '浄酎',   // 品名
  fragileBottle: '1',  // 取扱上の注意「ビン類」を常に立てる
  discount: '0',       // 割引：利用しない
};

/**
 * 先頭0が消えないよう、値を必ず「ダブルクォートで囲んだ文字列」として埋め込む。
 * 電話番号・郵便番号がExcelで数値と誤認識されるのを防ぐため（GAS版と同じ）。
 */
function csvQuote(value) {
  if (value == null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildCsvRow(values) {
  return values.map(csvQuote).join(',');
}

/** 受注番号ごとに明細をまとめる（1受注＝同じ受注番号の複数行） */
function groupByOrderNo(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.order_no)) map.set(row.order_no, []);
    map.get(row.order_no).push(row);
  }
  return map;
}

/** 商品×本数 → 段ボール（サイズ）。段ボール対応表から引く */
function findCartonSize(db, productId, quantity) {
  const rule = db
    .prepare('SELECT carton_size, box_name FROM carton_rules WHERE product_id = ? AND quantity = ?')
    .get(productId, quantity);
  return rule ?? null;
}

/**
 * ゆうパック出荷予定データCSV。
 * 同じ受注番号は複数明細でも荷物1件として1行にする（GAS版と同じ）。
 *
 * @returns {{csv:string, encoding:'Shift_JIS', count:number, unresolved:Array, filename:string}}
 */
function exportYuPack(filter = {}) {
  const db = getConnection();
  const orders = fetchOrders(db, filter);
  const grouped = groupByOrderNo(orders);

  const rows = [];
  const unresolved = [];

  for (const [orderNo, lines] of grouped) {
    const head = lines[0];
    const parsed = parseShippingAddress(head.delivery_address || head.customer_address || '');
    if (parsed.unresolved) {
      unresolved.push({ orderNo, raw: head.delivery_address || head.customer_address || '' });
    }

    // 宛名が取れない場合は得意先名を法人名として使う
    const recipientName = parsed.name || '';
    const recipientCorp = parsed.name ? '' : head.customer_name;

    // 配達希望日（納入希望日をYYYYMMDDに）
    const desiredDate = head.requested_delivery_on
      ? head.requested_delivery_on.replace(/-/g, '')
      : '';

    // 箱サイズ（送料計算と同じ対応表を使う）
    const rule = findCartonSize(db, head.product_id, head.quantity);
    const size = rule ? String(rule.carton_size).padStart(3, '0') : '';

    const row = new Array(72).fill('');
    row[0] = YUPACK_DEFAULTS.product;        // 1 商品
    row[1] = YUPACK_DEFAULTS.paymentType;    // 2 着払/代引
    row[6] = '1';                            // 7 作成数
    row[7] = recipientName;                  // 8 お届け先のお名前
    row[8] = '様';                           // 9 敬称
    row[10] = parsed.zip;                    // 11 郵便番号
    row[11] = parsed.prefecture;             // 12 都道府県
    row[12] = parsed.city;                   // 13 市区町村郡
    row[13] = parsed.address;                // 14 丁目番地号
    row[14] = parsed.building;               // 15 建物名
    row[15] = parsed.phone;                  // 16 電話番号
    row[16] = recipientCorp;                 // 17 法人名
    row[22] = '';                            // 23 ご依頼主のお名前（法人名を使うため空欄）
    row[25] = SENDER_INFO.zip;               // 26 ご依頼主の郵便番号
    row[26] = SENDER_INFO.prefecture;        // 27 ご依頼主の都道府県
    row[27] = SENDER_INFO.city;              // 28 ご依頼主の市区町村郡
    row[28] = SENDER_INFO.address;           // 29 ご依頼主の丁目番地号
    row[29] = SENDER_INFO.building;          // 30 ご依頼主の建物名
    row[30] = SENDER_INFO.phone;             // 31 ご依頼主の電話番号
    row[31] = SENDER_INFO.corporateName;     // 32 ご依頼主の法人名
    row[32] = SENDER_INFO.department;        // 33 ご依頼主の部署名
    row[34] = YUPACK_DEFAULTS.goodsName;     // 35 品名
    row[36] = '1';                           // 37 個数
    row[38] = '0';                           // 39 発送予定時間帯
    row[39] = '0';                           // 40 セキュリティ
    row[42] = '0';                           // 43 保冷
    row[45] = YUPACK_DEFAULTS.fragileBottle; // 46 取扱上の注意 ビン類
    row[50] = '0';                           // 51 差出予定時間帯
    row[51] = desiredDate;                   // 52 配達希望日
    row[52] = '00';                          // 53 配達希望時間帯（希望なし）
    row[60] = '0';                           // 61 お支払方法（通常払い）
    row[62] = size;                          // 63 サイズ
    row[63] = '0';                           // 64 差出方法（集荷）
    row[64] = YUPACK_DEFAULTS.discount;      // 65 割引
    row[67] = '0';                           // 68 配達予定日通知
    row[68] = '0';                           // 69 配達完了通知
    row[69] = '0';                           // 70 不在持戻り通知
    row[70] = '0';                           // 71 郵便局留通知
    row[71] = '0';                           // 72 配達完了通知(依頼主)

    rows.push(buildCsvRow(row));
  }

  return {
    csv: rows.join('\r\n'),      // ヘッダー行なし
    encoding: 'Shift_JIS',
    count: rows.length,
    unresolved,
    filename: `yupack_${stamp()}.csv`,
  };
}

// マネーフォワード 納品書CSV
const MF_CSV_TYPE = '40202';
const MF_MAX_ITEMS = 7; // 横型明細は最大7品目

const MF_HEADERS_BASE = [
  'csv_type(変更不可)', '取引先名称', '件名', '納品日', '納品書番号', 'メモ', 'タグ',
  '小計', '消費税', '合計金額', '取引先敬称', '取引先郵便番号', '取引先都道府県',
  '取引先住所1', '取引先住所2', '取引先部署', '取引先担当者役職', '取引先担当者氏名',
  '自社担当者氏名', '備考', '納品ステータス', 'メール送信ステータス', '郵送ステータス', 'ダウンロードステータス',
];
const MF_HEADERS_ITEM = ['品名', '品目コード', '単価', '数量', '単位', '詳細', '金額', '品目消費税率'];

function exportMoneyForward(filter = {}) {
  const db = getConnection();
  const orders = fetchOrders(db, filter);
  const grouped = groupByOrderNo(orders);

  let headerRow = [...MF_HEADERS_BASE];
  for (let n = 0; n < MF_MAX_ITEMS; n += 1) headerRow = headerRow.concat(MF_HEADERS_ITEM);

  const rows = [buildCsvRow(headerRow)];
  const overflow = []; // 8品目以上あり、収まりきらなかった受注

  for (const [orderNo, lines] of grouped) {
    const head = lines[0];
    const parsed = parseShippingAddress(head.delivery_address || head.customer_address || '');

    const items = lines.map((l) => ({
      name: l.product_name,
      // 単価×掛け率を四捨五入（GAS版と同じ）
      unitPrice: Math.round((l.unit_price ?? 0) * (l.markup_rate ?? 1)),
      qty: l.quantity ?? 0,
      amount: l.sales_amount ?? 0,
    }));
    // 送料は受注単位（1行目にだけ載せている）
    const shipping = lines.reduce((sum, l) => sum + (l.shipping_fee ?? 0), 0);

    const subtotal = items.reduce((sum, it) => sum + it.amount, 0) + shipping;
    const tax = Math.round(subtotal * 0.1);
    const total = subtotal + tax;

    const deliveryDateStr = head.delivered_on ? head.delivered_on.replace(/-/g, '/') : '';

    let row = [
      MF_CSV_TYPE,
      head.customer_name,
      '',                 // 件名
      deliveryDateStr,
      orderNo,            // 納品書番号
      '',                 // メモ
      '',                 // タグ
      subtotal,
      tax,
      total,
      '御中',             // 取引先敬称
      parsed.zip,
      parsed.prefecture,
      parsed.city + parsed.address,
      parsed.building,
      '',                 // 取引先部署
      '',                 // 担当者役職
      parsed.name,        // 担当者氏名
      '',                 // 自社担当者氏名
      head.note ?? '',
      '', '', '', '',     // 各ステータス
    ];

    if (items.length > MF_MAX_ITEMS) {
      overflow.push({ orderNo, itemCount: items.length });
    }

    // 送料も1明細として加える（7品目の枠内に収まる場合のみ）
    const itemsForCsv = items.slice(0, MF_MAX_ITEMS);
    if (shipping > 0 && itemsForCsv.length < MF_MAX_ITEMS) {
      itemsForCsv.push({ name: '送料', unitPrice: shipping, qty: 1, amount: shipping });
    }

    for (let n = 0; n < MF_MAX_ITEMS; n += 1) {
      const item = itemsForCsv[n];
      row = item
        ? row.concat([item.name, '', item.unitPrice, item.qty, '本', '', item.amount, '10%'])
        : row.concat(['', '', '', '', '', '', '', '']);
    }

    rows.push(buildCsvRow(row));
  }

  return {
    csv: `\uFEFF${rows.join('\r\n')}`, // UTF-8 BOM付き
    encoding: 'UTF-8',
    count: rows.length - 1,
    overflow,
    filename: `moneyforward_${stamp()}.csv`,
  };
}

/** ファイル名に付ける yyyyMMdd_HHmm */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

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
