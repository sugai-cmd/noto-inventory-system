// 受注まわりの業務ロジック（旧GASの submitOrder / markOrderAsShipped 相当）。

const { getConnection } = require('../db/connection');
const orderModel = require('../models/orderModel');
const { nextOrderNo, nextProductHistoryCode } = require('../utils/codeGenerator');
const { calcPaymentDueOn, today } = require('../utils/dateUtil');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');
const customerService = require('./customerService');
const shippingFeeService = require('./shippingFeeService');
const liquorTaxService = require('./liquorTaxService');
const { consumeMaterials } = require('./materialConsumption');

/**
 * 受注登録画面の初期値を返す（DB_SCHEMA_DESIGN.md 2.3）。
 * 得意先の掛率・商品の上代・支払いサイトから請求関連日付を先に計算して画面に出す。
 * ここで返す値はあくまで初期表示用で、確定値は登録時にordersへスナップショット保存する。
 */
function getOrderDefaults({ customerId, productId, quantity, deliveredOn }) {
  const db = getConnection();

  // 支店の得意先は、請求まわり（掛率・支払いサイト）が空欄のことがある。
  // その場合は本店の値を使う（customerService.resolveBilling）。
  const customer = customerId ? customerService.resolveBilling(customerId, db) : null;
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
    const customer = customerService.resolveBilling(input.customerId, db);
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
 * 出荷で使った段ボールを資材在庫変動履歴へ落とす。
 *
 * 分類が「外箱」の資材しか受け付けない。化粧箱・桐箱・プラケースは分類が「箱」で、
 * **箱詰めのレシピで既に減らしている**ので、ここで通すと二重に減る。
 * これが唯一のガードなので、資材の分類を変えると効かなくなる。
 */
function consumeCartons(db, cartons, { txnDate, productLedgerId, createdBy }) {
  if (!cartons?.length) return [];

  const items = cartons.map(({ materialId, quantity }) => {
    const material = db
      .prepare('SELECT id, name, category FROM materials WHERE id = ?')
      .get(materialId);
    if (!material) throw new NotFoundError(`資材が見つかりません (id=${materialId})`);
    shippingFeeService.assertCartonMaterial(material);
    return { materialId: material.id, materialName: material.name, quantity };
  });

  return consumeMaterials(db, items, {
    txnDate,
    productLedgerId,
    note: '出荷による自動消費',
    createdBy,
  });
}

/**
 * 「発送済にする」（旧 markOrderAsShipped）。
 * 受注のステータス・納品日・入金予定日を更新し、同一トランザクション内で
 * 商品在庫変動履歴に出荷行を追加する（DATA_STRUCTURE.md 5章）。
 * order_id を必ずセットするので、6-3で課題だった受注との突合が新規データでは常に成立する。
 */
function markOrderAsShipped(orderId, { deliveredOn, note, cartons } = {}, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const order = orderModel.findById(orderId);
    if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);
    // 取消済みを出荷すると、取り消した受注の在庫が減り、酒税にも乗る
    if (order.is_cancelled) {
      throw new ConflictError(`受注 ${order.order_no} は取消済みです。発送できません`);
    }
    if (order.status === '発送済') {
      throw new ConflictError(`受注 ${order.order_no} は既に発送済です`);
    }

    const shippedOn = deliveredOn ?? today();
    const customer = customerService.resolveBilling(order.customer_id, db);

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

    const { ledgerId, cartons: consumed, cartonSummary } = recordShipmentLedger(
      db,
      order,
      { shippedOn, counterparty: customer?.name ?? null, note, cartons },
      actor
    );

    operationLogService.record({
      user: actor,
      action: 'order.ship',
      targetType: 'orders',
      targetId: orderId,
      summary:
        `受注 ${order.order_no} を発送済にした（${order.product_name} ${order.quantity}本を出荷）` +
        cartonSummary,
    });

    return {
      order: orderModel.findById(orderId),
      stockLedgerId: ledgerId,
      cartons: consumed,
    };
  });

  return run();
}

/**
 * 出荷の記録（商品在庫変動履歴の '出荷' 行 ＋ 段ボールの消費）。
 *
 * **出荷行を作るのはここだけ。** 「発送済にする」ボタン（markOrderAsShipped）と、
 * 受注の編集でステータスを発送済に変えたとき（updateOrder）の両方がここを通る。
 * 以前は編集側が出荷行を作っておらず、発送済なのに在庫が減らず**酒税にも乗らない**
 * 受注ができていた（酒税タブに商品が出てこない、として見つかった）。
 *
 * 呼び出し側は、事前に orders の status / delivered_on を更新しておくこと。
 *
 * @param {object} order - orderModel.findById の行（product_id, quantity, order_no …）
 * @param {string} options.shippedOn - 出荷日。酒税はこの日付の月で集計される
 * @param {Array} [options.cartons] - 使った段ボール。編集経由では選べないので空で来る
 */
function recordShipmentLedger(db, order, { shippedOn, counterparty, note, cartons } = {}, actor = null) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);

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
      counterparty: counterparty ?? null,
      orderId: order.id,
      volumeMl: product?.volume_ml != null ? product.volume_ml * order.quantity : null,
      // 容量(ml)×本数×税率。**tax_per_unit は読まない**（容量を掛けていない値で、桁が違う）。
      // 税率が引けなければ空で入り、酒税タブが名指しで出す。出荷は止めない
      taxAmount: liquorTaxService.ledgerTaxAmount(db, product, order.quantity, shippedOn),
      storagePlace: '浄溜所',
      note: note ?? null,
      createdBy: actor?.id ?? null,
    });

  // 出荷に使った段ボールを資材から減らす。
  //
  // **product_ledger_id に出荷行を入れるのが肝。**
  // ledgerCancelService は product_ledger_id で資材行を連動取消しており、
  // txn_type を見ていないので、ここで紐付けておけば**取消は無改修で戻る**。
  //
  // 何を何箱使うかは画面で選んでもらう（推奨は shippingFeeService.suggestCartons）。
  // 対応表に無い・複数明細・物でない商品（委託生産料など）は空で来るので、
  // **減らさずに理由だけ残す**。資材不足でも止めない（既存の方針。在庫監査が後で拾う）。
  const consumed = consumeCartons(db, cartons, {
    txnDate: shippedOn,
    productLedgerId: ledgerResult.lastInsertRowid,
    createdBy: actor?.id ?? null,
  });

  return {
    ledgerId: ledgerResult.lastInsertRowid,
    cartons: consumed,
    cartonSummary: consumed.length
      ? `／段ボール: ${consumed.map((c) => `${c.materialName}${c.quantity}枚`).join('、')}`
      : '／段ボールは減らしていません（発送画面で選ばれませんでした）',
  };
}

/**
 * 在庫監査から、抜けている出荷を後から記録する。
 *
 * 「発送済なのに出荷の記録が無い」受注を直すための入口。
 * 編集でステータスだけ発送済にされた受注が対象で、在庫が減らず酒税にも乗っていない。
 *
 * **移行した過去の受注は対象にしない**（台帳の行は別に存在していて、
 * 受注と紐付いていないだけ。ここで作ると二重に在庫が減る）。
 */
function recordMissingShipment(orderId, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const order = orderModel.findById(orderId);
    if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);
    if (order.is_cancelled) {
      throw new BusinessRuleError(`受注 ${order.order_no} は取消済みです`);
    }
    if (order.status !== '発送済') {
      throw new BusinessRuleError(
        `受注 ${order.order_no} は発送済ではありません（状態: ${order.status}）。` +
          '発送したなら「発送済にする」から記録してください'
      );
    }
    if (order.legacy_order_no) {
      throw new BusinessRuleError(
        `受注 ${order.order_no} は移行した過去の受注です。` +
          '出荷の記録は台帳に別途あり、受注と紐付いていないだけなので、ここでは作りません' +
          '（作ると在庫が二重に減ります）'
      );
    }
    if (liveShipmentLedgerRows(db, orderId).length) {
      throw new ConflictError(`受注 ${order.order_no} には既に出荷の記録があります`);
    }

    const shippedOn = order.delivered_on ?? today();
    const customer = customerService.resolveBilling(order.customer_id, db);

    if (order.payment_due_on == null) {
      const paymentDueOn = calcPaymentDueOn(
        shippedOn,
        customer?.payment_term_months,
        customer?.payment_term_day
      );
      if (paymentDueOn) {
        db.prepare('UPDATE orders SET payment_due_on = @d WHERE id = @id')
          .run({ id: orderId, d: paymentDueOn });
      }
    }
    if (order.delivered_on == null) {
      db.prepare('UPDATE orders SET delivered_on = @d WHERE id = @id')
        .run({ id: orderId, d: shippedOn });
    }

    const { ledgerId, cartonSummary } = recordShipmentLedger(
      db,
      order,
      {
        shippedOn,
        counterparty: customer?.name ?? null,
        note: '在庫監査から、抜けていた出荷を記録',
        cartons: null,
      },
      actor
    );

    operationLogService.record({
      user: actor,
      action: 'order.ship.backfill',
      targetType: 'orders',
      targetId: orderId,
      summary:
        `受注 ${order.order_no} の抜けていた出荷を記録した` +
        `（${order.product_name} ${order.quantity}本・出荷日 ${shippedOn}）${cartonSummary}`,
    });

    return { order: orderModel.findById(orderId), stockLedgerId: ledgerId };
  });

  return run();
}

/** 請求日を記録する（旧 markInvoiceSent） */
function markInvoiceSent(orderId, { invoicedOn } = {}) {
  const db = getConnection();
  const order = orderModel.findById(orderId);
  if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);
  if (order.is_cancelled) {
    throw new ConflictError(`受注 ${order.order_no} は取消済みです。請求できません`);
  }

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
  if (order.is_cancelled) {
    throw new ConflictError(`受注 ${order.order_no} は取消済みです。入金を記録できません`);
  }

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
      if (order.is_cancelled) {
        skipped.push({ id, orderNo: order.order_no, reason: '取消済みです' });
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
  // 取消済みは請求の候補に出さない（0026）
  const where = ['o.is_cancelled = 0', 'o.delivered_on IS NOT NULL', 'o.invoiced_on IS NULL'];
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
//
// 得意先は変えられない（別の得意先なら掛率も請求も別件なので、登録し直すほうが正しい）。
// **商品だけは変えられる**（誤登録の直しとして一番多いため）。ただし未発送に限る。
const EDITABLE_COLUMNS = {
  productId: 'product_id',
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
  product_id: '商品',
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
    if (before.is_cancelled) {
      throw new BusinessRuleError(
        `受注 ${before.order_no} は取消済みです。直すなら、もう一度登録してください`
      );
    }

    // 入金日は入金の割り当てから自動で入れている（paymentService.refreshPaidOn）。
    // ここからも直せると、消し込みの残額と入金日が食い違う
    if (Object.hasOwn(next, 'paid_on') && before.has_payment_allocation) {
      throw new BusinessRuleError(
        `受注 ${before.order_no} には入金の割り当てがあります。` +
          '入金日は入金タブの消し込みから直してください'
      );
    }

    // 発送済から外すときは、出荷の記録が残っていれば断る。
    //
    // 在庫・資材・タンクの戻しは「記録の取り消し」の仕事で、ここではやらない。
    // 黙ってステータスだけ戻すと、出荷行は残ったまま受注だけ未着手になり、
    // 「発送済にしたのに出荷が無い」の逆向きの食い違いができる。
    if (
      Object.hasOwn(next, 'status') &&
      before.status === '発送済' &&
      next.status !== '発送済' &&
      liveShipmentLedgerRows(db, orderId).length
    ) {
      throw new BusinessRuleError(
        `受注 ${before.order_no} には出荷の記録が残っているため、ステータスを戻せません。` +
          '在庫監査タブの「記録の取り消し」で先に出荷を取り消してください' +
          '（取り消すと受注は自動で未着手に戻ります）'
      );
    }

    // 商品の差し替え（誤登録の直し）。
    //
    // **未発送に限る。** 出荷が済んでいると、商品在庫変動履歴の出荷行の商品まで
    // 差し替えることになり、引き当て・酒税・在庫監査に波及する（別の機能になる）。
    // 先に出荷を取り消してもらう。status ではなく台帳を見るのは cancelOrder と同じ理由
    let productChange = null;
    if (next.product_id != null && next.product_id !== before.product_id) {
      const shipments = liveShipmentLedgerRows(db, orderId);
      if (shipments.length) {
        throw new BusinessRuleError(
          `受注 ${before.order_no} には出荷の記録が残っているため、商品は変えられません。` +
            '在庫監査タブの「記録の取り消し」で先に出荷を取り消してください'
        );
      }
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(next.product_id);
      if (!product) throw new NotFoundError(`商品が見つかりません (id=${next.product_id})`);

      // 単価が指定されていなければ、新しい商品の上代を入れる
      // （登録時 getOrderDefaults と同じ考え方。古い商品の単価が残るほうが危ない）
      if (!Object.hasOwn(patch, 'unitPrice') && product.list_price != null) {
        next.unit_price = product.list_price;
      }
      productChange = { from: before.product_name, to: product.name };
    } else {
      // 同じ商品を送ってきただけなら、変更として扱わない（操作ログを汚さない）
      delete next.product_id;
      if (!Object.keys(next).length) return before;
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
    let shippedHere = null;
    if (after.status === '発送済') {
      const ledger = db
        .prepare(
          `SELECT * FROM product_stock_ledger
           WHERE order_id = ? AND txn_type = '出荷' AND is_cancelled = 0
           ORDER BY id DESC LIMIT 1`
        )
        .get(orderId);

      if (!ledger) {
        // **この編集で発送済になったのに、出荷の記録がまだ無い。**
        // 以前はここで何もしておらず、在庫が減らず酒税にも乗らない受注ができていた
        // （酒税タブに商品が出てこない、として見つかった）。
        // 「発送済にする」ボタンと同じ処理を通す。
        //
        // 段ボールは編集画面から選べないので減らさない。黙って抜けないよう、
        // 操作ログにその旨を残す（cartonSummary がそう書く）。
        const shippedOn = after.delivered_on ?? today();
        const customer = customerService.resolveBilling(after.customer_id, db);

        // 納品日が入ったのに空のままなら、入金予定日もここで出す。
        // **既に入っている値は上書きしない**（この編集で指定された値を消さない）
        if (after.payment_due_on == null) {
          const paymentDueOn = calcPaymentDueOn(
            shippedOn,
            customer?.payment_term_months,
            customer?.payment_term_day
          );
          if (paymentDueOn) {
            db.prepare('UPDATE orders SET payment_due_on = @d WHERE id = @id')
              .run({ id: orderId, d: paymentDueOn });
          }
        }
        // 納品日が空のまま発送済にされたら、出荷日を納品日としても残す
        if (after.delivered_on == null) {
          db.prepare('UPDATE orders SET delivered_on = @d WHERE id = @id')
            .run({ id: orderId, d: shippedOn });
        }

        shippedHere = recordShipmentLedger(
          db,
          after,
          { shippedOn, counterparty: customer?.name ?? null, note: null, cartons: null },
          actor
        );
      } else {
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
          // 本数が変わったら酒税額も変わる。日付も変わりうるので、その日の税率で出し直す
          taxAmount: liquorTaxService.ledgerTaxAmount(
            db,
            product,
            after.quantity,
            after.delivered_on ?? ledger.txn_date
          ),
        });
      }
    }

    // 商品だけは**名前で**出す。他と同じ扱いにすると「商品: 3 → 7」になり、
    // 操作ログを後から読んだときに何が何に変わったのか分からない
    const changes = Object.keys(next)
      .filter((c) => String(before[c] ?? '') !== String(after[c] ?? ''))
      .map((c) =>
        c === 'product_id' && productChange
          ? `商品: ${productChange.from} → ${productChange.to}`
          : `${EDITABLE_LABELS[c] ?? c }: ${before[c] ?? '(空)'} → ${after[c] ?? '(空)'}`
      );

    // この編集で出荷を記録したなら、何が起きたのかを必ず残す。
    // 在庫が動いた事実と、段ボールを減らしていないことの両方を書く
    const shipSummary = shippedHere
      ? `／出荷を記録した（${after.product_name} ${after.quantity}本）${shippedHere.cartonSummary}`
      : '';

    operationLogService.record({
      user: actor,
      action: 'order.update',
      targetType: 'orders',
      targetId: orderId,
      summary:
        (changes.length
          ? `受注 ${after.order_no} を訂正した（${changes.join('、')}）`
          : `受注 ${after.order_no} を訂正した（内容に変化なし）`) + shipSummary,
    });

    // 出荷を記録したときは納品日・入金予定日もここで入れているので、読み直して返す
    return shippedHere ? orderModel.findById(orderId) : after;
  });

  return run();
}

// ---------------------------------------------------------------------------
// 受注の取消
// ---------------------------------------------------------------------------

/**
 * 生きている出荷・返品の台帳行を返す（なければ空配列）。
 *
 * **status ではなく台帳を見る。** status は編集で手で変えられるので、
 * `未着手` に戻してあっても出荷行が生きていることがありうる。
 * そのまま受注を取り消すと、在庫監査が「出荷行はあるのに発送済でない」と
 * 鳴り続ける（stockAuditService.auditOrderShipments）。
 */
function liveShipmentLedgerRows(db, orderId) {
  return db
    .prepare(
      `SELECT id, history_code, txn_type, quantity, txn_date
         FROM product_stock_ledger
        WHERE order_id = @orderId AND is_cancelled = 0
        ORDER BY id`
    )
    .all({ orderId });
}

/**
 * 紐付いている委託販売実績報告（なければ空配列）。
 *
 * 報告番号は 0027 から採番している（既存分もそこで埋めた）。
 * それでも空のことがありうるので、そのときは利用者が委託販売報告の一覧で
 * 突き合わせられる「報告月と本数」に落とす。idは画面に出ないので使わない。
 */
function linkedConsignmentReports(db, orderId) {
  return db
    .prepare(
      `SELECT id, report_no, report_month, quantity
         FROM consignment_reports WHERE order_id = @orderId ORDER BY id`
    )
    .all({ orderId })
    .map((r) => ({
      ...r,
      label: r.report_no
        ? `${r.report_no}（${r.report_month}）`
        : `${r.report_month} 分 ${r.quantity}本`,
    }));
}

/**
 * 誤登録した受注を取り消す。
 *
 * 行は消さず、取消フラグと理由を立てる（0026のコメント参照）。
 * 一覧の既定・集計・ダッシュボード・CSV・売上目標・在庫監査から外れるのは、
 * それぞれの読み取り側が `is_cancelled = 0` で絞っているため。
 *
 * ledgerCancelService.cancelProductLedger と同じ作法:
 * 理由必須／二重取消は409／前段の取消を先に求める。
 *
 * **請求済み・入金済みは止めない**（利用者の判断）。請求を間違えたときに
 * 直せなくなるため。代わりに warnings に入れて画面で確認させる。
 */
function cancelOrder(orderId, { reason } = {}, actor = null) {
  const db = getConnection();
  if (!reason || !String(reason).trim()) {
    throw new BusinessRuleError('取消理由は必須です');
  }

  const run = db.transaction(() => {
    const order = orderModel.findById(orderId);
    if (!order) throw new NotFoundError(`受注が見つかりません (id=${orderId})`);
    if (order.is_cancelled) {
      throw new ConflictError(`受注 ${order.order_no} は既に取消済みです`);
    }

    const shipments = liveShipmentLedgerRows(db, orderId);
    if (shipments.length) {
      throw new ConflictError(
        `受注 ${order.order_no} には出荷の記録が残っています` +
          `（${shipments.map((r) => `${r.history_code ?? `id=${r.id}`} ${r.txn_type}${r.quantity}`).join('、')}）。` +
          '在庫監査タブの「記録の取り消し」で先に出荷を取り消してください'
      );
    }

    // 報告が親の受注を失うと、売上目標の委託分と合わなくなる。
    // **委託報告には取消の手段がまだ無い**ので、どの報告が邪魔しているかを必ず出す
    const reports = linkedConsignmentReports(db, orderId);
    if (reports.length) {
      throw new ConflictError(
        `受注 ${order.order_no} には委託販売実績報告が紐付いています` +
          `（${reports.map((r) => r.label).join('、')}）。` +
          'この受注は取り消せません'
      );
    }

    // 止めないが、気づかずに取り消すと困るもの
    const warnings = [];
    if (order.invoiced_on) warnings.push(`請求済みです（請求日 ${order.invoiced_on}）`);
    if (order.paid_on) warnings.push(`入金済みです（入金日 ${order.paid_on}）`);

    db.prepare(
      `UPDATE orders
          SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
              cancelled_by = @by, updated_at = datetime('now')
        WHERE id = @id`
    ).run({ id: orderId, reason: String(reason).trim(), by: actor?.id ?? null });

    operationLogService.record({
      user: actor,
      action: 'order.cancel',
      targetType: 'orders',
      targetId: orderId,
      summary:
        `受注 ${order.order_no} を取消（${order.customer_name} / ${order.product_name} ${order.quantity}本）` +
        (warnings.length ? `／${warnings.join('、')}` : '') +
        `／理由: ${String(reason).trim()}`,
      detail: { warnings },
    });

    return { order: orderModel.findById(orderId), warnings };
  });

  return run();
}

module.exports = {
  getOrderDefaults,
  submitOrder,
  markOrderAsShipped,
  recordMissingShipment,
  updateOrder,
  markInvoiceSent,
  markInvoicesSent,
  listPendingInvoices,
  markPaid,
  cancelOrder,
};
