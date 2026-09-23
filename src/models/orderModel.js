// 受注リスト（orders）の読み取り系クエリ

const { getConnection } = require('../db/connection');
// 消費税率は送料の計算と同じ値を使う（2か所に書くと改定のときに片方だけ残る）
const { TAX_RATE } = require('../services/shippingFeeService');

const SELECT_WITH_NAMES = `
  SELECT o.*, c.name AS customer_name, p.name AS product_name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN products  p ON p.id = o.product_id
`;

function findById(id) {
  const db = getConnection();
  return db.prepare(`${SELECT_WITH_NAMES} WHERE o.id = ?`).get(id);
}

function findByOrderNo(orderNo) {
  const db = getConnection();
  return db.prepare(`${SELECT_WITH_NAMES} WHERE o.order_no = ?`).get(orderNo);
}

/**
 * 並べ替えに使ってよい列。
 *
 * 画面から来た文字列をそのままSQLに入れると、何でも実行できてしまう。
 * ここに載っている名前だけを通し、それ以外は既定に落とす
 * （ledgerCancelService.SORTABLE / materialService.LEDGER_SORTABLE と同じ作法）。
 */
const SORTABLE = {
  ordered_on: 'o.ordered_on',
  order_no: 'o.order_no',
  customer_name: 'c.name',
  product_name: 'p.name',
  quantity: 'o.quantity',
  total_amount: 'o.total_amount',
  status: 'o.status',
  delivered_on: 'o.delivered_on',
  payment_due_on: 'o.payment_due_on',
};
const DEFAULT_SORT = 'ordered_on';

/**
 * 受注の一覧。
 *
 * **以前は offset も総件数も無く、ORDER BY も固定だった。**
 * 実データ117件でまだ既定200には当たっていないが、増え続けるので同じ形に揃える。
 *
 * 絞り込み: ステータス / 得意先 / 商品 / 受注日・納品日・入金予定日の範囲。
 * 日付は3種類あるので、どの日付で絞るかを `dateField` で選ぶ
 * （from/to を3組に増やすと画面もAPIも読みにくくなる）。
 *
 * @returns {{rows: object[], total: number}} total は同じ絞り込みでの全件数
 */
const DATE_FIELDS = {
  ordered_on: 'o.ordered_on',
  delivered_on: 'o.delivered_on',
  payment_due_on: 'o.payment_due_on',
};

const FROM_JOINS = `
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN products  p ON p.id = o.product_id
`;

/**
 * 絞り込みの WHERE を組み立てる。
 *
 * **1か所にまとめてある。** 一覧の本体・件数・合計の3つが同じ条件を使うので、
 * 別々に書くと必ずずれる（絞り込んだ一覧と合計が食い違って見える）。
 */
function buildFilter({ status, customerId, productId, from, to, dateField = 'ordered_on' } = {}) {
  const where = [];
  const params = {};

  if (status) {
    where.push('o.status = @status');
    params.status = status;
  }
  if (customerId) {
    where.push('o.customer_id = @customerId');
    params.customerId = customerId;
  }
  if (productId) {
    where.push('o.product_id = @productId');
    params.productId = productId;
  }

  // 絞る日付の列も許可リスト経由。知らない名前が来たら受注日に落とす
  const dateColumn = DATE_FIELDS[dateField] ?? DATE_FIELDS.ordered_on;
  if (from) {
    where.push(`${dateColumn} >= @from`);
    params.from = from;
  }
  if (to) {
    where.push(`${dateColumn} <= @to`);
    params.to = to;
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function list({
  limit = 200,
  offset = 0,
  sort = DEFAULT_SORT,
  order = 'desc',
  ...filters
} = {}) {
  const db = getConnection();
  const { whereSql, params } = buildFilter(filters);

  const column = SORTABLE[sort] ?? SORTABLE[DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 同じ値のときの並びが実行のたびに変わらないよう、受注番号を第2キーにする
  const orderSql = `${column} ${direction}, o.order_no ${direction}`;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total ${FROM_JOINS} ${whereSql}`)
    .get(params);

  const rows = db
    .prepare(
      `${SELECT_WITH_NAMES} ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return { rows, total };
}

/**
 * 絞り込んだ結果の合計。**一覧のページ送りとは関係なく、条件に当たる全部を足す。**
 *
 * 画面に出ている行を足しても答えにならないので、サーバーで出す。
 *
 * **保存されている合計欄（total_amount）は読まない。** 式が揃っていないため。
 *   移行データ103件 … 売価 × 1.1（送料を含んでいない）
 *   移行データ  14件 … (売価 + 送料) × 1.1
 *   いまのコード      … 売価 + 送料（税を足さない。orderService.submitOrder）
 * 足すと何の数字か言えなくなるので、売価と送料から出し直す。
 *
 * **消費税は売価にだけ掛ける。** 送料は #54 以降、税込・50円繰り上げ後の金額が入っている。
 * 丸めは合計に対して一度だけなので、受注ごとに丸めて足したものとは数円ずれうる。
 *
 * @returns {{orders:number, lines:number, quantity:number, salesAmount:number,
 *            salesTax:number, shippingFee:number, total:number}}
 */
function summary(filters = {}) {
  const db = getConnection();
  const { whereSql, params } = buildFilter(filters);

  const row = db
    .prepare(
      `SELECT COUNT(*)                         AS lines,
              COUNT(DISTINCT o.order_no)       AS orders,
              COALESCE(SUM(o.quantity), 0)     AS quantity,
              COALESCE(SUM(o.sales_amount), 0) AS salesAmount,
              COALESCE(SUM(o.shipping_fee), 0) AS shippingFee
       ${FROM_JOINS} ${whereSql}`
    )
    .get(params);

  const salesTax = Math.round(row.salesAmount * TAX_RATE);
  return { ...row, salesTax, total: row.salesAmount + salesTax + row.shippingFee };
}

module.exports = { findById, findByOrderNo, list, summary, buildFilter, SORTABLE, DATE_FIELDS };
