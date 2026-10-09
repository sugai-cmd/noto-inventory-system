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
      `INSERT INTO products (uid, name, volume_ml, abv, list_price, tax_per_unit, tax_category,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'JOCHU White NOTO 35 300ml', 300, 35, 3300, 300, 'スピリッツ', 500, 0)`
    ).run(generateUid(db, 'products'));
    // 差し替え先の商品（これが無いと「商品が無い」で弾かれ、狙った確認にならない）
    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, list_price, tax_category,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'JOCHU White NOTO 35 500ml', 500, 35, 4800, 'スピリッツ', 500, 0)`
    ).run(generateUid(db, 'products'));
    db.prepare(
      `INSERT INTO liquor_tax_rates (category, base_abv, base_yen_per_kl, step_yen_per_kl)
       VALUES ('スピリッツ', 37, 370000, 10000)`
    ).run();
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
  // 酒税も本数に追従する。35度は基準(37度)以下なので 370,000円/kl ＝ 0.37円/ml
  assert.equal(ledger.tax_amount, 7200 * 0.37);
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

test('得意先は編集で変えられない（送っても無視される）', async () => {
  const { body } = await api('PATCH', '/api/orders/1', {
    customerId: 1,
    note: '得意先の変更は受け付けない',
  });
  assert.equal(body.customer_id, 2);
  assert.equal(body.note, '得意先の変更は受け付けない');
});

test('発送済の受注は商品を差し替えられない（先に出荷を取り消す）', async () => {
  // 商品の差し替えは未発送のみ（0026）。出荷が済んでいると、在庫変動履歴の
  // 出荷行の商品まで差し替えることになる
  const { status, body } = await api('PATCH', '/api/orders/1', { productId: 2 });
  assert.equal(status, 422);
  assert.match(body.message, /出荷の記録が残っている/);

  const after = await api('GET', '/api/orders/1');
  assert.equal(after.body.product_id, 1, '商品が変わっていないこと');
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

// --- 編集でステータスを発送済にしたときも出荷を記録する -----------------------
//
// 受注の編集画面には「ステータス」の欄があり、ここで未着手→発送済にできる。
// 以前はステータスの文字だけ書き換えて**出荷行を作っていなかった**ので、
// 在庫が減らず、酒税にも乗らない受注ができていた
// （酒税タブに商品が出てこない、として見つかった。実データで3件）。

const shipmentRows = (orderId) =>
  db
    .prepare(
      `SELECT * FROM product_stock_ledger
        WHERE order_id = ? AND txn_type = '出荷' AND is_cancelled = 0
        ORDER BY id`
    )
    .all(orderId);

/** 受注を1件足して、そのidを返す */
async function addOrder(body) {
  const res = await api('POST', '/api/orders', {
    orderedOn: '2026-11-02',
    customerId: 1,
    items: [{ productId: 1, quantity: 4 }],
    ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const no = res.body.orderNo ?? res.body.order_no ?? res.body.orders?.[0]?.order_no;
  const row = db.prepare('SELECT id FROM orders WHERE order_no = ? ORDER BY line_no').get(no);
  return row.id;
}

test('編集でステータスを発送済にすると、出荷が記録される', async () => {
  const orderId = await addOrder({});
  assert.equal(shipmentRows(orderId).length, 0, '前提: まだ出荷していない');

  const res = await api('PATCH', `/api/orders/${orderId}`, {
    status: '発送済',
    deliveredOn: '2026-11-05',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const rows = shipmentRows(orderId);
  assert.equal(rows.length, 1, '出荷行が作られていません');
  assert.equal(rows[0].txn_date, '2026-11-05', '出荷日は納品日になること');
  assert.equal(rows[0].quantity, 4);
  // 300ml × 4本 × 0.37円/ml = 444円
  assert.equal(rows[0].tax_amount, 444, '酒税額が入っていません');
  assert.equal(rows[0].volume_ml, 1200);
});

test('その出荷は、納品日の月の酒税に乗る', async () => {
  // 日付がズレると「発送済なのに酒税に出てこない」が再発する
  const report = await api('GET', '/api/liquor-tax/monthly?month=2026-11');
  assert.equal(report.status, 200);
  const row = report.body.taxable.rows.find((r) => r.productName === 'JOCHU White NOTO 35 300ml');
  assert.ok(row, '酒税の内訳に出ていません');
  assert.ok(row.quantity >= 4, `本数が乗っていません（${row.quantity}）`);
  assert.equal(report.body.unresolved.length, 0, '税率が出せない商品は無いこと');
});

test('ボタンで発送済にしたときと、同じ酒税額になる', async () => {
  // 2か所で計算していたら、ここで額が割れる
  const edited = await addOrder({});
  await api('PATCH', `/api/orders/${edited}`, { status: '発送済', deliveredOn: '2026-11-06' });

  const byButton = await addOrder({});
  const shipped = await api('POST', `/api/orders/${byButton}/ship`, { deliveredOn: '2026-11-06' });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));

  assert.equal(shipmentRows(edited)[0].tax_amount, shipmentRows(byButton)[0].tax_amount);
  assert.equal(shipmentRows(edited)[0].volume_ml, shipmentRows(byButton)[0].volume_ml);
});

test('すでに出荷行がある受注を編集しても、二重に作らない', async () => {
  const orderId = await addOrder({});
  await api('PATCH', `/api/orders/${orderId}`, { status: '発送済', deliveredOn: '2026-11-07' });
  assert.equal(shipmentRows(orderId).length, 1);

  const again = await api('PATCH', `/api/orders/${orderId}`, { quantity: 5 });
  assert.equal(again.status, 200);

  const rows = shipmentRows(orderId);
  assert.equal(rows.length, 1, '出荷行が増えています');
  assert.equal(rows[0].quantity, 5, '本数は今までどおり追従すること');
});

test('入金予定日は空のときだけ入れる（入っていれば上書きしない）', async () => {
  // 得意先1は「翌月末日」。納品 2026-11-08 なら 2026-12-31
  const auto = await addOrder({});
  await api('PATCH', `/api/orders/${auto}`, { status: '発送済', deliveredOn: '2026-11-08' });
  assert.equal(
    db.prepare('SELECT payment_due_on AS d FROM orders WHERE id = ?').get(auto).d,
    '2026-12-31'
  );

  // この編集で指定した入金予定日を消さないこと（対で見ないと空振りする）
  const given = await addOrder({});
  await api('PATCH', `/api/orders/${given}`, {
    status: '発送済',
    deliveredOn: '2026-11-08',
    paymentDueOn: '2026-11-30',
  });
  assert.equal(
    db.prepare('SELECT payment_due_on AS d FROM orders WHERE id = ?').get(given).d,
    '2026-11-30',
    '指定した入金予定日が上書きされています'
  );
});

test('編集経由では段ボールを減らさない（黙って抜けないよう記録は残す）', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM material_stock_ledger").get().n;
  const orderId = await addOrder({});
  await api('PATCH', `/api/orders/${orderId}`, { status: '発送済', deliveredOn: '2026-11-09' });

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM material_stock_ledger').get().n,
    before,
    '編集画面では段ボールを選べないので、資材は動かさない'
  );
  const log = db
    .prepare("SELECT summary FROM operation_logs WHERE action = 'order.update' ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(log.summary, /出荷を記録した/);
  assert.match(log.summary, /段ボールは減らしていません/);
});

test('出荷の記録が残っているうちは、ステータスを戻せない', async () => {
  const orderId = await addOrder({});
  await api('PATCH', `/api/orders/${orderId}`, { status: '発送済', deliveredOn: '2026-11-10' });

  const res = await api('PATCH', `/api/orders/${orderId}`, { status: '未着手' });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /ステータスを戻せません/);
  assert.equal(
    db.prepare('SELECT status AS s FROM orders WHERE id = ?').get(orderId).s,
    '発送済',
    '断ったのにステータスが変わっています'
  );

  // 出荷の記録が無ければ戻せる（対で見ないと空振りする）
  const notShipped = await addOrder({});
  const ok = await api('PATCH', `/api/orders/${notShipped}`, { status: '手配中' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, '手配中');
});
