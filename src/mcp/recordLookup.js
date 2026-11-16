// 音声入力のコネクタ（MCP）で使う、得意先・商品・資材などの名前解決。
//
// 話し言葉では「〇〇酒店」「池月300」のように名前で言うので、IDに直してからサービスへ渡す。
// やり方はタンク（tankLookup.resolveTank）と同じ：
//   数値 → ID、文字列 → コードか名前の完全一致 → 全角半角・空白・大小を無視した一致。
// **1つに決まらないときは登録せず候補を返す。** 似た名前の相手に黙って登録すると、
// 請求や在庫がずれたまま気づけない。

const { normalizeName } = require('../utils/normalizeName');
const { McpInputError } = require('./tankLookup');

function looseKey(value) {
  return normalizeName(String(value)).replace(/\s/g, '').toLowerCase();
}

/**
 * マスタの種類ごとの決まり。
 *   where    … 選べる行（取消・廃棄したものを除くなど）
 *   describe … 候補として見せる項目
 */
const MASTERS = {
  customers: {
    label: '得意先',
    sql: `SELECT c.*, p.name AS parent_name FROM customers c LEFT JOIN customers p ON p.id = c.parent_id`,
    describe: (r) => ({ id: r.id, code: r.code, name: r.name, parent: r.parent_name ?? undefined }),
  },
  products: {
    label: '商品',
    sql: 'SELECT * FROM products',
    describe: (r) => ({ id: r.id, code: r.code, name: r.name, volumeMl: r.volume_ml ?? undefined }),
  },
  materials: {
    label: '資材',
    sql: 'SELECT * FROM materials',
    describe: (r) => ({ id: r.id, code: r.code, name: r.name, category: r.category ?? undefined }),
  },
  breweries: {
    label: '酒蔵',
    sql: 'SELECT * FROM breweries',
    describe: (r) => ({ id: r.id, code: r.code, name: r.name }),
  },
  raw_sake_brands: {
    label: '原酒銘柄',
    // 銘柄名は同じ名前の別ロットがあるので一意ではない。そのときは原酒ID（code）で選んでもらう
    sql: 'SELECT * FROM raw_sake_brands',
    describe: (r) => ({ id: r.id, code: r.code, name: r.name, abv: r.abv ?? undefined }),
  },
};

/**
 * @param {'customers'|'products'|'materials'|'breweries'|'raw_sake_brands'} type
 * @param {number|string} ref
 * @param {string} [label] - エラー文に出す呼び名（無ければマスタの名前）
 */
function resolveRecord(db, type, ref, label) {
  const m = MASTERS[type];
  const name = label ?? m.label;
  if (typeof ref === 'number') {
    const row = db.prepare(`SELECT * FROM (${m.sql}) WHERE id = ?`).get(ref);
    if (!row) throw new McpInputError(`${name}が見つかりません (id=${ref})`, { code: 'not_found' });
    return row;
  }

  const rows = db.prepare(m.sql).all();
  const exact = rows.filter((r) => r.code === ref || r.name === ref);
  const key = looseKey(ref);
  const loose = rows.filter((r) => (r.code && looseKey(r.code) === key) || looseKey(r.name) === key);
  const matches = exact.length ? exact : loose;
  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    throw new McpInputError(`${name}「${ref}」に当てはまるものが複数あります。どれか指定してください`, {
      code: 'ambiguous',
      candidates: matches.map(m.describe),
    });
  }
  const partial = rows.filter((r) => looseKey(r.name).includes(key) || (r.code && looseKey(r.code).includes(key)));
  throw new McpInputError(`${name}「${ref}」が見つかりません`, {
    code: 'not_found',
    candidates: partial.slice(0, 10).map(m.describe),
  });
}

/** 名前・コードの部分一致で探す（読み取りツール用） */
function searchRecords(db, type, query, limit = 20) {
  const m = MASTERS[type];
  const rows = db.prepare(m.sql).all();
  if (!query) return rows.slice(0, limit).map(m.describe);
  const key = looseKey(query);
  return rows
    .filter((r) => looseKey(r.name).includes(key) || (r.code && looseKey(r.code).includes(key)))
    .slice(0, limit)
    .map(m.describe);
}

function describeOrderLine(r) {
  return {
    id: r.id,
    orderNo: r.order_no,
    lineNo: r.line_no,
    orderedOn: r.ordered_on,
    customer: r.customer_name,
    product: r.product_name,
    quantity: r.quantity,
    status: r.status,
    salesMethod: r.sales_method,
  };
}

const ORDER_SQL = `SELECT o.*, c.name AS customer_name, p.name AS product_name
                     FROM orders o
                     LEFT JOIN customers c ON c.id = o.customer_id
                     LEFT JOIN products p ON p.id = o.product_id`;

/**
 * 受注の1行（明細）を決める。
 * 受注番号は複数の明細を持つことがあるので、番号だけで決まらなければ行番号か商品で絞る。
 *
 * @param {number|string} ref - 明細のID（数値）または受注番号
 * @param {object} [opts]
 * @param {number} [opts.lineNo]
 * @param {number} [opts.productId]
 */
function resolveOrderLine(db, ref, { lineNo, productId } = {}) {
  if (typeof ref === 'number') {
    const row = db.prepare(`${ORDER_SQL} WHERE o.id = ?`).get(ref);
    if (!row) throw new McpInputError(`受注が見つかりません (id=${ref})`, { code: 'not_found' });
    return row;
  }
  const orderNo = normalizeName(String(ref)).replace(/\s/g, '').toUpperCase();
  let rows = db.prepare(`${ORDER_SQL} WHERE upper(o.order_no) = ? ORDER BY o.line_no`).all(orderNo);
  if (!rows.length) throw new McpInputError(`受注番号「${ref}」が見つかりません`, { code: 'not_found' });
  if (lineNo != null) rows = rows.filter((r) => r.line_no === lineNo);
  if (productId != null) rows = rows.filter((r) => r.product_id === productId);
  if (rows.length === 1) return rows[0];
  throw new McpInputError(
    rows.length
      ? `受注番号「${ref}」には明細が複数あります。行番号（lineNo）か商品で指定してください`
      : `受注番号「${ref}」に当てはまる明細がありません`,
    { code: rows.length ? 'ambiguous' : 'not_found', candidates: db.prepare(`${ORDER_SQL} WHERE upper(o.order_no) = ? ORDER BY o.line_no`).all(orderNo).map(describeOrderLine) }
  );
}

/** 入金を入金番号（P…）かIDで決める */
function resolvePayment(db, ref) {
  const row =
    typeof ref === 'number'
      ? db.prepare('SELECT * FROM payments WHERE id = ?').get(ref)
      : db
          .prepare('SELECT * FROM payments WHERE upper(payment_no) = ?')
          .get(normalizeName(String(ref)).replace(/\s/g, '').toUpperCase());
  if (!row) throw new McpInputError(`入金「${ref}」が見つかりません`, { code: 'not_found' });
  return row;
}

/** 委託販売の報告を報告番号（C…）かIDで決める */
function resolveConsignmentReport(db, ref) {
  const row =
    typeof ref === 'number'
      ? db.prepare('SELECT * FROM consignment_reports WHERE id = ?').get(ref)
      : db
          .prepare('SELECT * FROM consignment_reports WHERE upper(report_no) = ?')
          .get(normalizeName(String(ref)).replace(/\s/g, '').toUpperCase());
  if (!row) throw new McpInputError(`委託販売の報告「${ref}」が見つかりません`, { code: 'not_found' });
  return row;
}

/**
 * 同じ名前（全角半角・空白を無視）がすでにあるか。マスタ登録の注意点に使う。
 * 画面は完全一致でしか重複を止めないので、「ほぼ同じ名前」はここで知らせる。
 */
function similarNames(db, table, name) {
  if (!name) return [];
  const key = looseKey(name);
  return db
    .prepare(`SELECT id, code, name FROM ${table}`)
    .all()
    .filter((r) => looseKey(r.name) === key);
}

module.exports = {
  resolveRecord,
  searchRecords,
  resolveOrderLine,
  describeOrderLine,
  resolvePayment,
  resolveConsignmentReport,
  similarNames,
  looseKey,
  ORDER_SQL,
};
