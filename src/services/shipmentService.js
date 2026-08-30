// 受注以外の出荷・返品まわり
// （旧GASの submitProductReturn / submitSampleShipment / submitConsignmentReport 相当）。

const { getConnection } = require('../db/connection');
const { nextProductHistoryCode, nextSampleNo } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

/**
 * 返品。得意先から戻ってきた商品を在庫に戻す。
 * 受注に紐付けられる場合は order_id を入れて、どの出荷に対する返品かを追えるようにする。
 */
function submitProductReturn(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    let order = null;
    if (input.orderId) {
      order = db.prepare('SELECT * FROM orders WHERE id = ?').get(input.orderId);
      if (!order) throw new NotFoundError(`受注が見つかりません (id=${input.orderId})`);
      if (order.product_id !== input.productId) {
        throw new BusinessRuleError('返品する商品が、指定した受注の商品と一致しません');
      }
      if (input.quantity > order.quantity) {
        throw new BusinessRuleError(
          `返品数が受注数を超えています（受注 ${order.quantity}本 < 返品 ${input.quantity}本）`
        );
      }
    }

    const customer = input.customerId
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId)
      : order
        ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id)
        : null;

    const result = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity, counterparty, order_id,
            storage_place, data_kind, note, created_by)
         VALUES
           (@historyCode, @txnDate, @productId, '返品', @quantity, @counterparty, @orderId,
            @storagePlace, '運用中（リアルタイム）', @note, @createdBy)`
      )
      .run({
        historyCode: nextProductHistoryCode(db, txnDate),
        txnDate,
        productId: input.productId,
        quantity: input.quantity,
        counterparty: customer?.name ?? input.counterparty ?? null,
        orderId: input.orderId ?? null,
        storagePlace: input.storagePlace ?? '浄溜所',
        note: input.reason ?? input.note ?? null,
        createdBy: actor?.id ?? null,
      });

    const after = db
      .prepare('SELECT * FROM v_product_stock WHERE product_id = ?')
      .get(input.productId);

    operationLogService.record({
      user: actor,
      action: 'product.return',
      targetType: 'product_stock_ledger',
      targetId: result.lastInsertRowid,
      summary:
        `${product.name} ${input.quantity}本を返品として受入` +
        (customer ? `（${customer.name}）` : '') +
        (order ? ` / 受注 ${order.order_no}` : ''),
    });

    return { ledgerId: result.lastInsertRowid, product: { id: product.id, name: product.name }, after };
  });

  return run();
}

/**
 * サンプル・販促資料の送付（旧 submitSampleShipment）。
 * 送付記録と、それに対応する出荷履歴を同一トランザクションで作る。
 * 8-1で設計した sample_shipment_id により、両者は確実に紐付く。
 */
function submitSampleShipment(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const shippedOn = input.shippedOn ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    const customer = input.customerId
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId)
      : null;
    if (input.customerId && !customer) {
      throw new NotFoundError(`得意先が見つかりません (id=${input.customerId})`);
    }

    const sampleNo = nextSampleNo(db, shippedOn);
    const sampleResult = db
      .prepare(
        `INSERT INTO sample_shipments
           (sample_no, shipped_on, customer_id, contact_name, product_id, quantity,
            followup_on, phone, data_kind, note, created_by)
         VALUES
           (@sampleNo, @shippedOn, @customerId, @contactName, @productId, @quantity,
            @followupOn, @phone, '運用中（リアルタイム）', @note, @createdBy)`
      )
      .run({
        sampleNo,
        shippedOn,
        customerId: input.customerId ?? null,
        contactName: input.contactName ?? null,
        productId: input.productId,
        quantity: input.quantity,
        followupOn: input.followupOn ?? null,
        phone: input.phone ?? null,
        note: input.note ?? null,
        createdBy: actor?.id ?? null,
      });
    const sampleId = sampleResult.lastInsertRowid;

    // 在庫からも引く（無償でも出荷は出荷）
    const ledgerResult = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity, counterparty,
            sample_shipment_id, volume_ml, tax_amount, storage_place, data_kind, note, created_by)
         VALUES
           (@historyCode, @txnDate, @productId, '出荷', @quantity, @counterparty,
            @sampleShipmentId, @volumeMl, @taxAmount, @storagePlace,
            '運用中（リアルタイム）', @note, @createdBy)`
      )
      .run({
        historyCode: nextProductHistoryCode(db, shippedOn),
        txnDate: shippedOn,
        productId: input.productId,
        quantity: input.quantity,
        counterparty: customer?.name ?? input.customerName ?? null,
        sampleShipmentId: sampleId,
        volumeMl: product.volume_ml != null ? product.volume_ml * input.quantity : null,
        taxAmount: product.tax_per_unit != null ? product.tax_per_unit * input.quantity : null,
        storagePlace: '浄溜所',
        note: `サンプル送付 ${sampleNo}`,
        createdBy: actor?.id ?? null,
      });

    const after = db
      .prepare('SELECT * FROM v_product_stock WHERE product_id = ?')
      .get(input.productId);

    operationLogService.record({
      user: actor,
      action: 'sample.ship',
      targetType: 'sample_shipments',
      targetId: sampleId,
      summary: `サンプル ${sampleNo} を送付（${product.name} ${input.quantity}本${customer ? ` / ${customer.name}` : ''}）`,
    });

    return {
      sampleId,
      sampleNo,
      stockLedgerId: ledgerResult.lastInsertRowid,
      after,
    };
  });

  return run();
}

function listSampleShipments({ limit = 200 } = {}) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT s.*, c.name AS customer_name, p.name AS product_name
       FROM sample_shipments s
       LEFT JOIN customers c ON c.id = s.customer_id
       JOIN products p ON p.id = s.product_id
       ORDER BY s.shipped_on DESC, s.id DESC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * 委託販売実績報告（旧 submitConsignmentReport）。
 * 委託で出した分のうち、その月に実際に売れた本数を月次で転記する。
 *
 * 入金予定日は「転記月の月末」を自動設定する（DATA_STRUCTURE.md 4-4 K列）。
 */
function submitConsignmentReport(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(input.orderId);
    if (!order) throw new NotFoundError(`受注が見つかりません (id=${input.orderId})`);
    if (order.sales_method !== '委託') {
      throw new BusinessRuleError(
        `受注 ${order.order_no} は委託販売ではありません（販売方法: ${order.sales_method ?? '未設定'}）`
      );
    }

    const existing = db
      .prepare('SELECT id FROM consignment_reports WHERE order_id = ? AND report_month = ?')
      .get(input.orderId, input.reportMonth);
    if (existing) {
      throw new ConflictError(
        `受注 ${order.order_no} の ${input.reportMonth} 分は既に報告済みです`
      );
    }

    // 同じ受注の報告済み本数の合計が、受注本数を超えないようにする
    const reported = db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM consignment_reports WHERE order_id = ?')
      .get(input.orderId).total;
    if (reported + input.quantity > order.quantity) {
      throw new BusinessRuleError(
        `報告本数の合計が受注本数を超えます（受注 ${order.quantity}本 / 報告済 ${reported}本 / 今回 ${input.quantity}本）`
      );
    }

    const unitPrice = input.unitPrice ?? order.unit_price;
    const markupRate = input.markupRate ?? order.markup_rate;
    const salesAmount =
      input.salesAmount ??
      (unitPrice != null && markupRate != null
        ? Math.round(unitPrice * input.quantity * markupRate)
        : null);

    // 入金予定日は転記月の月末
    const [year, month] = input.reportMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const paymentDueOn = `${input.reportMonth}-${String(lastDay).padStart(2, '0')}`;

    const result = db
      .prepare(
        `INSERT INTO consignment_reports
           (order_id, report_month, customer_id, product_id, quantity, unit_price, markup_rate,
            sales_amount, shipping_fee, invoiced_on, payment_due_on, note, created_by)
         VALUES
           (@orderId, @reportMonth, @customerId, @productId, @quantity, @unitPrice, @markupRate,
            @salesAmount, @shippingFee, @invoicedOn, @paymentDueOn, @note, @createdBy)`
      )
      .run({
        orderId: input.orderId,
        reportMonth: input.reportMonth,
        customerId: order.customer_id,
        productId: order.product_id,
        quantity: input.quantity,
        unitPrice,
        markupRate,
        salesAmount,
        shippingFee: input.shippingFee ?? null,
        invoicedOn: input.invoicedOn ?? today(), // 転記時に自動記録
        paymentDueOn,
        note: input.note ?? null,
        createdBy: actor?.id ?? null,
      });

    operationLogService.record({
      user: actor,
      action: 'consignment.report',
      targetType: 'consignment_reports',
      targetId: result.lastInsertRowid,
      summary: `委託販売実績を報告（${order.order_no} / ${input.reportMonth} / ${input.quantity}本）`,
    });

    return findConsignmentReport(result.lastInsertRowid);
  });

  return run();
}

function findConsignmentReport(id) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT r.*, o.order_no, c.name AS customer_name, p.name AS product_name
       FROM consignment_reports r
       JOIN orders o ON o.id = r.order_id
       JOIN customers c ON c.id = r.customer_id
       JOIN products p ON p.id = r.product_id
       WHERE r.id = ?`
    )
    .get(id);
}

function listConsignmentReports({ reportMonth, customerId, limit = 200 } = {}) {
  const db = getConnection();
  const where = [];
  const params = { limit };
  if (reportMonth) { where.push('r.report_month = @reportMonth'); params.reportMonth = reportMonth; }
  if (customerId) { where.push('r.customer_id = @customerId'); params.customerId = customerId; }

  return db
    .prepare(
      `SELECT r.*, o.order_no, c.name AS customer_name, p.name AS product_name
       FROM consignment_reports r
       JOIN orders o ON o.id = r.order_id
       JOIN customers c ON c.id = r.customer_id
       JOIN products p ON p.id = r.product_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.report_month DESC, r.id DESC
       LIMIT @limit`
    )
    .all(params);
}

/**
 * まだ報告しきっていない委託受注の一覧（旧 getConsignmentCustomers の役割を含む）。
 * 画面のプルダウンに使う。
 */
function listPendingConsignmentOrders() {
  const db = getConnection();
  return db
    .prepare(
      `SELECT o.id, o.order_no, o.ordered_on, o.quantity,
              c.name AS customer_name, p.name AS product_name,
              COALESCE(SUM(r.quantity), 0) AS reported_quantity,
              o.quantity - COALESCE(SUM(r.quantity), 0) AS remaining_quantity
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products p ON p.id = o.product_id
       LEFT JOIN consignment_reports r ON r.order_id = o.id
       WHERE o.sales_method = '委託'
       GROUP BY o.id
       HAVING remaining_quantity > 0
       ORDER BY o.ordered_on`
    )
    .all();
}

module.exports = {
  submitProductReturn,
  submitSampleShipment,
  listSampleShipments,
  submitConsignmentReport,
  listConsignmentReports,
  listPendingConsignmentOrders,
};
