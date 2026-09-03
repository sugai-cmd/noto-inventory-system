// 営業メモ（GAS版 README 3章 マスター登録「営業管理」）。
// 得意先ごとに、日付つきのログとして追記していく。上書きはしない。

const { getConnection } = require('../db/connection');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const { today } = require('../utils/dateUtil');

function list(customerId, { limit = 100 } = {}) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT n.*, u.display_name AS created_by_name
       FROM customer_notes n
       LEFT JOIN users u ON u.id = n.created_by
       WHERE n.customer_id = ?
       ORDER BY n.noted_on DESC, n.id DESC
       LIMIT ?`
    )
    .all(customerId, limit);
}

function add({ customerId, notedOn, category, body }, actor = null) {
  const db = getConnection();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new NotFoundError(`得意先が見つかりません (id=${customerId})`);
  if (!body || !String(body).trim()) throw new BusinessRuleError('メモの内容を入力してください');

  const result = db
    .prepare(
      `INSERT INTO customer_notes (customer_id, noted_on, category, body, created_by)
       VALUES (@customerId, @notedOn, @category, @body, @createdBy)`
    )
    .run({
      customerId,
      notedOn: notedOn ?? today(),
      category: category?.trim() || 'メモ',
      body: String(body).trim(),
      createdBy: actor?.id ?? null,
    });

  return db.prepare('SELECT * FROM customer_notes WHERE id = ?').get(result.lastInsertRowid);
}

function remove(id) {
  const db = getConnection();
  return db.prepare('DELETE FROM customer_notes WHERE id = ?').run(id).changes > 0;
}

module.exports = { list, add, remove };
