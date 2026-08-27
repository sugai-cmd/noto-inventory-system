// 受注登録 → 瓶詰め → 箱詰め → 発送済 の一連フローをHTTP経由で検証する。
// DATA_STRUCTURE.md 5章「機能一覧とその成果物」の主要フローが、
// 新スキーマ上で在庫と正しく連動することを担保する。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// config.js は読込時に DB_PATH を評価するため、他のrequireより前に設定する
const TEST_DB_PATH = path.resolve(__dirname, '..', '..', 'db', 'test-order-flow.sqlite');
for (const ext of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + ext, { force: true });
process.env.DB_PATH = TEST_DB_PATH;

const { migrate } = require('../../src/db/migrate');
const { getConnection } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { generateUid } = require('../../src/utils/uid');

let server;
let baseUrl;

async function api(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test.before(async () => {
  migrate();
  const db = getConnection();

  // マスタを用意（レシピ・タンクはAPI未実装のため直接投入する）
  db.prepare(
    `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
     VALUES (?, '株式会社NOTO', 0.7, 1, '末日')`
  ).run(generateUid(db, 'customers'));
  db.prepare(
    `INSERT INTO products (uid, name, volume_ml, list_price, tax_per_unit,
                           initial_product_stock, initial_wip_stock)
     VALUES (?, '浄酎 300ml', 300, 3000, 300, 0, 0)`
  ).run(generateUid(db, 'products'));
  db.prepare(
    `INSERT INTO materials (uid, name, unit, unit_price, proper_stock_qty, initial_stock)
     VALUES (?, '300ml瓶', '本', 100, 1000, 500)`
  ).run(generateUid(db, 'materials'));
  db.prepare(
    `INSERT INTO materials (uid, name, unit, unit_price, proper_stock_qty, initial_stock)
     VALUES (?, '化粧箱', '枚', 50, 500, 300)`
  ).run(generateUid(db, 'materials'));
  db.prepare(
    `INSERT INTO product_recipes (product_id, material_id, qty_required, process)
     VALUES (1, 1, 1, '瓶詰'), (1, 2, 1, '箱詰')`
  ).run();
  db.prepare(
    `INSERT INTO tanks (uid, code, name, max_volume_l, initial_volume_l, current_abv)
     VALUES (?, 'T-01', '浄酎タンク1', 1000, 100, 40)`
  ).run(generateUid(db, 'tanks'));

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + ext, { force: true });
});

test('受注登録の初期値は得意先の掛率と支払いサイトから計算される（2.3）', async () => {
  const { status, body } = await api(
    'GET',
    '/api/orders/defaults?customerId=1&productId=1&quantity=10&deliveredOn=2026-08-08'
  );
  assert.equal(status, 200);
  assert.equal(body.unitPrice, 3000);
  assert.equal(body.markupRate, 0.7);
  assert.equal(body.salesAmount, 21000); // 3000 * 10 * 0.7
  assert.equal(body.paymentDueOn, '2026-09-30'); // 納品8/8 + 翌月末日
});

test('受注番号は月ごとの連番で自動採番される', async () => {
  const first = await api('POST', '/api/orders', {
    orderedOn: '2026-08-05',
    customerId: 1,
    productId: 1,
    quantity: 10,
    shippingFee: 800,
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.order_no, 'O2608-0001');
  assert.equal(first.body.sales_amount, 21000);
  assert.equal(first.body.total_amount, 21800); // 売価 + 送料

  const second = await api('POST', '/api/orders', {
    orderedOn: '2026-08-06',
    customerId: 1,
    productId: 1,
    quantity: 5,
  });
  assert.equal(second.body.order_no, 'O2608-0002');
});

test('瓶詰めは仕掛品を増やし、レシピに沿って資材を消費する', async () => {
  const { status, body } = await api('POST', '/api/bottling', {
    productId: 1,
    quantity: 100,
    tankId: 1,
    volumeL: 30,
    txnDate: '2026-08-02',
  });
  assert.equal(status, 201);
  assert.equal(body.stock.wip_stock, 100);
  assert.equal(body.stock.product_stock, 0);

  const bottle = body.consumedMaterials.find((m) => m.materialName === '300ml瓶');
  assert.equal(bottle.quantity, 100);

  // 資材在庫モニター（7-1の新設ビュー）にも反映されている
  const stock = await api('GET', '/api/materials/stock');
  const bottleStock = stock.body.find((m) => m.name === '300ml瓶');
  assert.equal(bottleStock.current_stock, 400); // 初期500 - 消費100
});

test('箱詰めは仕掛品を完成品へ振り替える', async () => {
  const { status, body } = await api('POST', '/api/boxing', {
    productId: 1,
    quantity: 50,
    txnDate: '2026-08-03',
  });
  assert.equal(status, 201);
  assert.equal(body.stock.wip_stock, 50); // 100 - 50
  assert.equal(body.stock.product_stock, 50);
});

test('仕掛品が足りない箱詰めは422で拒否される', async () => {
  const { status, body } = await api('POST', '/api/boxing', { productId: 1, quantity: 999 });
  assert.equal(status, 422);
  assert.equal(body.error, 'business_rule_violation');
  assert.match(body.message, /仕掛品在庫が不足/);
});

test('発送済にすると在庫が減り、出荷履歴にorder_idが紐付く', async () => {
  const { status, body } = await api('POST', '/api/orders/1/ship', { deliveredOn: '2026-08-08' });
  assert.equal(status, 200);
  assert.equal(body.order.status, '発送済');
  assert.equal(body.order.delivered_on, '2026-08-08');
  assert.equal(body.order.payment_due_on, '2026-09-30');

  const db = getConnection();
  const ledger = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(body.stockLedgerId);
  assert.equal(ledger.txn_type, '出荷');
  assert.equal(ledger.order_id, 1); // 6-3で課題だった受注との突合が新規データでは常に成立する
  assert.equal(ledger.quantity, 10);
  assert.equal(ledger.tax_amount, 3000); // 課税額300 * 10本

  const stock = await api('GET', '/api/products/1/stock');
  assert.equal(stock.body.product_stock, 40); // 50 - 出荷10
});

test('同じ受注を二重に発送済にすると409で拒否される', async () => {
  const { status, body } = await api('POST', '/api/orders/1/ship', {});
  assert.equal(status, 409);
  assert.equal(body.error, 'conflict');
  assert.match(body.message, /既に発送済/);
});

test('存在しない商品の瓶詰めは404を返す', async () => {
  const { status, body } = await api('POST', '/api/bottling', {
    productId: 999,
    quantity: 1,
    tankId: 1,
    volumeL: 1,
  });
  assert.equal(status, 404);
  assert.equal(body.error, 'not_found');
});

test('不正な入力は400で弾かれる', async () => {
  const { status, body } = await api('POST', '/api/orders', {
    orderedOn: '2026/08/05', // ハイフン区切りでない
    customerId: 1,
    productId: 1,
    quantity: 10,
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'validation_error');
});

test('得意先・商品のインクリメンタル検索が動作する（2.2）', async () => {
  const customers = await api('GET', '/api/customers/search?q=NOTO');
  assert.equal(customers.status, 200);
  assert.ok(customers.body.some((c) => c.name === '株式会社NOTO'));

  const products = await api('GET', '/api/products/search?q=300');
  assert.ok(products.body.some((p) => p.name === '浄酎 300ml'));
  // 検索結果に在庫が含まれ、在庫僅少アラートに使える
  assert.ok('product_stock' in products.body[0]);
});

test('タンクモニターは充填本数換算を返す（旧タンクモニターシートの置き換え）', async () => {
  const { status, body } = await api('GET', '/api/tanks/monitor');
  assert.equal(status, 200);
  const tank = body.find((t) => t.code === 'T-01');
  assert.equal(tank.current_volume_l, 70); // 初期100 - 瓶詰で払い出した30
  assert.equal(tank.bottles300ml, 233); // 70L / 300ml
  assert.equal(tank.bottles700ml, 100); // 70L / 700ml
});
