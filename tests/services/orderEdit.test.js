// 受注一覧の「編集」（旧シートで行を直接書き換えていた訂正操作）を検証する。
// 日付の直し、金額の再計算、発送済の受注を直したときの在庫履歴との整合まで見る。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-order-edit.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 支払いサイトが入っている得意先
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, '株式会社表酒店', 0.7, 1, '末日')`
    ).run(generateUid(db, 'customers'));
    // 支払いサイトが未設定の得意先（マスタ登録で空欄のまま作られた想定）
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate)
       VALUES (?, 'プリスリゾート株式会社', 0.8)`
    ).run(generateUid(db, 'customers'));
    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, list_price, tax_per_unit,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'JOCHU White NOTO 35 300ml', 300, 3300, 300, 500, 0)`
    ).run(generateUid(db, 'products'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('支払いサイトが未設定の得意先で入金予定日を勝手に当月末日にしない', async () => {
  // 以前は Number(null) が 0 になるため、支払いサイトが空でも
  // 「当月末日」を計算して入金予定日として保存していた。
  const unset = await api(
    'GET',
    '/api/orders/defaults?customerId=2&productId=1&quantity=12&deliveredOn=2026-09-04'
  );
  assert.equal(unset.body.paymentDueOn, null);

  // 設定されている得意先はこれまでどおり計算される（納品9/4＋翌月末日）
  const set = await api(
    'GET',
    '/api/orders/defaults?customerId=1&productId=1&quantity=12&deliveredOn=2026-09-04'
  );
  assert.equal(set.body.paymentDueOn, '2026-10-31');
});

test('発送済にしても、支払いサイト未設定なら入金予定日は空のまま', async () => {
  const created = await api('POST', '/api/orders', {
    orderedOn: '2026-09-02',
    customerId: 2,
    productId: 1,
    quantity: 12,
  });
  assert.equal(created.status, 201);

  const shipped = await api('POST', `/api/orders/${created.body.id}/ship`, {
    deliveredOn: '2026-09-04',
  });
  assert.equal(shipped.status, 200);
  assert.equal(shipped.body.order.payment_due_on, null);
});

test('入金予定日を編集で直せる', async () => {
  const { status, body } = await api('PATCH', '/api/orders/1', {
    paymentDueOn: '2026-10-31',
  });
  assert.equal(status, 200);
  assert.equal(body.payment_due_on, '2026-10-31');
});

test('日付は空文字を送れば消せる', async () => {
  const { body } = await api('PATCH', '/api/orders/1', { paymentDueOn: '' });
  assert.equal(body.payment_due_on, null);

  // 消したあと入れ直せる
  const again = await api('PATCH', '/api/orders/1', { paymentDueOn: '2026-10-30' });
  assert.equal(again.body.payment_due_on, '2026-10-30');
});

test('本数を直すと売価と合計が計算し直される', async () => {
  const before = await api('GET', '/api/orders/1');
  assert.equal(before.body.quantity, 12);
  assert.equal(before.body.sales_amount, 31680); // 3300 * 12 * 0.8

  const { body } = await api('PATCH', '/api/orders/1', { quantity: 24 });
  assert.equal(body.quantity, 24);
  assert.equal(body.sales_amount, 63360); // 3300 * 24 * 0.8
  assert.equal(body.total_amount, 63360);
});

test('発送済の受注で本数を直すと、商品在庫の出荷履歴も同じ本数になる', async () => {
  const ledger = db
    .prepare("SELECT * FROM product_stock_ledger WHERE order_id = 1 AND txn_type = '出荷'")
    .get();
  // 直前のテストで12→24に直しているので、履歴側も24になっていること
  assert.equal(ledger.quantity, 24);
  assert.equal(ledger.volume_ml, 300 * 24);
  assert.equal(ledger.tax_amount, 300 * 24);
});

test('納品日を直すと出荷履歴の日付も動く', async () => {
  const { body } = await api('PATCH', '/api/orders/1', { deliveredOn: '2026-09-05' });
  assert.equal(body.delivered_on, '2026-09-05');

  const ledger = db
    .prepare("SELECT * FROM product_stock_ledger WHERE order_id = 1 AND txn_type = '出荷'")
    .get();
  assert.equal(ledger.txn_date, '2026-09-05');
});

test('送料を直すと合計に反映される（送料は明細1行目にだけ載る）', async () => {
  const { body } = await api('PATCH', '/api/orders/1', { shippingFee: 1200 });
  assert.equal(body.shipping_fee, 1200);
  assert.equal(body.total_amount, 63360 + 1200);
});

test('本数を0以下にはできない', async () => {
  const { status } = await api('PATCH', '/api/orders/1', { quantity: 0 });
  assert.equal(status, 400);
});

test('受注日は空にできない', async () => {
  const { status } = await api('PATCH', '/api/orders/1', { orderedOn: '' });
  assert.equal(status, 400);
});

test('得意先や商品は編集で変えられない（送っても無視される）', async () => {
  const { body } = await api('PATCH', '/api/orders/1', {
    customerId: 1,
    productId: 999,
    note: '得意先の変更は受け付けない',
  });
  assert.equal(body.customer_id, 2);
  assert.equal(body.product_id, 1);
  assert.equal(body.note, '得意先の変更は受け付けない');
});

test('存在しない受注の編集は404', async () => {
  const { status } = await api('PATCH', '/api/orders/9999', { note: 'x' });
  assert.equal(status, 404);
});

test('何を直したかが操作ログに残る', async () => {
  const rows = db
    .prepare("SELECT * FROM operation_logs WHERE action = 'order.update' ORDER BY id")
    .all();
  assert.ok(rows.length >= 2);
  assert.ok(rows.some((r) => r.summary.includes('入金予定日')));
  assert.ok(rows.some((r) => r.summary.includes('本数: 12 → 24')));
});
