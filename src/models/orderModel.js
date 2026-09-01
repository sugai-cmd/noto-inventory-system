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
 * 一覧。status / customerId / 受注日の範囲で絞り込める。
 */
function list({ status, customerId, from, to, limit = 200 } = {}) {
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
  if (from) {
    where.push('o.ordered_on >= @from');
    params.from = from;
  }
  if (to) {
    where.push('o.ordered_on <= @to');
    params.to = to;
  }
  params.limit = limit;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`${SELECT_WITH_NAMES} ${whereSql} ORDER BY o.ordered_on DESC, o.order_no DESC LIMIT @limit`)
    .all(params);
}

module.exports = { findById, findByOrderNo, list };
