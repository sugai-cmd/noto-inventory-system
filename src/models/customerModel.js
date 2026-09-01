// 得意先マスタ（customers）

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { normalizeName } = require('../utils/normalizeName');

function list() {
  const db = getConnection();
  return db.prepare('SELECT * FROM customers ORDER BY name').all();
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

/**
 * 受注登録画面のインクリメンタル検索用（DB_SCHEMA_DESIGN.md 2.2）。
 * 得意先名・コード・担当者を対象に部分一致で絞り込む。
 * 表記ゆれに強くするため、名前は正規化した値同士で比較する。
 */
function search(query, limit = 20) {
  const db = getConnection();
  const q = normalizeName(query);
  if (!q) return db.prepare('SELECT * FROM customers ORDER BY name LIMIT ?').all(limit);

  const like = `%${q}%`;
  return db
    .prepare(
      `SELECT * FROM customers
       WHERE name LIKE ? OR code LIKE ? OR sales_rep LIKE ?
       ORDER BY
         CASE WHEN name LIKE ? THEN 0 ELSE 1 END,  -- 前方一致を優先
         name
       LIMIT ?`
    )
    .all(like, like, like, `${q}%`, limit);
}

function create(input) {
  const db = getConnection();
  const uid = generateUid(db, 'customers');
  const result = db
    .prepare(
      `INSERT INTO customers
         (uid, code, name, segment, business_type, markup_rate, address,
          payment_term_months, payment_term_day, invoice_due_note,
          sales_rep, sales_sub_rep, sales_channel, last_visited_on, onboarded_month, note)
       VALUES
         (@uid, @code, @name, @segment, @businessType, @markupRate, @address,
          @paymentTermMonths, @paymentTermDay, @invoiceDueNote,
          @salesRep, @salesSubRep, @salesChannel, @lastVisitedOn, @onboardedMonth, @note)`
    )
    .run({
      uid,
      code: input.code ?? null,
      name: input.name,
      segment: input.segment ?? null,
      businessType: input.businessType ?? null,
      markupRate: input.markupRate ?? 1,
      address: input.address ?? null,
      paymentTermMonths: input.paymentTermMonths ?? null,
      paymentTermDay: input.paymentTermDay ?? null,
      invoiceDueNote: input.invoiceDueNote ?? null,
      salesRep: input.salesRep ?? null,
      salesSubRep: input.salesSubRep ?? null,
      salesChannel: input.salesChannel ?? null,
      lastVisitedOn: input.lastVisitedOn ?? null,
      onboardedMonth: input.onboardedMonth ?? null,
      note: input.note ?? null,
    });
  return findById(result.lastInsertRowid);
}

function update(id, input) {
  const db = getConnection();
  if (!findById(id)) return null;

  db.prepare(
    `UPDATE customers SET
       code = COALESCE(@code, code),
       name = COALESCE(@name, name),
       segment = COALESCE(@segment, segment),
       business_type = COALESCE(@businessType, business_type),
       markup_rate = COALESCE(@markupRate, markup_rate),
       address = COALESCE(@address, address),
       payment_term_months = COALESCE(@paymentTermMonths, payment_term_months),
       payment_term_day = COALESCE(@paymentTermDay, payment_term_day),
       invoice_due_note = COALESCE(@invoiceDueNote, invoice_due_note),
       sales_rep = COALESCE(@salesRep, sales_rep),
       sales_sub_rep = COALESCE(@salesSubRep, sales_sub_rep),
       sales_channel = COALESCE(@salesChannel, sales_channel),
       last_visited_on = COALESCE(@lastVisitedOn, last_visited_on),
       onboarded_month = COALESCE(@onboardedMonth, onboarded_month),
       note = COALESCE(@note, note),
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    code: input.code ?? null,
    name: input.name ?? null,
    segment: input.segment ?? null,
    businessType: input.businessType ?? null,
    markupRate: input.markupRate ?? null,
    address: input.address ?? null,
    paymentTermMonths: input.paymentTermMonths ?? null,
    paymentTermDay: input.paymentTermDay ?? null,
    invoiceDueNote: input.invoiceDueNote ?? null,
    salesRep: input.salesRep ?? null,
    salesSubRep: input.salesSubRep ?? null,
    salesChannel: input.salesChannel ?? null,
    lastVisitedOn: input.lastVisitedOn ?? null,
    onboardedMonth: input.onboardedMonth ?? null,
    note: input.note ?? null,
  });
  return findById(id);
}

module.exports = { list, findById, search, create, update };
