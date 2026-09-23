// 受注一覧の絞り込み結果の合計（PR F）。
//
// 一覧は**ページ送りがある**ので、画面に出ている行を足しても答えにならない。
// 絞り込み全体をサーバーで足して返す。
//
// **保存されている合計欄（total_amount）は読まない。** 式が揃っていないため。
//   移行データ103件 … 売価 × 1.1（送料を含んでいない）
//   移行データ  14件 … (売価 + 送料) × 1.1
//   いまのコード      … 売価 + 送料（税を足さない）
// 足すと何の数字か言えなくなるので、売価と送料から出し直す。
//
// **消費税は売価にだけ掛ける。** 送料は #54 以降、税込・50円繰り上げ後の金額が入っている。
//
// この案件では「通るのに何も確かめていない試験」を4回書いた。
// ここでは1つずつ、**直しを外すと落ちる**形にしてある。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-order-summary.sqlite');
const api = harness.api;

let db;

const CUSTOMER_A = 1;
const CUSTOMER_B = 2;
const PRODUCT = 1;

/** 絞り込み条件を付けて一覧を取る */
const listWith = async (query = '') => (await api('GET', `/api/orders?${query}`)).body;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const cust = db.prepare('INSERT INTO customers (uid, code, name) VALUES (?, ?, ?)');
    cust.run(generateUid(db, 'customers'), 'C-001', '株式会社NOTO');
    cust.run(generateUid(db, 'customers'), 'C-002', '能登商店');

    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, list_price)
       VALUES (?, 'P-001', '浄酎 300ml', 300, 3000)`
    ).run(generateUid(db, 'products'));

    const ins = db.prepare(
      `INSERT INTO orders
         (order_no, line_no, ordered_on, customer_id, product_id, quantity,
          sales_amount, shipping_fee, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // 得意先A: 10件、売価1000・送料100ずつ
    for (let i = 0; i < 10; i += 1) {
      ins.run(`O2608-${String(i + 1).padStart(4, '0')}`, 1, '2026-08-01',
        CUSTOMER_A, PRODUCT, 2, 1000, 100, 999999, '未着手');
    }
    // 得意先B: 5件、売価2000・送料200ずつ
    for (let i = 0; i < 5; i += 1) {
      ins.run(`O2609-${String(i + 1).padStart(4, '0')}`, 1, '2026-09-01',
        CUSTOMER_B, PRODUCT, 3, 2000, 200, 999999, '発送済');
    }
    // 複数明細の受注1件（2行）。件数の2種類を確かめるために要る。
    // 送料は1行目だけに載る（submitOrder と同じ形）
    ins.run('O2609-9001', 1, '2026-09-02', CUSTOMER_B, PRODUCT, 1, 500, 300, 999999, '発送済');
    ins.run('O2609-9001', 2, '2026-09-02', CUSTOMER_B, PRODUCT, 1, 700, 0, 999999, '発送済');

    // total_amount には**でたらめな値**（999999）を入れてある。
    // 集計がこれに引きずられないことを確かめるため
  }));
});

test.after(() => harness.teardown());

// --- 基本 -------------------------------------------------------------------

test('絞り込み無しの合計が、実際の行の足し算と一致する', async () => {
  const { summary } = await listWith();

  const expected = db
    .prepare(
      `SELECT COUNT(*) lines, COUNT(DISTINCT order_no) orders,
              SUM(quantity) quantity, SUM(sales_amount) sales, SUM(shipping_fee) shipping
         FROM orders`
    )
    .get();

  assert.equal(summary.lines, expected.lines);
  assert.equal(summary.orders, expected.orders);
  assert.equal(summary.quantity, expected.quantity);
  assert.equal(summary.salesAmount, expected.sales);
  assert.equal(summary.shippingFee, expected.shipping);

  // 売価 10×1000 + 5×2000 + 500 + 700 = 21200
  assert.equal(summary.salesAmount, 21200);
  assert.equal(summary.salesTax, 2120);
  // 送料 10×100 + 5×200 + 300 = 2300
  assert.equal(summary.shippingFee, 2300);
  assert.equal(summary.total, 21200 + 2120 + 2300);
});

test('件数は「受注番号」と「明細行」の両方を返す', async () => {
  const { summary } = await listWith();
  assert.equal(summary.lines, 17, '明細行の数');
  assert.equal(summary.orders, 16, '受注番号の数');
  // 同じ数だと、2種類を数えていることを確かめたことにならない
  assert.ok(summary.orders < summary.lines, '複数明細の受注を仕込めていない');
});

// --- 保存されている合計欄に引きずられない ------------------------------------

test('保存されている合計欄（total_amount）を足していない', async () => {
  const { summary } = await listWith();

  // 仕込みは全行 999999。足すと 17 × 999999 = 16999983 になる
  const stored = db.prepare('SELECT SUM(total_amount) AS n FROM orders').get().n;
  assert.equal(stored, 17 * 999999, '仕込みが効いていない（この試験は空振りする）');
  assert.notEqual(summary.total, stored, '合計欄をそのまま足してしまっている');
  assert.equal(summary.total, 25620);
});

// --- 税 ---------------------------------------------------------------------

test('消費税は売価にだけ掛かる。送料には掛けない', async () => {
  const before = (await listWith()).summary;

  // 送料だけを10倍にしても、消費税は変わらないはず
  db.prepare('UPDATE orders SET shipping_fee = shipping_fee * 10').run();
  try {
    const after = (await listWith()).summary;
    assert.equal(after.salesTax, before.salesTax, '送料にも税を掛けてしまっている');
    assert.equal(after.shippingFee, before.shippingFee * 10);
    assert.equal(after.total, before.salesAmount + before.salesTax + before.shippingFee * 10);
  } finally {
    db.prepare('UPDATE orders SET shipping_fee = shipping_fee / 10').run();
  }
});

test('税率は送料の計算と同じ値を使っている', async () => {
  const { TAX_RATE } = require('../../src/services/shippingFeeService');
  const { summary } = await listWith();
  assert.equal(summary.salesTax, Math.round(summary.salesAmount * TAX_RATE));
});

// --- 絞り込み ---------------------------------------------------------------

test('得意先で絞ると、件数も金額も減る', async () => {
  const all = (await listWith()).summary;
  const a = (await listWith(`customerId=${CUSTOMER_A}`)).summary;

  assert.ok(a.lines < all.lines, '絞り込みが効いていない');
  assert.ok(a.salesAmount < all.salesAmount);
  assert.equal(a.lines, 10);
  assert.equal(a.orders, 10);
  assert.equal(a.salesAmount, 10000);
  assert.equal(a.shippingFee, 1000);
  assert.equal(a.salesTax, 1000);
  assert.equal(a.total, 12000);
});

test('ステータス・日付でも絞れる', async () => {
  const pending = (await listWith('status=' + encodeURIComponent('未着手'))).summary;
  assert.equal(pending.lines, 10);
  assert.equal(pending.salesAmount, 10000);

  const september = (await listWith('from=2026-09-01&to=2026-09-30')).summary;
  assert.equal(september.lines, 7, '9月の行だけ');
  assert.equal(september.salesAmount, 5 * 2000 + 500 + 700);
});

test('一覧の件数と集計の行数は必ず一致する（条件がずれていない）', async () => {
  for (const query of [
    '',
    `customerId=${CUSTOMER_A}`,
    'status=' + encodeURIComponent('発送済'),
    'from=2026-09-01&to=2026-09-30',
    `customerId=${CUSTOMER_B}&status=` + encodeURIComponent('発送済'),
    `productId=${PRODUCT}&from=2026-08-01`,
  ]) {
    const { total, summary } = await listWith(query);
    assert.equal(summary.lines, total, `条件がずれている: ${query || '(絞り込み無し)'}`);
  }
});

// --- ページ送りと無関係 ------------------------------------------------------

test('ページを送っても、件数を変えても、集計は変わらない', async () => {
  const full = (await listWith('limit=1000')).summary;

  const firstPage = await listWith('limit=1&offset=0');
  assert.equal(firstPage.rows.length, 1, '1行だけ返っている前提');
  assert.deepEqual(firstPage.summary, full, '表示している行だけを足してしまっている');

  const lastPage = await listWith('limit=1&offset=16');
  assert.deepEqual(lastPage.summary, full);
});

// --- 端 ---------------------------------------------------------------------

test('1件も当たらない絞り込みでは、null ではなく0が返る', async () => {
  const { total, summary } = await listWith('from=2099-01-01');
  assert.equal(total, 0);
  assert.deepEqual(summary, {
    lines: 0, orders: 0, quantity: 0,
    salesAmount: 0, salesTax: 0, shippingFee: 0, total: 0,
  });
});
