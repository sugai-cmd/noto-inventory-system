// 受注リスト（orders）の読み取り系クエリ

const { getConnection } = require('../db/connection');

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

function list({
  status,
  customerId,
  productId,
  from,
  to,
  dateField = 'ordered_on',
  limit = 200,
  offset = 0,
  sort = DEFAULT_SORT,
  order = 'desc',
} = {}) {
  const db = getConnection();
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

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const column = SORTABLE[sort] ?? SORTABLE[DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 同じ値のときの並びが実行のたびに変わらないよう、受注番号を第2キーにする
  const orderSql = `${column} ${direction}, o.order_no ${direction}`;

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products  p ON p.id = o.product_id
       ${whereSql}`
    )
    .get(params);

  const rows = db
    .prepare(
      `${SELECT_WITH_NAMES} ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return { rows, total };
}

module.exports = { findById, findByOrderNo, list, SORTABLE, DATE_FIELDS };
