// 受注まわりの業務ロジック（旧GASの submitOrder / markOrderAsShipped 相当）。

const { getConnection } = require('../db/connection');
const orderModel = require('../models/orderModel');
const { nextOrderNo, nextProductHistoryCode } = require('../utils/codeGenerator');
const { calcPaymentDueOn, today } = require('../utils/dateUtil');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../utils/errors');
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
 *
 * 1つの受注で複数商品を頼まれた場合は、**同じ受注番号で複数行**になる
 * （DATA_STRUCTURE.md 3章。GAS版の「商品明細は行追加式」と同じ形）。
 * itemsを渡せば複数明細、従来どおり productId / quantity を直接渡せば1明細。
 * 送料は受注番号に対して1つなので、1行目にだけ載せる。
 */
function submitOrder(input, actor = null) {
  const db = getConnection();

  const items = normalizeItems(input);

  const run = db.transaction(() => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId);
    if (!customer) throw new NotFoundError(`得意先が見つかりません (id=${input.customerId})`);

    const orderNo = input.orderNo ?? nextOrderNo(db, input.orderedOn);
    const shippingFee = input.shippingFee ?? 0;
    const markupRate = input.markupRate ?? customer.markup_rate ?? 1;

    const created = items.map((item, index) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) throw new NotFoundError(`商品が見つかりません (id=${item.productId})`);

      const unitPrice = item.unitPrice ?? product.list_price ?? 0;
      const salesAmount =
        item.salesAmount ?? Math.round(unitPrice * item.quantity * markupRate);
      // 送料は受注単位。1行目にだけ計上して二重計上を防ぐ。
      const lineShippingFee = index === 0 ? shippingFee : 0;
      const totalAmount =
        items.length === 1 && input.totalAmount != null
          ? input.totalAmount
          : salesAmount + lineShippingFee;

      const result = db
        .prepare(
          `INSERT INTO orders
             (order_no, line_no, ordered_on, customer_id, product_id, quantity, unit_price,
              markup_rate, sales_amount, shipping_fee, total_amount, requested_delivery_on,
              invoiced_on, payment_due_on, paid_on, sales_method, delivery_method, status,
              delivery_address, shipping_zone, carton_size, delivered_on, note, created_by)
           VALUES
             (@orderNo, @lineNo, @orderedOn, @customerId, @productId, @quantity, @unitPrice,
              @markupRate, @salesAmount, @shippingFee, @totalAmount, @requestedDeliveryOn,
              @invoicedOn, @paymentDueOn, @paidOn, @salesMethod, @deliveryMethod, @status,
              @deliveryAddress, @shippingZone, @cartonSize, @deliveredOn, @note, @createdBy)`
        )
        .run({
          orderNo,
          lineNo: index + 1,
          orderedOn: input.orderedOn,
          customerId: input.customerId,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice,
          markupRate,
          salesAmount,
          shippingFee: lineShippingFee,
          totalAmount,
          requestedDeliveryOn: input.requestedDeliveryOn ?? null,
          invoicedOn: input.invoicedOn ?? null,
          paymentDueOn: input.paymentDueOn ?? null,
          paidOn: null,
          salesMethod: input.salesMethod ?? null,
          deliveryMethod: input.deliveryMethod ?? null,
          status: input.status ?? '未着手',
          deliveryAddress: input.deliveryAddress ?? null,
          shippingZone: input.shippingZone ?? null,
          cartonSize: input.cartonSize ?? null,
          deliveredOn: null,
          note: input.note ?? null,
          createdBy: actor?.id ?? null,
        });

      return orderModel.findById(result.lastInsertRowid);
    });

    const summaryLines = created
      .map((o) => `${o.product_name} ${o.quantity}本`)
      .join(' / ');
    operationLogService.record({
      user: actor,
      action: 'order.create',
      targetType: 'orders',
      targetId: created[0].id,
      summary: `受注 ${orderNo} を登録（${created[0].customer_name} / ${summaryLines}）`,
    });

    // 1明細のときの戻り値は従来どおり受注1件。複数明細は lines で全行を返す。
    return { ...created[0], lines: created };
  });

  return run();
}

/** 明細の指定を items 配列に揃える（単品指定も受け付ける） */
function normalizeItems(input) {
  if (Array.isArray(input.items) && input.items.length) return input.items;
  if (input.productId) {
    return [
      {
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        salesAmount: input.salesAmount,
      },
    ];
  }
  throw new BusinessRuleError('商品が指定されていません');
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

/**
 * 受注1行の訂正（受注一覧の「編集」）。
 *
 * 現行シートでは行を直接書き換えて直していた操作にあたる。
 * 日付や本数を間違えて登録したときに、受注を作り直さずに直せるようにする。
 *
 * 気をつけていること：
 * - 送料・本数・単価・掛率を直したら、売価と合計も同じ更新の中で計算し直す
 *   （画面から古い合計が送られてきても、金額が食い違ったまま残らないようにする）
 * - 発送済の受注で本数や納品日を直したときは、商品在庫変動履歴の出荷行も
 *   同じトランザクションで直す。ここを直さないと在庫の数が合わなくなる
 * - 何をどう変えたかは操作ログに残す（誰がいつ直したかを追えるようにする）
 */

// 編集できる項目と、DBの列名の対応。ここに無い項目は書き換えない。
const EDITABLE_COLUMNS = {
  orderedOn: 'ordered_on',
  requestedDeliveryOn: 'requested_delivery_on',
  deliveredOn: 'delivered_on',
  invoicedOn: 'invoiced_on',
  paymentDueOn: 'payment_due_on',
  paidOn: 'paid_on',
  quantity: 'quantity',
  unitPrice: 'unit_price',
  markupRate: 'markup_rate',
  shippingFee: 'shipping_fee',
  status: 'status',
  salesMethod: 'sales_method',
  deliveryMethod: 'delivery_method',
  deliveryAddress: 'delivery_address',
  note: 'note',
};

// 操作ログに出すときの日本語名
const EDITABLE_LABELS = {
  ordered_on: '受注日',
  requested_delivery_on: '納入希望日',
  delivered_on: '納品日',
  invoiced_on: '請求日',
  payment_due_on: '入金予定日',
  paid_on: '入金日',
  quantity: '本数',
  unit_price: '単価',
  markup_rate: '掛率',
  shipping_fee: '送料',
  sales_amount: '売価',
  total_amount: '合計',
  status: 'ステータス',
  sales_method: '販売方法',
  delivery_method: '配送方法',
  delivery_address: '配送先',
  note: '備考',
};

function updateOrder(orderId, patch = {}, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const before = orderModel.findById(orderId);
    if (!before) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);

    const next = {};
    for (const [key, column] of Object.entries(EDITABLE_COLUMNS)) {
      if (!Object.hasOwn(patch, key)) continue;
      // 空文字は「消す」意味として扱う（日付を消せないと直しようがないため）
      const value = patch[key] === '' ? null : patch[key];
      next[column] = value;
    }
    if (!Object.keys(next).length) return before;

    if (next.quantity != null && next.quantity <= 0) {
      throw new BusinessRuleError('本数は1以上で入力してください');
    }
    if (next.ordered_on === null) {
      throw new BusinessRuleError('受注日は空にできません');
    }

    // 金額は「単価×本数×掛率」で計算し直す。画面から送られた売価・合計は使わない。
    const quantity = next.quantity ?? before.quantity;
    const unitPrice = next.unit_price ?? before.unit_price;
    const markupRate = next.markup_rate ?? before.markup_rate;
    const shippingFee = next.shipping_fee ?? before.shipping_fee ?? 0;

    if (unitPrice != null && markupRate != null) {
      next.sales_amount = Math.round(unitPrice * quantity * markupRate);
    }
    const salesAmount = next.sales_amount ?? before.sales_amount;
    if (salesAmount != null) {
      // 送料は受注番号の1行目にだけ載っている（submitOrderと同じ持ち方）
      next.total_amount = salesAmount + (before.line_no === 1 ? shippingFee : 0);
    }

    const sets = Object.keys(next).map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE orders SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...next, id: orderId });

    // 発送済なら、商品在庫変動履歴の出荷行も合わせて直す。
    // ここを直さないと、受注の本数と在庫の減り方が食い違ったままになる。
    const after = orderModel.findById(orderId);
    if (after.status === '発送済') {
      const ledger = db
        .prepare(
          `SELECT * FROM product_stock_ledger
           WHERE order_id = ? AND txn_type = '出荷' AND is_cancelled = 0
           ORDER BY id DESC LIMIT 1`
        )
        .get(orderId);

      if (ledger) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(after.product_id);
        db.prepare(
          `UPDATE product_stock_ledger
           SET txn_date = @txnDate, quantity = @quantity,
               volume_ml = @volumeMl, tax_amount = @taxAmount
           WHERE id = @id`
        ).run({
          id: ledger.id,
          txnDate: after.delivered_on ?? ledger.txn_date,
          quantity: after.quantity,
          volumeMl: product?.volume_ml != null ? product.volume_ml * after.quantity : null,
          taxAmount: product?.tax_per_unit != null ? product.tax_per_unit * after.quantity : null,
        });
      }
    }

    const changes = Object.keys(next)
      .filter((c) => String(before[c] ?? '') !== String(after[c] ?? ''))
      .map((c) => `${EDITABLE_LABELS[c] ?? c }: ${before[c] ?? '(空)'} → ${after[c] ?? '(空)'}`);

    operationLogService.record({
      user: actor,
      action: 'order.update',
      targetType: 'orders',
      targetId: orderId,
      summary: changes.length
        ? `受注 ${after.order_no} を訂正した（${changes.join('、')}）`
        : `受注 ${after.order_no} を訂正した（内容に変化なし）`,
    });

    return after;
  });

  return run();
}

module.exports = {
  getOrderDefaults,
  submitOrder,
  markOrderAsShipped,
  updateOrder,
  markInvoiceSent,
  markInvoicesSent,
  listPendingInvoices,
  markPaid,
};
