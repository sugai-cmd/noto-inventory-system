// 音声入力のコネクタ（MCP）から、蒸留以外の登録をしたときの検証。
//
// いちばん大事なのは「画面から入れた場合と、できる記録が同じ」こと。
// 同じ内容を画面のAPIとコネクタの両方で登録し、増えた行を突き合わせる
// （番号・ID・登録者のように、入れるたびに変わる列だけは比べない）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-mcp-registrations.sqlite');
const api = harness.api;

let db;
let tools;
let ctx;

/** 突き合わせる表。登録で行が増えうるものを全部並べる */
const TABLES = [
  'raw_sake_ledger',
  'raw_sake_lot_allocations',
  'tank_ledger',
  'product_stock_ledger',
  'material_stock_ledger',
  'wip_lot_allocations',
  'orders',
  'sample_shipments',
  'consignment_reports',
  'quotations',
  'payments',
  'payment_allocations',
];

/** 入れるたびに変わる列（番号・ID・登録者・時刻） */
const VOLATILE = /^(id|uid|created_at|updated_at|created_by|.*_no|.*_code|.*_ledger_id|order_id|sample_shipment_id|payment_id|consignment_report_id)$/;

function maxIds() {
  return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get().m]));
}

function newRows(since, extraExclude = []) {
  const out = {};
  for (const t of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t} WHERE id > ? ORDER BY id`).all(since[t]);
    if (!rows.length) continue;
    out[t] = rows.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k) && !extraExclude.includes(k)))
    );
  }
  return out;
}

/** 画面のAPIで1回、コネクタで1回登録し、増えた行が同じかを確かめる */
async function assertSameAsScreen({ screen, mcp, exclude = [] }) {
  const a = maxIds();
  const res = await screen();
  assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
  const screenRows = newRows(a, exclude);

  const b = maxIds();
  const result = mcp();
  assert.equal(result.saved, true, JSON.stringify(result));
  const mcpRows = newRows(b, exclude);

  assert.ok(Object.keys(screenRows).length > 0, '画面の登録で行が増えていない');
  assert.deepEqual(mcpRows, screenRows);
  return { res, result };
}

let keySeq = 0;
const key = () => `test-key-${++keySeq}-xxxx`;

const id = (table, code) => db.prepare(`SELECT id FROM ${table} WHERE code = ?`).get(code).id;

test.before(async () => {
  ({ db } = await harness.setup());
  tools = require('../../src/mcp/registrationTools');
  const authService = require('../../src/services/authService');
  ctx = { actor: authService.toPublicUser(db.prepare("SELECT * FROM users WHERE username = 'tester'").get()), clientName: 'テスト' };

  const post = async (path, body) => {
    const r = await api('POST', path, body);
    assert.ok(r.status === 201 || r.status === 200, `${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  // マスタは画面のAPIで作る
  await post('/api/customers', { code: 'C0001', name: '山田酒店', markupRate: 0.7, paymentTermMonths: 1, paymentTermDay: '末' });
  await post('/api/products', { code: 'P0001', name: '浄酎300', volumeMl: 300, listPrice: 1000 });
  await post('/api/materials', { code: 'M0001', name: '300ml瓶', category: '瓶', unit: '本', unitPrice: 50 });
  await post('/api/materials', { code: 'M0002', name: '6本箱', category: '外箱', unit: '枚', unitPrice: 80 });
  await post('/api/products/recipes', { productId: id('products', 'P0001'), materialId: id('materials', 'M0001'), qtyRequired: 1, process: '瓶詰' });
  for (const [code, name] of [['SP-01', '原酒ポリ1'], ['SP-02', '原酒ポリ2']]) {
    await post('/api/tanks', { code, name, containerType: '原酒ポリタンク', maxVolumeL: 200 });
  }
  await post('/api/tanks', { code: 'T-001', name: '浄酎タンク1', containerType: 'ステンレスタンク', maxVolumeL: 1000, initialVolumeL: 500 });
  await post('/api/tanks', { code: 'T-002', name: '浄酎タンク2', containerType: 'ステンレスタンク', maxVolumeL: 1000 });
});

test.after(async () => {
  await harness.teardown();
});

// --- 現場の作業 ---

test('原酒入荷：画面とコネクタで同じ記録になる', async () => {
  await assertSameAsScreen({
    screen: () => api('POST', '/api/raw-sake-receipts/bulk', {
      txnDate: '2026-11-10', items: [{ toTankId: id('tanks', 'SP-01'), quantity: 120 }], supplier: '山田酒造',
    }),
    mcp: () => tools.receiveRawSake({ txnDate: '2026-11-10', items: [{ tank: '原酒ポリ2', quantityL: 120 }], supplier: '山田酒造', requestKey: key() }, ctx),
    exclude: ['to_tank_id', 'to_ref', 'receipt_ledger_id'],
  });
});

test('瓶詰め：画面とコネクタで同じ記録になり、資材も同じだけ減る', async () => {
  const { result } = await assertSameAsScreen({
    screen: () => api('POST', '/api/bottling', {
      productId: id('products', 'P0001'), quantity: 10, tankId: id('tanks', 'T-001'), volumeL: 3, txnDate: '2026-11-10',
    }),
    mcp: () => tools.recordBottling({ product: '浄酎300', quantity: 10, tank: '浄酎タンク1', volumeL: 3, txnDate: '2026-11-10', requestKey: key() }, ctx),
  });
  const t = result.changes.tanks[0];
  assert.deepEqual([t.beforeL, t.afterL], [497, 494]);
  assert.equal(result.changes.products[0].wipStockAfter - result.changes.products[0].wipStockBefore, 10);
});

test('瓶詰め：残量を超える・原酒タンクから、は注意点に出る（登録の可否は画面と同じ）', () => {
  const p = tools.recordBottling({ product: 'P0001', quantity: 10, tank: 'SP-01', volumeL: 999, preview: true }, ctx);
  assert.equal(p.wouldSucceed, true);
  const joined = p.warnings.join('\n');
  assert.match(joined, /原酒タンクです。浄酎タンクではありません/);
  assert.match(joined, /払出量 999L が多い/);
  assert.match(joined, /3L ですが、払出量は 999L/);
});

test('箱詰め：画面とコネクタで同じ記録になる', async () => {
  await assertSameAsScreen({
    screen: () => api('POST', '/api/boxing', { productId: id('products', 'P0001'), quantity: 4, txnDate: '2026-11-11' }),
    mcp: () => tools.recordBoxing({ product: '浄酎300', quantity: 4, txnDate: '2026-11-11', requestKey: key() }, ctx),
    exclude: ['bottling_ledger_id', 'boxing_ledger_id'],
  });
});

test('容器移動・未納税移出：画面とコネクタで同じ記録になる', async () => {
  await assertSameAsScreen({
    screen: () => api('POST', '/api/tank-operations/transfer', {
      fromTankId: id('tanks', 'T-001'), toTankId: id('tanks', 'T-002'), quantityL: 20, txnDate: '2026-11-11',
    }),
    mcp: () => tools.transferTank({ fromTank: '浄酎タンク1', toTank: 'T-002', quantityL: 20, txnDate: '2026-11-11', requestKey: key() }, ctx),
  });
  await assertSameAsScreen({
    screen: () => api('POST', '/api/tank-operations/tax-free-transfer', {
      fromTankId: id('tanks', 'T-001'), quantityL: 5, destination: '熟成室', txnDate: '2026-11-11',
    }),
    mcp: () => tools.recordTaxFreeTransfer({ fromTank: 'T-001', quantityL: 5, destination: '熟成室', txnDate: '2026-11-11', requestKey: key() }, ctx),
  });
});

test('資材入荷：画面とコネクタで同じ記録になる（単価・仕入先はマスタから）', async () => {
  await assertSameAsScreen({
    screen: () => api('POST', '/api/materials/receipts', { materialId: id('materials', 'M0001'), quantity: 100, txnDate: '2026-11-11' }),
    mcp: () => tools.receiveMaterial({ material: '300ml瓶', quantity: 100, txnDate: '2026-11-11', requestKey: key() }, ctx),
  });
});

// --- 受注・出荷 ---

async function screenOrderPayload(extra = {}) {
  // 画面（orders.html）と同じ：入金予定日は既定値APIの値、送料0、買取・配送
  const customerId = id('customers', 'C0001');
  const productId = id('products', 'P0001');
  const defaults = (await api('GET', `/api/orders/defaults?customerId=${customerId}&productId=${productId}&quantity=6&deliveredOn=2026-11-20`)).body;
  return {
    orderedOn: '2026-11-12', customerId, items: [{ productId, quantity: 6 }], shippingFee: 0,
    salesMethod: '買取', deliveryMethod: '配送', requestedDeliveryOn: '2026-11-20', paymentDueOn: defaults.paymentDueOn, ...extra,
  };
}

let orderA;
let orderB;

test('受注登録：画面とコネクタで同じ記録になる（単価・売価・入金予定日も同じ）', async () => {
  const payload = await screenOrderPayload();
  const { res, result } = await assertSameAsScreen({
    screen: () => api('POST', '/api/orders', payload),
    mcp: () => tools.createOrder({ orderedOn: '2026-11-12', customer: '山田酒店', items: [{ product: '浄酎300', quantity: 6 }], requestedDeliveryOn: '2026-11-20', requestKey: key() }, ctx),
  });
  orderA = res.body.order_no;
  orderB = result.record.order_no;
  assert.equal(result.record.sales_amount, 4200); // 1000円 × 6本 × 掛率0.7
});

test('発送済み：画面とコネクタで同じ記録になる（段ボールも同じだけ減る）', async () => {
  const cartonId = id('materials', 'M0002');
  const lineA = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(orderA).id;
  await assertSameAsScreen({
    screen: () => api('POST', `/api/orders/${lineA}/ship`, { deliveredOn: '2026-11-13', cartons: [{ materialId: cartonId, quantity: 1 }] }),
    mcp: () => tools.shipOrder({ order: orderB, deliveredOn: '2026-11-13', cartons: [{ material: '6本箱', quantity: 1 }], requestKey: key() }, ctx),
    exclude: ['order_id'],
  });
  assert.equal(db.prepare('SELECT status FROM orders WHERE order_no = ?').get(orderB).status, '発送済');
});

test('返品・無償出荷：画面とコネクタで同じ記録になる', async () => {
  const productId = id('products', 'P0001');
  const customerId = id('customers', 'C0001');
  await assertSameAsScreen({
    screen: () => api('POST', '/api/shipments/returns', { productId, quantity: 1, txnDate: '2026-11-14', customerId, reason: '破損' }),
    mcp: () => tools.recordReturn({ product: '浄酎300', quantity: 1, txnDate: '2026-11-14', customer: '山田酒店', reason: '破損', requestKey: key() }, ctx),
  });
  await assertSameAsScreen({
    screen: () => api('POST', '/api/shipments/samples', { productId, quantity: 2, shippedOn: '2026-11-14', purpose: 'サンプル', customerId }),
    mcp: () => tools.recordSample({ product: '浄酎300', quantity: 2, shippedOn: '2026-11-14', customer: '山田酒店', requestKey: key() }, ctx),
    exclude: ['note'], // 在庫履歴の備考に無償出荷の番号が入る
  });
});

test('委託販売の報告：画面とコネクタで同じ記録になる', async () => {
  const payload = await screenOrderPayload({ salesMethod: '委託' });
  const a = (await api('POST', '/api/orders', payload)).body;
  const b = tools.createOrder({ orderedOn: '2026-11-12', customer: '山田酒店', items: [{ product: '浄酎300', quantity: 6 }], salesMethod: '委託', requestedDeliveryOn: '2026-11-20', requestKey: key() }, ctx);
  await assertSameAsScreen({
    screen: () => api('POST', '/api/shipments/consignment', { orderId: a.id, reportMonth: '2026-11', quantity: 2 }),
    mcp: () => tools.recordConsignmentReport({ order: b.record.order_no, reportMonth: '2026-11', quantity: 2, requestKey: key() }, ctx),
  });
});

test('見積：画面とコネクタで同じ記録になる（確度は % で受け取る）', async () => {
  await assertSameAsScreen({
    screen: () => api('POST', '/api/quotations', {
      quotedOn: '2026-11-14', customerId: id('customers', 'C0001'), productId: id('products', 'P0001'), quantity: 24, status: '見積中', probability: 0.5,
    }),
    mcp: () => tools.createQuotation({ quotedOn: '2026-11-14', customer: '山田酒店', product: '浄酎300', quantity: 24, probabilityPercent: 50, requestKey: key() }, ctx),
  });
  const rows = db.prepare('SELECT probability FROM quotations ORDER BY id DESC LIMIT 2').all();
  assert.deepEqual(rows.map((r) => r.probability), [0.5, 0.5]);
});

// --- 入金 ---

test('入金と消し込み：画面とコネクタで同じ記録になり、既存の割り当ては消えない', async () => {
  const customerId = id('customers', 'C0001');
  const { res, result } = await assertSameAsScreen({
    screen: () => api('POST', '/api/payments', { paidOn: '2026-11-30', amount: 5000, customerId }),
    mcp: () => tools.recordPayment({ paidOn: '2026-11-30', amount: 5000, customer: '山田酒店', requestKey: key() }, ctx),
  });
  const payA = res.body;
  const payB = result.record;

  await assertSameAsScreen({
    screen: () => api('PUT', `/api/payments/${payA.id}/allocations`, { items: [{ orderNo: orderA, amount: 3000, kind: '入金' }] }),
    mcp: () => tools.allocatePayment({ payment: payB.payment_no, orderNo: orderB, amount: 3000, requestKey: key() }, ctx),
  });

  // 2件目を足しても、1件目は残る（画面の口は全件差し替えなので、ここで消えないことが大事）
  const second = tools.allocatePayment({ payment: payB.payment_no, orderNo: orderB, amount: 1000, requestKey: key() }, ctx);
  assert.equal(second.saved, true, JSON.stringify(second));
  const rows = db.prepare('SELECT amount FROM payment_allocations WHERE payment_id = ? ORDER BY id').all(payB.id);
  assert.deepEqual(rows.map((r) => r.amount), [3000, 1000]);

  // 入金額を超える割り当ては、画面と同じく断られる
  const over = tools.allocatePayment({ payment: payB.payment_no, orderNo: orderB, amount: 5000, preview: true }, ctx);
  assert.equal(over.wouldSucceed, false);
});

// --- マスタ ---

test('得意先：コードを省くと続き番号、ほぼ同じ名前は注意点に出る', () => {
  const p = tools.createCustomer({ name: '山田 酒店', preview: true }, ctx);
  assert.equal(p.wouldSucceed, true);
  assert.equal(p.input.code, 'C0002');
  assert.ok(p.warnings.some((w) => w.includes('山田酒店')));

  const r = tools.createCustomer({ name: '佐藤商店', parent: '山田酒店', markupRate: 0.75, requestKey: key() }, ctx);
  assert.equal(r.saved, true);
  assert.equal(r.record.code, 'C0002');
  assert.equal(r.record.parent_id, id('customers', 'C0001'));

  // 同じ名前は画面と同じく断られる（サーバーの故障にはしない）
  const dup = tools.createCustomer({ name: '佐藤商店', preview: true }, ctx);
  assert.equal(dup.wouldSucceed, false);
  assert.match(dup.error.message, /得意先名はすでに登録されています/);

  const memo = tools.addCustomerNote({ customer: '佐藤商店', body: '試飲会に参加', category: '訪問', requestKey: key() }, ctx);
  assert.equal(memo.record.category, '訪問');
});

test('商品・レシピ・資材・タンク・酒蔵・原酒銘柄を登録できる', () => {
  const product = tools.createProduct({ name: '浄酎700', volumeMl: 700, listPrice: 2500, requestKey: key() }, ctx);
  assert.equal(product.record.code, 'P0002');
  assert.equal(product.record.unit, '本'); // 単位を省くとサーバーの既定

  const material = tools.createMaterial({ name: '700ml瓶', category: '瓶', requestKey: key() }, ctx);
  assert.equal(material.record.code, 'M0003');

  const recipe = tools.addRecipeRow({ product: '浄酎700', material: '700ml瓶', process: '瓶詰', qtyRequired: 1, requestKey: key() }, ctx);
  assert.equal(recipe.saved, true);
  // 同じ組み合わせは上書きせず断る（修正は画面で）
  assert.throws(
    () => tools.addRecipeRow({ product: '浄酎700', material: '700ml瓶', process: '瓶詰', qtyRequired: 2, preview: true }, ctx),
    /すでにあります/
  );

  const tank = tools.createTank({ name: '原酒ポリ3', containerType: '原酒ポリタンク', maxVolumeL: 200, requestKey: key() }, ctx);
  assert.equal(tank.record.code, 'SP-03');
  assert.equal(tank.record.status, '稼働中');

  const brewery = tools.createBrewery({ name: '能登酒造', requestKey: key() }, ctx);
  assert.match(brewery.record.code, /^B/);

  const known = tools.createRawSakeBrand({ name: '池月', code: 'L9001', brewery: '能登酒造', requestKey: key() }, ctx);
  assert.equal(known.record.brewery_id, brewery.record.id);
  const unknown = tools.createRawSakeBrand({ name: '宗玄', code: 'L9002', brewery: '宗玄酒造', requestKey: key() }, ctx);
  assert.equal(unknown.record.brewery_id, null);
  assert.equal(unknown.record.brewery_name_raw, '宗玄酒造');
  assert.ok(unknown.warnings.some((w) => w.includes('酒蔵マスタにありません')));
});

// --- 共通の決まり ---

test('preview ではどの登録も何も保存されない', () => {
  const counts = () => Object.fromEntries([...TABLES, 'customers', 'products', 'materials', 'tanks', 'operation_logs', 'mcp_requests']
    .map((t) => [t, db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));
  const before = counts();
  const previews = [
    tools.receiveRawSake({ items: [{ tank: 'SP-03', quantityL: 10 }], preview: true }, ctx),
    tools.recordBottling({ product: 'P0001', quantity: 1, tank: 'T-001', volumeL: 0.3, preview: true }, ctx),
    tools.transferTank({ fromTank: 'T-001', toTank: 'T-002', quantityL: 1, preview: true }, ctx),
    tools.receiveMaterial({ material: 'M0001', quantity: 1, preview: true }, ctx),
    tools.createOrder({ orderedOn: '2026-11-15', customer: 'C0001', items: [{ product: 'P0001', quantity: 1 }], preview: true }, ctx),
    tools.recordPayment({ amount: 100, preview: true }, ctx),
    tools.createProduct({ name: '試し', preview: true }, ctx),
    tools.createTank({ name: '試しタンク', code: 'T-099', preview: true }, ctx),
  ];
  for (const p of previews) assert.equal(p.saved, false, JSON.stringify(p));
  assert.deepEqual(counts(), before);
});

test('同じ requestKey は2件目を作らず、別の対象に使うと断る', () => {
  const k = key();
  const first = tools.receiveMaterial({ material: 'M0001', quantity: 7, requestKey: k }, ctx);
  const again = tools.receiveMaterial({ material: '300ml瓶', quantity: 7, requestKey: k }, ctx);
  assert.equal(again.duplicate, true);
  assert.equal(again.record.ledgerId, first.record.ledgerId);
  assert.throws(() => tools.receiveMaterial({ material: 'M0001', quantity: 8, requestKey: k }, ctx), /別の内容/);
});

test('あいまいな名前は登録せず候補を返す', () => {
  tools.createProduct({ name: '浄酎300 ギフト', requestKey: key() }, ctx);
  assert.throws(
    () => tools.createOrder({ orderedOn: '2026-11-15', customer: 'C0001', items: [{ product: '浄酎', quantity: 1 }], preview: true }, ctx),
    (err) => err.code === 'not_found' && err.candidates.length >= 2
  );
});

test('操作ログに「音声入力（MCP）経由」と登録者が残る', () => {
  const rows = db.prepare("SELECT action, username, summary FROM operation_logs WHERE action LIKE 'mcp.%'").all();
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['mcp.rawSake.receipt', 'mcp.bottling', 'mcp.boxing', 'mcp.tank.transfer', 'mcp.order.create', 'mcp.order.ship',
    'mcp.payment.create', 'mcp.payment.allocate', 'mcp.customer.create', 'mcp.product.create', 'mcp.tank.create']) {
    assert.ok(actions.has(a), a);
  }
  for (const r of rows) {
    assert.equal(r.username, 'tester');
    assert.match(r.summary, /^【音声入力（MCP）経由】/);
  }
});
