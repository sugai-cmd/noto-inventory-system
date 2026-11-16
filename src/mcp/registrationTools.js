// 音声入力のコネクタ（MCP）から呼べる、蒸留以外の登録の中身。
//
// 対象は「新しい記録の登録」だけ（現場の作業・受注と出荷・入金・マスタ）。
// 取消・修正・削除はコネクタからはできない（画面で行う）。
//
// どの登録も同じ作りにしてある：
//   1. 名前をIDに直す（recordLookup / tankLookup）
//   2. **画面が送るのと同じ形**に入力を組み立てる（画面だけが補っている既定値もここで補う）
//   3. 画面のAPIと同じ zod スキーマを通し、同じサービス関数を呼ぶ（writeFlow.executeWrite）
// 画面と違う動きを足すときは、必ず「注意点（warnings）」に留め、登録の可否は変えない。

const { getConnection } = require('../db/connection');
const distillationService = require('../services/distillationService');
const bottlingService = require('../services/bottlingService');
const tankService = require('../services/tankService');
const materialService = require('../services/materialService');
const orderService = require('../services/orderService');
const shipmentService = require('../services/shipmentService');
const quotationService = require('../services/quotationService');
const paymentService = require('../services/paymentService');
const customerService = require('../services/customerService');
const customerNoteService = require('../services/customerNoteService');
const productService = require('../services/productService');
const shippingFeeService = require('../services/shippingFeeService');
const wipLotService = require('../services/wipLotService');
const customerModel = require('../models/customerModel');
const breweryModel = require('../models/breweryModel');
const rawSakeBrandModel = require('../models/rawSakeBrandModel');
const { nextMasterCode } = require('../utils/masterCode');
const { normalizeName } = require('../utils/normalizeName');
const { today } = require('../utils/dateUtil');
const { executeWrite, compact } = require('./writeFlow');
const { McpInputError, resolveTank, snapshotTanks, diffTanks, round3 } = require('./tankLookup');
const {
  resolveRecord,
  searchRecords,
  resolveOrderLine,
  describeOrderLine,
  resolvePayment,
  resolveConsignmentReport,
  similarNames,
  ORDER_SQL,
} = require('./recordLookup');

const schemas = {
  rawSake: require('../routes/rawSakeReceipts').schemas,
  bottling: require('../routes/bottling').schemas,
  tankOps: require('../routes/tankOperations').schemas,
  materials: require('../routes/materials').schemas,
  orders: require('../routes/orders').schemas,
  shipments: require('../routes/shipments').schemas,
  quotations: require('../routes/quotations').schemas,
  payments: require('../routes/payments').schemas,
  customers: require('../routes/customers').schemas,
  products: require('../routes/products').schemas,
  tanks: require('../routes/tanks').schemas,
  breweries: require('../routes/breweries').schemas,
  rawSakeBrands: require('../routes/rawSakeBrands').schemas,
};

/** 空文字・空白だけの文字列を「入力なし」にする（画面も空欄は送らない） */
function text(value) {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

// --- 在庫・液量の変化を見せる控え ---------------------------------------

function productStock(db, ids) {
  const out = new Map();
  for (const id of new Set(ids)) {
    const r = db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(id);
    if (r) out.set(id, { id, name: r.name, productStock: r.product_stock, wipStock: r.wip_stock });
  }
  return out;
}

function materialStock(db, ids) {
  const out = new Map();
  for (const id of new Set(ids)) {
    const r = db.prepare('SELECT * FROM v_material_stock WHERE material_id = ?').get(id);
    if (r) out.set(id, { id, name: r.name, stock: round3(r.current_stock) });
  }
  return out;
}

function diffMap(before, after, fields) {
  return [...before.values()].map((b) => {
    const a = after?.get(b.id);
    const row = { id: b.id, name: b.name };
    for (const f of fields) {
      row[`${f}Before`] = b[f];
      row[`${f}After`] = a ? a[f] : null;
    }
    return row;
  });
}

/**
 * 変化を見せる対象をまとめて控える。
 * @param {(valid) => {tanks?: number[], products?: number[], materials?: number[]}} pick
 */
function effects(pick) {
  return {
    snapshot: (db, valid) => {
      const ids = pick(valid);
      return {
        tanks: ids.tanks ? snapshotTanks(db, ids.tanks) : null,
        products: ids.products ? productStock(db, ids.products) : null,
        materials: ids.materials ? materialStock(db, ids.materials) : null,
      };
    },
    diff: (before, after) =>
      compact({
        tanks: before.tanks ? diffTanks(before.tanks, after?.tanks) : undefined,
        products: before.products ? diffMap(before.products, after?.products, ['productStock', 'wipStock']) : undefined,
        materials: before.materials ? diffMap(before.materials, after?.materials, ['stock']) : undefined,
      }),
  };
}

function logEntry(action, targetType, targetId, summary) {
  return { action: `mcp.${action}`, targetType, targetId, summary };
}

// --- 現場の作業 ---------------------------------------------------------

/** 原酒入荷（画面の「原酒入荷」フォーム＝まとめて登録と同じ） */
function receiveRawSake(args, ctx) {
  const db = getConnection();
  const tanks = args.items.map((item) => ({
    tank: resolveTank(db, item.tank, { kind: '原酒', label: '受入先タンク' }),
    quantityL: item.quantityL,
  }));
  const brand = args.rawSakeBrand != null ? resolveRecord(db, 'raw_sake_brands', args.rawSakeBrand, '原酒銘柄') : null;

  const input = compact({
    txnDate: args.txnDate,
    items: tanks.map((t) => ({ toTankId: t.tank.id, quantity: t.quantityL })),
    rawSakeBrandId: brand?.id,
    supplier: text(args.supplier),
    specNote: text(args.specNote),
  });

  return executeWrite({
    tool: 'receive_raw_sake',
    schema: schemas.rawSake.bulkReceiptSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ tanks: v.items.map((i) => i.toTankId) })),
    run: (valid) => distillationService.submitRawSakeReceipts(valid, ctx.actor),
    warnings: (_db, valid, before) => {
      const out = [];
      for (const t of before.tanks.values()) {
        if (t.kind !== '原酒') out.push(`${t.name}（${t.code}）は${t.kind}タンクです。原酒タンクではありません`);
        if (t.volumeL > 0) out.push(`${t.name} にはまだ ${t.volumeL}L 残っています（原酒は空のタンクにしか入れられません）`);
      }
      if (valid.txnDate && valid.txnDate > today()) out.push(`受入日 ${valid.txnDate} が未来の日付です`);
      return out;
    },
    log: (result) =>
      logEntry('rawSake.receipt', 'raw_sake_ledger', result.rows?.[0]?.rawSakeLedgerId,
        `原酒を入荷（${tanks.map((t) => `${t.tank.name} ${t.quantityL}L`).join(' / ')}${brand ? `、${brand.name}` : ''}）`),
  });
}

/** 瓶詰め */
function recordBottling(args, ctx) {
  const db = getConnection();
  const product = resolveRecord(db, 'products', args.product);
  const tank = resolveTank(db, args.tank, { kind: '浄酎', label: '払出元タンク' });

  // 画面と同じ形。保管場所は画面から送らない（サーバーの既定「浄溜所」になる）。
  // 度数は空ならサーバーがタンクの度数を入れる（画面が自動で入れる値と同じ）
  const input = compact({
    productId: product.id,
    quantity: args.quantity,
    tankId: tank.id,
    volumeL: args.volumeL,
    txnDate: args.txnDate,
    abv: args.abv,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'record_bottling',
    schema: schemas.bottling.bottlingSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ tanks: [v.tankId], products: [v.productId] })),
    run: (valid) => bottlingService.submitBottling(valid),
    warnings: (_db, valid, before) => {
      const out = [];
      const t = before.tanks.get(valid.tankId);
      // 瓶詰めはサーバーが残量も種別も確かめない。画面は浄酎タンクしか選ばせないので、ここで知らせる
      if (t && t.kind !== '浄酎') out.push(`${t.name}（${t.code}）は${t.kind}タンクです。浄酎タンクではありません`);
      if (t && t.volumeL != null && valid.volumeL > t.volumeL) {
        out.push(`${t.name} の残量 ${t.volumeL}L より払出量 ${valid.volumeL}L が多いです（瓶詰めは残量を確かめずに登録されます）`);
      }
      if (product.volume_ml) {
        const expected = (product.volume_ml * valid.quantity) / 1000;
        if (Math.abs(expected - valid.volumeL) > expected * 0.05) {
          out.push(`${product.name}（${product.volume_ml}ml）× ${valid.quantity}本 は ${round3(expected)}L ですが、払出量は ${valid.volumeL}L です`);
        }
      }
      if (valid.txnDate && valid.txnDate > today()) out.push(`作業日 ${valid.txnDate} が未来の日付です`);
      return out;
    },
    log: (result, valid) =>
      logEntry('bottling', 'product_stock_ledger', result.productLedgerId,
        `瓶詰め（${product.name} ${valid.quantity}本、${tank.name}から ${valid.volumeL}L）`),
  });
}

/** 箱詰め */
function recordBoxing(args, ctx) {
  const db = getConnection();
  const product = resolveRecord(db, 'products', args.product);
  let lotLedgerId;
  if (args.lot != null) {
    const lot =
      typeof args.lot === 'number'
        ? { id: args.lot }
        : db
            .prepare("SELECT id FROM product_stock_ledger WHERE upper(history_code) = ? AND txn_type = '瓶詰'")
            .get(normalizeName(String(args.lot)).replace(/\s/g, '').toUpperCase());
    if (!lot) throw new McpInputError(`瓶詰めロット「${args.lot}」が見つかりません`, { code: 'not_found' });
    lotLedgerId = lot.id;
  }

  const input = compact({
    productId: product.id,
    quantity: args.quantity,
    txnDate: args.txnDate,
    lotLedgerId,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'record_boxing',
    schema: schemas.bottling.boxingSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ products: [v.productId] })),
    run: (valid) => bottlingService.submitBoxing(valid),
    warnings: (_db, valid, before) => {
      const p = before.products.get(valid.productId);
      const out = [];
      if (p && p.wipStock < valid.quantity) out.push(`${p.name} の仕掛品（瓶詰め済み・未箱詰め）は ${p.wipStock}本しかありません`);
      return out;
    },
    log: (result, valid) =>
      logEntry('boxing', 'product_stock_ledger', result.productLedgerId, `箱詰め（${product.name} ${valid.quantity}本）`),
  });
}

/** 容器移動（タンクからタンクへ） */
function transferTank(args, ctx) {
  const db = getConnection();
  const from = resolveTank(db, args.fromTank, { label: '移動元タンク' });
  const to = resolveTank(db, args.toTank, { label: '移動先タンク' });
  const input = compact({
    fromTankId: from.id,
    toTankId: to.id,
    quantityL: args.quantityL,
    txnDate: args.txnDate,
    abv: args.abv,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'transfer_tank',
    schema: schemas.tankOps.transferSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ tanks: [v.fromTankId, v.toTankId] })),
    run: (valid) => tankService.submitTankTransfer(valid),
    log: (result, valid) =>
      logEntry('tank.transfer', 'tank_ledger', result.tankLedgerId, `容器移動（${from.name} → ${to.name} ${valid.quantityL}L）`),
  });
}

/** 未納税移出 */
function recordTaxFreeTransfer(args, ctx) {
  const db = getConnection();
  const from = resolveTank(db, args.fromTank, { label: '払出元タンク' });
  const input = compact({
    fromTankId: from.id,
    quantityL: args.quantityL,
    destination: text(args.destination),
    txnDate: args.txnDate,
    abv: args.abv,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'record_tax_free_transfer',
    schema: schemas.tankOps.taxFreeSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ tanks: [v.fromTankId] })),
    run: (valid) => tankService.submitTaxFreeTransfer(valid),
    log: (result, valid) =>
      logEntry('tank.taxFree', 'tank_ledger', result.tankLedgerId, `未納税移出（${from.name} ${valid.quantityL}L → ${valid.destination}）`),
  });
}

/** 資材入荷 */
function receiveMaterial(args, ctx) {
  const db = getConnection();
  const material = resolveRecord(db, 'materials', args.material);
  // 単価・仕入先は空ならサーバーがマスタの値を使う（画面が自動で入れる値と同じ）
  const input = compact({
    materialId: material.id,
    quantity: args.quantity,
    txnDate: args.txnDate,
    unitPrice: args.unitPrice,
    supplier: text(args.supplier),
    note: text(args.note),
  });

  return executeWrite({
    tool: 'receive_material',
    schema: schemas.materials.receiptSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ materials: [v.materialId] })),
    run: (valid) => materialService.submitMaterialReceipt(valid, ctx.actor),
    log: (result, valid) =>
      logEntry('material.receipt', 'material_stock_ledger', result.ledgerId, `資材を入荷（${material.name} ${valid.quantity}${material.unit ?? ''}）`),
  });
}

// --- 受注・出荷 ----------------------------------------------------------

const SALES_METHODS = ['買取', '委託'];
const DELIVERY_METHODS = ['配送', '配達', '手渡し'];

function stockWarnings(before, productId, quantity) {
  const p = before.products?.get(productId);
  return p && p.productStock < quantity ? [`${p.name} の製品在庫は ${p.productStock}本です（${quantity}本に足りません）`] : [];
}

/** 受注登録 */
function createOrder(args, ctx) {
  const db = getConnection();
  const customer = resolveRecord(db, 'customers', args.customer);
  const items = args.items.map((item) => ({
    product: resolveRecord(db, 'products', item.product),
    quantity: item.quantity,
  }));

  // 入金予定日は、画面と同じく受注の既定値（納入希望日、無ければ今日＋支払いサイト）を入れる
  const paymentDueOn =
    args.paymentDueOn ??
    orderService.getOrderDefaults({
      customerId: customer.id,
      productId: items[0].product.id,
      quantity: items[0].quantity,
      deliveredOn: args.requestedDeliveryOn,
    }).paymentDueOn ??
    undefined;

  // 画面（orders.html）と同じ形：明細は商品と本数だけ。単価・売価はサーバーがマスタから出す
  const input = compact({
    orderedOn: args.orderedOn,
    customerId: customer.id,
    items: items.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
    shippingFee: args.shippingFee ?? 0,
    salesMethod: args.salesMethod ?? '買取',
    deliveryMethod: args.deliveryMethod ?? '配送',
    requestedDeliveryOn: args.requestedDeliveryOn,
    paymentDueOn,
    invoicedOn: args.invoicedOn,
    deliveryAddress: text(args.deliveryAddress),
    note: text(args.note),
  });

  return executeWrite({
    tool: 'create_order',
    schema: schemas.orders.createSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ products: v.items.map((i) => i.productId) })),
    run: (valid) => orderService.submitOrder(valid, ctx.actor),
    warnings: (_db, valid, before) => {
      const out = [];
      for (const i of valid.items) out.push(...stockWarnings(before, i.productId, i.quantity));
      if (valid.orderedOn > today()) out.push(`受注日 ${valid.orderedOn} が未来の日付です`);
      return out;
    },
    log: (result) =>
      logEntry('order.create', 'orders', result.id,
        `受注 ${result.order_no} を登録（${customer.name}：${items.map((i) => `${i.product.name} ${i.quantity}本`).join(' / ')}）`),
  });
}

/** 発送済みにする（出荷の記録） */
function shipOrder(args, ctx) {
  const db = getConnection();
  const productId = args.product != null ? resolveRecord(db, 'products', args.product).id : undefined;
  const order = resolveOrderLine(db, args.order, { lineNo: args.lineNo, productId });

  // 段ボール：指定が無ければ、画面と同じく推奨（対応表）をそのまま使う。
  // 空の配列を渡したときは「段ボールを使っていない」
  let cartons;
  let cartonNote = null;
  if (args.cartons) {
    cartons = args.cartons.map((c) => ({
      materialId: resolveRecord(db, 'materials', c.material, '段ボール').id,
      quantity: c.quantity,
    }));
  } else {
    const { suggestion, reason } = shippingFeeService.suggestCartons({
      productId: order.product_id,
      quantity: order.quantity,
      orderId: order.id,
    });
    if (suggestion) {
      cartons = [{ materialId: suggestion.materialId, quantity: suggestion.boxes }];
      cartonNote = `段ボールは推奨の ${suggestion.materialName} を ${suggestion.boxes}箱 使う前提です。違うときは cartons で指定してください`;
    } else {
      cartons = [];
      cartonNote = `段ボールの推奨がありません（${reason ?? '不明'}）。使ったときは cartons で指定してください`;
    }
  }

  const input = compact({
    deliveredOn: args.deliveredOn ?? today(),
    note: text(args.note),
    cartons,
  });

  return executeWrite({
    tool: 'ship_order',
    schema: schemas.orders.shipSchema,
    input,
    scope: { orderId: order.id },
    args,
    ctx,
    ...effects((v) => ({ products: [order.product_id], materials: v.cartons?.map((c) => c.materialId) ?? [] })),
    run: (valid) => orderService.markOrderAsShipped(order.id, valid, ctx.actor),
    warnings: (_db, _valid, before) => {
      const out = [...stockWarnings(before, order.product_id, order.quantity)];
      if (cartonNote) out.push(cartonNote);
      if (order.status === '発送済') out.push(`受注 ${order.order_no} はすでに発送済みです`);
      return out;
    },
    log: () =>
      logEntry('order.ship', 'orders', order.id,
        `受注 ${order.order_no}${order.line_no > 1 ? `-${order.line_no}` : ''} を発送済みに（${order.customer_name}：${order.product_name} ${order.quantity}本）`),
    record: (_db, result) => result,
  });
}

/** 返品 */
function recordReturn(args, ctx) {
  const db = getConnection();
  const product = resolveRecord(db, 'products', args.product);
  const customer = args.customer != null ? resolveRecord(db, 'customers', args.customer) : null;
  const input = compact({
    productId: product.id,
    quantity: args.quantity,
    txnDate: args.txnDate,
    customerId: customer?.id,
    reason: text(args.reason),
  });

  return executeWrite({
    tool: 'record_return',
    schema: schemas.shipments.returnSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ products: [v.productId] })),
    run: (valid) => shipmentService.submitProductReturn(valid, ctx.actor),
    log: (result, valid) =>
      logEntry('product.return', 'product_stock_ledger', result.ledgerId,
        `返品（${product.name} ${valid.quantity}本${customer ? `、${customer.name}` : ''}）`),
  });
}

/** 無償出荷（サンプル・再発送・販促） */
function recordSample(args, ctx) {
  const db = getConnection();
  const product = resolveRecord(db, 'products', args.product);
  const customer = args.customer != null ? resolveRecord(db, 'customers', args.customer) : null;
  const input = compact({
    productId: product.id,
    quantity: args.quantity,
    shippedOn: args.shippedOn,
    purpose: args.purpose ?? shipmentService.DEFAULT_SHIPMENT_PURPOSE,
    customerId: customer?.id,
    contactName: text(args.contactName),
    phone: text(args.phone),
    followupOn: args.followupOn,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'record_sample',
    schema: schemas.shipments.sampleSchema,
    input,
    args,
    ctx,
    ...effects((v) => ({ products: [v.productId] })),
    run: (valid) => shipmentService.submitSampleShipment(valid, ctx.actor),
    warnings: (_db, valid, before) => stockWarnings(before, valid.productId, valid.quantity),
    log: (result, valid) =>
      logEntry('sample.ship', 'sample_shipments', result.sampleId,
        `無償出荷 ${result.sampleNo}（${valid.purpose}：${product.name} ${valid.quantity}本${customer ? `、${customer.name}` : ''}）`),
  });
}

/** 委託販売の実績報告 */
function recordConsignmentReport(args, ctx) {
  const db = getConnection();
  const productId = args.product != null ? resolveRecord(db, 'products', args.product).id : undefined;
  const order = resolveOrderLine(db, args.order, { lineNo: args.lineNo, productId });
  const input = compact({
    orderId: order.id,
    reportMonth: args.reportMonth,
    quantity: args.quantity,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'record_consignment_report',
    schema: schemas.shipments.consignmentSchema,
    input,
    args,
    ctx,
    run: (valid) => shipmentService.submitConsignmentReport(valid, ctx.actor),
    warnings: () => (order.sales_method !== '委託' ? [`受注 ${order.order_no} は${order.sales_method ?? '販売方法未設定'}です（委託ではありません）`] : []),
    log: (result, valid) =>
      logEntry('consignment.report', 'consignment_reports', result.id,
        `委託販売の報告 ${result.report_no}（${order.customer_name}：${order.product_name} ${valid.reportMonth} ${valid.quantity}本）`),
  });
}

/** 見積 */
function createQuotation(args, ctx) {
  const db = getConnection();
  const customer = resolveRecord(db, 'customers', args.customer);
  const product = resolveRecord(db, 'products', args.product);
  // 画面は確度を % で入れて /100 して送る。ここも % で受け取って同じ変換をする
  const input = compact({
    quotedOn: args.quotedOn,
    customerId: customer.id,
    productId: product.id,
    quantity: args.quantity,
    status: args.status ?? '見積中',
    unitPrice: args.unitPrice,
    markupRate: args.markupRate,
    costPrice: args.costPrice,
    probability: args.probabilityPercent != null ? args.probabilityPercent / 100 : undefined,
    deliveryDueOn: args.deliveryDueOn,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'create_quotation',
    schema: schemas.quotations.createSchema,
    input,
    args,
    ctx,
    run: (valid) => quotationService.create(valid, ctx.actor),
    log: (result, valid) =>
      logEntry('quotation.create', 'quotations', result.id, `見積を登録（${customer.name}：${product.name} ${valid.quantity}個）`),
  });
}

// --- 入金 ---------------------------------------------------------------

/** 入金の記録 */
function recordPayment(args, ctx) {
  const db = getConnection();
  const customer = args.customer != null ? resolveRecord(db, 'customers', args.customer) : null;
  const input = compact({
    paidOn: args.paidOn,
    amount: args.amount,
    customerId: customer?.id,
    payerName: text(args.payerName),
    note: text(args.note),
  });

  return executeWrite({
    tool: 'record_payment',
    schema: schemas.payments.createSchema,
    input,
    args,
    ctx,
    run: (valid) => paymentService.recordPayment(valid, ctx.actor),
    warnings: (wdb, valid) => {
      // 同じ日・同じ金額・同じ得意先の入金がすでにあれば、二重に入れていないか知らせる
      const same = wdb
        .prepare(
          `SELECT payment_no FROM payments
            WHERE is_cancelled = 0 AND paid_on = ? AND amount = ? AND IFNULL(customer_id, 0) = ?`
        )
        .all(valid.paidOn ?? today(), valid.amount, valid.customerId ?? 0);
      return same.length ? [`同じ日・同じ金額の入金がすでにあります（${same.map((r) => r.payment_no).join(', ')}）`] : [];
    },
    log: (result, valid) =>
      logEntry('payment.create', 'payments', result.id,
        `入金 ${result.payment_no} を記録（${valid.amount}円${customer ? `、${customer.name}` : ''}）`),
  });
}

/**
 * 入金を請求に割り当てる（消し込み）。**1件ずつ足す。**
 *
 * 画面の消し込みは「全件差し替え」なので、そのまま呼ぶと既存の割り当てが消える。
 * ここでは既存の割り当て（端数を含む）をそのまま入れ直し、新しい1件を足してから渡す。
 * 既存を変えたり外したりはしない（修正は画面で）。
 */
function allocatePayment(args, ctx) {
  const db = getConnection();
  const payment = resolvePayment(db, args.payment);
  let target;
  if (args.consignmentReport != null) {
    const report = resolveConsignmentReport(db, args.consignmentReport);
    target = { consignmentReportId: report.id, label: report.report_no, customerId: report.customer_id };
  } else if (args.orderNo != null) {
    const orderNo = normalizeName(String(args.orderNo)).replace(/\s/g, '').toUpperCase();
    const row = db.prepare('SELECT order_no, customer_id FROM orders WHERE upper(order_no) = ? LIMIT 1').get(orderNo);
    if (!row) throw new McpInputError(`受注番号「${args.orderNo}」が見つかりません`, { code: 'not_found' });
    target = { orderNo: row.order_no, label: row.order_no, customerId: row.customer_id };
  } else {
    throw new McpInputError('割り当て先の受注番号（orderNo）か委託販売の報告番号（consignmentReport）を指定してください', {
      code: 'validation_error',
    });
  }

  const existing = db
    .prepare('SELECT order_no, consignment_report_id, amount, kind, note FROM payment_allocations WHERE payment_id = ? ORDER BY id')
    .all(payment.id)
    .map((a) =>
      compact({
        orderNo: a.order_no ?? undefined,
        consignmentReportId: a.consignment_report_id ?? undefined,
        amount: a.amount,
        kind: a.kind ?? undefined,
        note: a.note ?? undefined,
      })
    );
  const added = compact({
    orderNo: target.orderNo,
    consignmentReportId: target.consignmentReportId,
    amount: args.amount,
    kind: '入金',
    note: text(args.note),
  });

  return executeWrite({
    tool: 'allocate_payment',
    schema: schemas.payments.allocateSchema,
    input: { items: [...existing, added] },
    scope: { paymentId: payment.id },
    args,
    ctx,
    run: (valid) => paymentService.allocate(payment.id, valid.items, ctx.actor),
    warnings: (wdb) => {
      const out = [];
      if (payment.customer_id && target.customerId) {
        const family = customerService.familyIds(wdb, payment.customer_id);
        if (!family.includes(target.customerId)) out.push(`入金 ${payment.payment_no} の得意先と、${target.label} の得意先が違います`);
      }
      if (existing.length) out.push(`既存の割り当て ${existing.length}件はそのまま残し、1件を足します`);
      return out;
    },
    log: (_result, valid) =>
      logEntry('payment.allocate', 'payments', payment.id,
        `入金 ${payment.payment_no} を ${target.label} に ${valid.items[valid.items.length - 1].amount}円 割り当て`),
  });
}

// --- マスタ -------------------------------------------------------------

function duplicateWarning(db, table, name, label) {
  const same = similarNames(db, table, name);
  return same.length ? [`${label}「${same.map((r) => r.name).join('、')}」がすでにあります（ほぼ同じ名前）`] : [];
}

function autoCodeNote(code) {
  return code ? [`コードは自動で ${code} を付けます（見込み）`] : [];
}

/** 得意先の登録 */
function createCustomer(args, ctx) {
  const db = getConnection();
  const parent = args.parent != null ? resolveRecord(db, 'customers', args.parent, '本店') : null;
  // コードは画面と同じく、既存の続き番号を付ける（POST 自体は採番しないため、画面が入れている）
  const code = text(args.code) ?? nextMasterCode(db, { table: 'customers', defaultPrefix: 'C' }).code;
  const input = compact({
    code,
    name: text(args.name),
    segment: text(args.segment),
    businessType: text(args.businessType),
    markupRate: args.markupRate,
    address: text(args.address),
    paymentTermMonths: args.paymentTermMonths,
    paymentTermDay: text(args.paymentTermDay),
    invoiceDueNote: text(args.invoiceDueNote),
    salesRep: text(args.salesRep),
    salesSubRep: text(args.salesSubRep),
    salesChannel: text(args.salesChannel),
    note: text(args.note),
    parentId: parent?.id,
  });

  return executeWrite({
    tool: 'create_customer',
    schema: schemas.customers.createSchema,
    input,
    args,
    ctx,
    run: (valid) => {
      customerService.assertValidParent(null, valid.parentId ?? null);
      return customerModel.create(valid);
    },
    warnings: (wdb, valid) => [
      ...duplicateWarning(wdb, 'customers', valid.name, '得意先'),
      ...(text(args.code) ? [] : autoCodeNote(code)),
    ],
    log: (result) => logEntry('customer.create', 'customers', result.id, `得意先「${result.name}」（${result.code ?? 'コードなし'}）を登録`),
  });
}

/** 得意先の営業メモ */
function addCustomerNote(args, ctx) {
  const db = getConnection();
  const customer = resolveRecord(db, 'customers', args.customer);
  const input = compact({
    notedOn: args.notedOn ?? today(),
    category: args.category ?? 'メモ',
    body: text(args.body),
  });

  return executeWrite({
    tool: 'add_customer_note',
    schema: schemas.customers.noteSchema,
    input,
    scope: { customerId: customer.id },
    args,
    ctx,
    run: (valid) => customerNoteService.add({ customerId: customer.id, ...valid }, ctx.actor),
    log: (result, valid) => logEntry('customer.note', 'customer_notes', result.id, `${customer.name} にメモ（${valid.category}）`),
  });
}

/** 商品の登録（レシピは add_recipe_row で1行ずつ） */
function createProduct(args, ctx) {
  const db = getConnection();
  const code = text(args.code) ?? nextMasterCode(db, { table: 'products', defaultPrefix: 'P' }).code;
  const input = compact({
    code,
    name: text(args.name),
    volumeMl: args.volumeMl,
    abv: args.abv,
    containerType: text(args.containerType),
    unit: text(args.unit),
    listPrice: args.listPrice,
    janCode: text(args.janCode),
    category: text(args.category),
    taxCategory: text(args.taxCategory),
    note: text(args.note),
  });

  return executeWrite({
    tool: 'create_product',
    schema: schemas.products.createSchema,
    input,
    args,
    ctx,
    run: (valid) => productService.registerProductWithRecipe(valid, ctx.actor),
    warnings: (wdb, valid) => [
      ...duplicateWarning(wdb, 'products', valid.name, '商品'),
      ...(text(args.code) ? [] : autoCodeNote(code)),
    ],
    log: (result) => logEntry('product.create', 'products', result.id, `商品「${result.name}」（${result.code ?? 'コードなし'}）を登録`),
  });
}

/**
 * 製品レシピを1行足す。
 * 画面の口は「同じ組み合わせがあれば上書き」だが、コネクタは新規だけにする（上書き＝修正は画面で）。
 */
function addRecipeRow(args, ctx) {
  const db = getConnection();
  const product = resolveRecord(db, 'products', args.product);
  const material = resolveRecord(db, 'materials', args.material);
  const exists = db
    .prepare('SELECT qty_required FROM product_recipes WHERE product_id = ? AND material_id = ? AND process = ?')
    .get(product.id, material.id, args.process);
  if (exists) {
    throw new McpInputError(
      `${product.name} の${args.process}レシピには ${material.name} がすでにあります（1本あたり ${exists.qty_required}）。変えるときは画面で直してください`,
      { code: 'already_exists' }
    );
  }
  const input = compact({
    productId: product.id,
    materialId: material.id,
    qtyRequired: args.qtyRequired,
    process: args.process,
    recipeCode: text(args.recipeCode),
  });

  return executeWrite({
    tool: 'add_recipe_row',
    schema: schemas.products.recipeRowSchema,
    input,
    args,
    ctx,
    run: (valid) => productService.upsertRecipeRow(valid, ctx.actor),
    log: (result, valid) =>
      logEntry('recipe.create', 'product_recipes', result.id, `レシピ ${product.name} / ${material.name}（${valid.process}、1本あたり ${valid.qtyRequired}）を登録`),
  });
}

/** タンク（容器）の登録 */
function createTank(args, ctx) {
  const db = getConnection();
  let code = text(args.code);
  let codeNote = [];
  if (!code) {
    // 画面と同じ採番（容器種別・原酒の印・入荷年月から）
    code = tankService.nextTankCode({
      containerType: text(args.containerType),
      isRawSakeTank: args.isRawSakeTank,
      receivedYm: text(args.receivedYm),
    }).code;
    codeNote = autoCodeNote(code);
  }
  const input = compact({
    code,
    name: text(args.name),
    containerType: text(args.containerType),
    isRawSakeTank: args.isRawSakeTank,
    maxVolumeL: args.maxVolumeL,
    location: text(args.location),
    status: text(args.status),
    initialVolumeL: args.initialVolumeL,
    currentAbv: args.currentAbv,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'create_tank',
    schema: schemas.tanks.createSchema,
    input,
    args,
    ctx,
    run: (valid) => tankService.registerTank(valid, ctx.actor),
    warnings: (wdb, valid) => [...duplicateWarning(wdb, 'tanks', valid.name, 'タンク'), ...codeNote],
    log: (result) => logEntry('tank.create', 'tanks', result.id, `タンク「${result.code} ${result.name}」を登録`),
  });
}

/** 酒蔵の登録 */
function createBrewery(args, ctx) {
  const db = getConnection();
  const code = text(args.code) ?? nextMasterCode(db, { table: 'breweries', defaultPrefix: 'B' }).code;
  const input = compact({
    code,
    name: text(args.name),
    address: text(args.address),
    phone: text(args.phone),
    contact: text(args.contact),
    startedOn: args.startedOn,
  });

  return executeWrite({
    tool: 'create_brewery',
    schema: schemas.breweries.createSchema,
    input,
    args,
    ctx,
    run: (valid) => breweryModel.create(valid),
    warnings: (wdb, valid) => [
      ...duplicateWarning(wdb, 'breweries', valid.name, '酒蔵'),
      ...(text(args.code) ? [] : autoCodeNote(code)),
    ],
    log: (result) => logEntry('brewery.create', 'breweries', result.id, `酒蔵「${result.name}」を登録`),
  });
}

/** 原酒銘柄の登録 */
function createRawSakeBrand(args, ctx) {
  const db = getConnection();
  let breweryId;
  let breweryName;
  let breweryNote = [];
  if (args.brewery != null) {
    try {
      breweryId = resolveRecord(db, 'breweries', args.brewery).id;
    } catch (err) {
      if (err.code !== 'not_found' || typeof args.brewery !== 'string') throw err;
      // 酒蔵マスタに無い名前は、画面の「一覧にない酒蔵名を直接入力」と同じく名前のまま残す
      breweryName = text(args.brewery);
      breweryNote = [`酒蔵「${breweryName}」は酒蔵マスタにありません。名前のまま残します`];
    }
  }
  const input = compact({
    code: text(args.code),
    name: text(args.name),
    abv: args.abv,
    sakeMeterValue: args.sakeMeterValue,
    breweryId,
    breweryName,
    status: text(args.status),
    producedOn: text(args.producedOn),
    registeredOn: args.registeredOn,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'create_raw_sake_brand',
    schema: schemas.rawSakeBrands.createSchema,
    input,
    args,
    ctx,
    run: (valid) => rawSakeBrandModel.create(valid),
    warnings: () => breweryNote,
    log: (result) => logEntry('rawSakeBrand.create', 'raw_sake_brands', result.id, `原酒銘柄「${result.name}」（${result.code ?? '原酒IDなし'}）を登録`),
  });
}

/** 資材の登録 */
function createMaterial(args, ctx) {
  const db = getConnection();
  const code = text(args.code) ?? nextMasterCode(db, { table: 'materials', defaultPrefix: 'M' }).code;
  const input = compact({
    code,
    name: text(args.name),
    category: text(args.category),
    unit: text(args.unit),
    unitPrice: args.unitPrice,
    lotSize: args.lotSize,
    properStockQty: args.properStockQty,
    supplierName: text(args.supplierName),
    supplierAddress: text(args.supplierAddress),
    supplierContact: text(args.supplierContact),
    leadTimeDays: args.leadTimeDays,
    note: text(args.note),
  });

  return executeWrite({
    tool: 'create_material',
    schema: schemas.materials.createSchema,
    input,
    args,
    ctx,
    run: (valid) => materialService.createMaterial(valid, ctx.actor),
    warnings: (wdb, valid) => [
      ...duplicateWarning(wdb, 'materials', valid.name, '資材'),
      ...(text(args.code) ? [] : autoCodeNote(code)),
    ],
    log: (result) => logEntry('material.create', 'materials', result.id, `資材「${result.name}」（${result.code ?? 'コードなし'}）を登録`),
  });
}

// --- 読み取り -----------------------------------------------------------

const MASTER_TYPES = {
  得意先: 'customers',
  商品: 'products',
  資材: 'materials',
  酒蔵: 'breweries',
  原酒銘柄: 'raw_sake_brands',
};

function searchMaster({ type, query }) {
  return { results: searchRecords(getConnection(), MASTER_TYPES[type], query) };
}

function findOrders({ customer, orderNo, status, salesMethod, limit = 30 }) {
  const db = getConnection();
  const where = ['o.is_cancelled = 0'];
  const params = {};
  if (customer != null) {
    const c = resolveRecord(db, 'customers', customer);
    params.ids = JSON.stringify(customerService.familyIds(db, c.id));
    where.push('o.customer_id IN (SELECT value FROM json_each(@ids))');
  }
  if (orderNo) {
    params.orderNo = `%${normalizeName(String(orderNo)).replace(/\s/g, '').toUpperCase()}%`;
    where.push('upper(o.order_no) LIKE @orderNo');
  }
  if (status) { params.status = status; where.push('o.status = @status'); }
  if (salesMethod) { params.salesMethod = salesMethod; where.push('o.sales_method = @salesMethod'); }
  params.limit = Math.min(limit, 100);
  return {
    orders: db
      .prepare(`${ORDER_SQL} WHERE ${where.join(' AND ')} ORDER BY o.ordered_on DESC, o.order_no DESC, o.line_no LIMIT @limit`)
      .all(params)
      .map(describeOrderLine),
  };
}

function listOpenInvoices({ customer }) {
  const db = getConnection();
  const customerId = customer != null ? resolveRecord(db, 'customers', customer).id : null;
  return { invoices: paymentService.listOpenInvoices({ customerId, limit: 100 }) };
}

function listWipLots({ product }) {
  const db = getConnection();
  const productId = product != null ? resolveRecord(db, 'products', product).id : null;
  return { lots: wipLotService.listLots(productId) };
}

function listPendingConsignments() {
  return { orders: shipmentService.listPendingConsignmentOrders() };
}

function getRegistrationOptions() {
  return {
    salesMethods: SALES_METHODS,
    deliveryMethods: DELIVERY_METHODS,
    samplePurposes: shipmentService.SHIPMENT_PURPOSES,
    taxFreeDestinations: ['熟成室', '浄溜所', 'その他'],
    customerNoteCategories: ['メモ', '訪問', '電話', '課題'],
    quotationStatuses: ['見積中', '受注', '失注'],
    recipeProcesses: ['瓶詰', '箱詰'],
    tankContainerTypes: tankService.listTankPrefixes(),
    cartonMaterials: shippingFeeService.listCartonMaterials(),
  };
}

module.exports = {
  receiveRawSake,
  recordBottling,
  recordBoxing,
  transferTank,
  recordTaxFreeTransfer,
  receiveMaterial,
  createOrder,
  shipOrder,
  recordReturn,
  recordSample,
  recordConsignmentReport,
  createQuotation,
  recordPayment,
  allocatePayment,
  createCustomer,
  addCustomerNote,
  createProduct,
  addRecipeRow,
  createTank,
  createBrewery,
  createRawSakeBrand,
  createMaterial,
  searchMaster,
  findOrders,
  listOpenInvoices,
  listWipLots,
  listPendingConsignments,
  getRegistrationOptions,
  MASTER_TYPES,
  SALES_METHODS,
  DELIVERY_METHODS,
};
