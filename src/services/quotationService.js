// 見積管理（シート「見積済み」相当）。
//
// GAS側には見積の関数が無く、シートに手入力する運用だった。
// 金額（売価・1本あたり利益額・取引金額・取引利益）はシートの計算列と同じ式で
// v_quotations が出すので、保存するのは入力値だけにしている。

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

const STATUSES = ['見積中', '受注', '失注'];

function list({ status, customerId, from, to, limit = 300 } = {}) {
  const db = getConnection();
  const where = [];
  const params = { limit };

  if (status) { where.push('status = @status'); params.status = status; }
  if (customerId) { where.push('customer_id = @customerId'); params.customerId = customerId; }
  if (from) { where.push('quoted_on >= @from'); params.from = from; }
  if (to) { where.push('quoted_on <= @to'); params.to = to; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM v_quotations ${whereSql} ORDER BY quoted_on DESC, id DESC LIMIT @limit`)
    .all(params);
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM v_quotations WHERE id = ?').get(id);
}

/** 見積中の合計と、確度をかけた見込み額 */
function summary({ from, to } = {}) {
  const db = getConnection();
  const where = ["status = '見積中'"];
  const params = {};
  if (from) { where.push('quoted_on >= @from'); params.from = from; }
  if (to) { where.push('quoted_on <= @to'); params.to = to; }

  const row = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(deal_amount), 0)     AS total_amount,
              COALESCE(SUM(deal_profit), 0)     AS total_profit,
              COALESCE(SUM(weighted_amount), 0) AS weighted_amount
       FROM v_quotations WHERE ${where.join(' AND ')}`
    )
    .get(params);
  return row;
}

function create(input, actor = null) {
  const db = getConnection();

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId);
  if (!customer) throw new NotFoundError(`得意先が見つかりません (id=${input.customerId})`);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
  if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);
  if (!(input.quantity > 0)) throw new BusinessRuleError('個数は1以上で入力してください');

  // 単価と掛け率は登録時点のマスタ値をスナップショットする（受注と同じ考え方）
  const unitPrice = input.unitPrice ?? product.list_price ?? 0;
  const markupRate = input.markupRate ?? customer.markup_rate ?? 1;

  const result = db
    .prepare(
      `INSERT INTO quotations
         (uid, quoted_on, customer_id, product_id, quantity, unit_price, cost_price,
          markup_rate, probability, delivery_due_on, status, note, created_by)
       VALUES
         (@uid, @quotedOn, @customerId, @productId, @quantity, @unitPrice, @costPrice,
          @markupRate, @probability, @deliveryDueOn, @status, @note, @createdBy)`
    )
    .run({
      uid: generateUid(db, 'quotations'),
      quotedOn: input.quotedOn,
      customerId: input.customerId,
      productId: input.productId,
      quantity: input.quantity,
      unitPrice,
      costPrice: input.costPrice ?? null,
      markupRate,
      probability: input.probability ?? null,
      deliveryDueOn: input.deliveryDueOn ?? null,
      status: input.status ?? '見積中',
      note: input.note ?? null,
      createdBy: actor?.id ?? null,
    });

  const created = findById(result.lastInsertRowid);
  operationLogService.record({
    user: actor,
    action: 'quotation.create',
    targetType: 'quotations',
    targetId: created.id,
    summary: `見積を登録（${created.customer_name} / ${created.product_name} ${created.quantity}本・${created.deal_amount}円）`,
  });
  return created;
}

function update(id, input, actor = null) {
  const db = getConnection();
  if (!findById(id)) return null;

  db.prepare(
    `UPDATE quotations SET
       quoted_on       = COALESCE(@quotedOn, quoted_on),
       customer_id     = COALESCE(@customerId, customer_id),
       product_id      = COALESCE(@productId, product_id),
       quantity        = COALESCE(@quantity, quantity),
       unit_price      = COALESCE(@unitPrice, unit_price),
       cost_price      = COALESCE(@costPrice, cost_price),
       markup_rate     = COALESCE(@markupRate, markup_rate),
       probability     = COALESCE(@probability, probability),
       delivery_due_on = COALESCE(@deliveryDueOn, delivery_due_on),
       status          = COALESCE(@status, status),
       order_no        = COALESCE(@orderNo, order_no),
       note            = COALESCE(@note, note),
       updated_at      = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    quotedOn: input.quotedOn ?? null,
    customerId: input.customerId ?? null,
    productId: input.productId ?? null,
    quantity: input.quantity ?? null,
    unitPrice: input.unitPrice ?? null,
    costPrice: input.costPrice ?? null,
    markupRate: input.markupRate ?? null,
    probability: input.probability ?? null,
    deliveryDueOn: input.deliveryDueOn ?? null,
    status: input.status ?? null,
    orderNo: input.orderNo ?? null,
    note: input.note ?? null,
  });

  const updated = findById(id);
  operationLogService.record({
    user: actor,
    action: 'quotation.update',
    targetType: 'quotations',
    targetId: id,
    summary: `見積を更新（${updated.customer_name} / ${updated.product_name}・${updated.status}）`,
  });
  return updated;
}

function remove(id) {
  const db = getConnection();
  return db.prepare('DELETE FROM quotations WHERE id = ?').run(id).changes > 0;
}

module.exports = { STATUSES, list, findById, summary, create, update, remove };
