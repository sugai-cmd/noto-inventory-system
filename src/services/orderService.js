// 受注まわりの業務ロジック（旧GASの submitOrder / markOrderAsShipped 相当）。

const { getConnection } = require('../db/connection');
const orderModel = require('../models/orderModel');
const { nextOrderNo, nextProductHistoryCode } = require('../utils/codeGenerator');
const { calcPaymentDueOn, today } = require('../utils/dateUtil');
const { NotFoundError, ConflictError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

/**
 * 受注登録画面の初期値を返す（DB_SCHEMA_DESIGN.md 2.3）。
 * 得意先の掛率・商品の上代・支払いサイトから請求関連日付を先に計算して画面に出す。
 * ここで返す値はあくまで初期表示用で、確定値は登録時にordersへスナップショット保存する。
 */
function getOrderDefaults({ customerId, productId, quantity, deliveredOn }) {
  const db = getConnection();

  const customer = customerId
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId)
    : null;
  const product = productId
    ? db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    : null;

  const unitPrice = product?.list_price ?? null;
  const markupRate = customer?.markup_rate ?? null;
  const qty = Number.isFinite(Number(quantity)) ? Number(quantity) : null;

  const salesAmount =
    unitPrice != null && markupRate != null && qty != null
      ? Math.round(unitPrice * qty * markupRate)
      : null;

  // 入金予定日は「納品日＋支払いサイト」。納品日未定の段階では受注日を仮の起点にする。
  const dueBase = deliveredOn || today();
  const paymentDueOn = customer
    ? calcPaymentDueOn(dueBase, customer.payment_term_months, customer.payment_term_day)
    : null;

  return {
    unitPrice,
    markupRate,
    salesAmount,
    paymentDueOn,
    // 請求日は「請求日送付期日」が自由記述のため自動確定できない。
    // 画面にヒントとして出すための素材だけ返す。
    invoiceDueNote: customer?.invoice_due_note ?? null,
    customer,
    product,
  };
}

/**
 * 受注登録。単価・掛け率は登録時点のマスタ値をスナップショットとして保存する
 * （後からマスタが変わっても過去の受注金額が変わらないようにするため）。
 */
function submitOrder(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId);
    if (!customer) throw new NotFoundError(`得意先が見つかりません (id=${input.customerId})`);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    const unitPrice = input.unitPrice ?? product.list_price ?? 0;
    const markupRate = input.markupRate ?? customer.markup_rate ?? 1;
    const salesAmount = input.salesAmount ?? Math.round(unitPrice * input.quantity * markupRate);
    const shippingFee = input.shippingFee ?? 0;
    const totalAmount = input.totalAmount ?? salesAmount + shippingFee;

    const orderNo = input.orderNo ?? nextOrderNo(db, input.orderedOn);

    const result = db
      .prepare(
        `INSERT INTO orders
           (order_no, ordered_on, customer_id, product_id, quantity, unit_price, markup_rate,
            sales_amount, shipping_fee, total_amount, requested_delivery_on, invoiced_on,
            payment_due_on, paid_on, sales_method, delivery_method, status, delivery_address,
            delivered_on, note, created_by)
         VALUES
           (@orderNo, @orderedOn, @customerId, @productId, @quantity, @unitPrice, @markupRate,
            @salesAmount, @shippingFee, @totalAmount, @requestedDeliveryOn, @invoicedOn,
            @paymentDueOn, @paidOn, @salesMethod, @deliveryMethod, @status, @deliveryAddress,
            @deliveredOn, @note, @createdBy)`
      )
      .run({
        orderNo,
        orderedOn: input.orderedOn,
        customerId: input.customerId,
        productId: input.productId,
        quantity: input.quantity,
        unitPrice,
        markupRate,
        salesAmount,
        shippingFee,
        totalAmount,
        requestedDeliveryOn: input.requestedDeliveryOn ?? null,
        invoicedOn: input.invoicedOn ?? null,
        paymentDueOn: input.paymentDueOn ?? null,
        paidOn: null,
        salesMethod: input.salesMethod ?? null,
        deliveryMethod: input.deliveryMethod ?? null,
        status: input.status ?? '未着手',
        deliveryAddress: input.deliveryAddress ?? null,
        deliveredOn: null,
        note: input.note ?? null,
        createdBy: actor?.id ?? null,
      });

    const order = orderModel.findById(result.lastInsertRowid);
    operationLogService.record({
      user: actor,
      action: 'order.create',
      targetType: 'orders',
      targetId: order.id,
      summary: `受注 ${order.order_no} を登録（${order.customer_name} / ${order.product_name} ${order.quantity}本）`,
    });
    return order;
  });

  return run();
}

/**
 * 「発送済にする」（旧 markOrderAsShipped）。
 * 受注のステータス・納品日・入金予定日を更新し、同一トランザクション内で
 * 商品在庫変動履歴に出荷行を追加する（DATA_STRUCTURE.md 5章）。
 * order_id を必ずセットするので、6-3で課題だった受注との突合が新規データでは常に成立する。
 */
function markOrderAsShipped(orderId, { deliveredOn, note } = {}, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const order = orderModel.findById(orderId);
    if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);
    if (order.status === '発送済') {
      throw new ConflictError(`受注 ${order.order_no} は既に発送済です`);
    }

    const shippedOn = deliveredOn ?? today();
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);

    const paymentDueOn = calcPaymentDueOn(
      shippedOn,
      customer?.payment_term_months,
      customer?.payment_term_day
    );

    db.prepare(
      `UPDATE orders
       SET status = '発送済', delivered_on = @deliveredOn,
           payment_due_on = COALESCE(@paymentDueOn, payment_due_on),
           updated_at = datetime('now')
       WHERE id = @id`
    ).run({ id: orderId, deliveredOn: shippedOn, paymentDueOn });

    const ledgerResult = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity, counterparty, order_id,
            volume_ml, tax_amount, storage_place, data_kind, note, created_by)
         VALUES
           (@historyCode, @txnDate, @productId, '出荷', @quantity, @counterparty, @orderId,
            @volumeMl, @taxAmount, @storagePlace, '運用中（リアルタイム）', @note, @createdBy)`
      )
      .run({
        historyCode: nextProductHistoryCode(db, shippedOn),
        txnDate: shippedOn,
        productId: order.product_id,
        quantity: order.quantity,
        counterparty: customer?.name ?? null,
        orderId,
        volumeMl: product?.volume_ml != null ? product.volume_ml * order.quantity : null,
        taxAmount: product?.tax_per_unit != null ? product.tax_per_unit * order.quantity : null,
        storagePlace: '浄溜所',
        note: note ?? null,
        createdBy: actor?.id ?? null,
      });

    operationLogService.record({
      user: actor,
      action: 'order.ship',
      targetType: 'orders',
      targetId: orderId,
      summary: `受注 ${order.order_no} を発送済にした（${order.product_name} ${order.quantity}本を出荷）`,
    });

    return {
      order: orderModel.findById(orderId),
      stockLedgerId: ledgerResult.lastInsertRowid,
    };
  });

  return run();
}

/** 請求日を記録する（旧 markInvoiceSent） */
function markInvoiceSent(orderId, { invoicedOn } = {}) {
  const db = getConnection();
  const order = orderModel.findById(orderId);
  if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);

  db.prepare(
    `UPDATE orders SET invoiced_on = @invoicedOn, updated_at = datetime('now') WHERE id = @id`
  ).run({ id: orderId, invoicedOn: invoicedOn ?? today() });

  return orderModel.findById(orderId);
}

/** 入金日を記録する */
function markPaid(orderId, { paidOn } = {}) {
  const db = getConnection();
  const order = orderModel.findById(orderId);
  if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);

  db.prepare(
    `UPDATE orders SET paid_on = @paidOn, updated_at = datetime('now') WHERE id = @id`
  ).run({ id: orderId, paidOn: paidOn ?? today() });

  return orderModel.findById(orderId);
}

/**
 * 請求日の一括記録（旧 markInvoicesSent）。
 * 月末の請求書送付時に、対象の受注をまとめて処理するためのもの。
 * 1件ずつの成否を返すので、一部だけ失敗しても何が処理されたか分かる。
 */
function markInvoicesSent(orderIds, { invoicedOn } = {}, actor = null) {
  const db = getConnection();
  const date = invoicedOn ?? today();

  const run = db.transaction(() => {
    const updated = [];
    const skipped = [];

    const stmt = db.prepare(
      `UPDATE orders SET invoiced_on = @invoicedOn, updated_at = datetime('now')
       WHERE id = @id`
    );

    for (const id of orderIds) {
      const order = orderModel.findById(id);
      if (!order) {
        skipped.push({ id, reason: '受注が見つかりません' });
        continue;
      }
      if (order.invoiced_on) {
        skipped.push({ id, orderNo: order.order_no, reason: `既に請求済み（${order.invoiced_on}）` });
        continue;
      }
      stmt.run({ id, invoicedOn: date });
      updated.push({ id, orderNo: order.order_no });
    }

    operationLogService.record({
      user: actor,
      action: 'order.invoice.bulk',
      targetType: 'orders',
      summary: `請求日を一括記録（${date}／${updated.length}件処理・${skipped.length}件スキップ）`,
      detail: { updated, skipped },
    });

    return { invoicedOn: date, updated, skipped };
  });

  return run();
}

/**
 * 請求対象の候補を返す。
 * 納品済みで、まだ請求日が入っていない受注（＝請求書を出すべきもの）。
 */
function listPendingInvoices({ to } = {}) {
  const db = getConnection();
  const where = ['o.delivered_on IS NOT NULL', 'o.invoiced_on IS NULL'];
  const params = {};
  if (to) { where.push('o.delivered_on <= @to'); params.to = to; }

  return db
    .prepare(
      `SELECT o.*, c.name AS customer_name, c.invoice_due_note, p.name AS product_name
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products p ON p.id = o.product_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.name, o.delivered_on`
    )
    .all(params);
}

module.exports = {
  getOrderDefaults,
  submitOrder,
  markOrderAsShipped,
  markInvoiceSent,
  markInvoicesSent,
  listPendingInvoices,
  markPaid,
};
