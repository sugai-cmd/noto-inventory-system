// 入金の消し込み（PR J）。
//
// 金額の機能なので、**前後の差**と**境目**を対で見る。
// 「残額が0になった」だけを見ると、そもそも0の条件を書いていても通ってしまう
// （この案件では、何も確かめていない試験を4回書いた）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-payment.sqlite');
const { api } = harness;

let db;

/** 受注を1件登録して、受注番号を返す（請求日も入れる） */
async function makeOrder({
  customerId = 1,
  productId = 1,
  quantity = 10,
  unitPrice = 3000,
  orderedOn = '2026-08-10',
  shippingFee = 0,
  items,
} = {}) {
  const body = { customerId, orderedOn, shippingFee };
  if (items) body.items = items;
  else Object.assign(body, { productId, quantity, unitPrice });

  const res = await api('POST', '/api/orders', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const orderNo = res.body.order_no;
  // 請求済みにする（消し込みの候補は既定で請求済みのみ）
  db.prepare("UPDATE orders SET invoiced_on = '2026-08-31' WHERE order_no = ?").run(orderNo);
  return orderNo;
}

const pay = async (body) => {
  const res = await api('POST', '/api/payments', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const allocate = (id, items) => api('PUT', `/api/payments/${id}/allocations`, { items });
const openInvoices = async (query = '') =>
  (await api('GET', `/api/payments/open-invoices${query}`)).body;

/** 1件の請求を引く（残額つき） */
async function invoice(orderNo) {
  const { rows } = await openInvoices('?includeUnbilled=1&limit=1000');
  return rows.find((r) => r.orderNo === orderNo);
}

const orderPaidOn = (orderNo) =>
  db.prepare('SELECT paid_on FROM orders WHERE order_no = ? ORDER BY line_no').all(orderNo)
    .map((r) => r.paid_on);

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 本店と支店（まとめ入金の確認に使う）
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, 'カナカン株式会社', 0.7, 1, '末日')`
    ).run(generateUid(db, 'customers'));
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, parent_id) VALUES (?, 'カナカン金沢支店', 0.7, 1)`
    ).run(generateUid(db, 'customers'));
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate) VALUES (?, '別会社商店', 0.7)`
    ).run(generateUid(db, 'customers'));

    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, list_price, tax_category,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, '浄酎 300ml', 300, 41, 3000, 'スピリッツ', 500, 0)`
    ).run(generateUid(db, 'products'));
    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, list_price, tax_category,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, '浄酎 500ml', 500, 35, 4800, 'スピリッツ', 500, 0)`
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

// --- 請求額 -----------------------------------------------------------------

test('請求額が納品書CSVの合計と一致する', async () => {
  // **同じ数字を2か所で計算していたら落ちる。** 受注の「合計」欄が3通りに割れていた
  // 二の舞を避けるため、消し込みの請求額と納品書は同じ関数を通している
  const orderNo = await makeOrder({ quantity: 10, unitPrice: 3000, shippingFee: 850 });

  const inv = await invoice(orderNo);
  // 売価 3000×10×0.7 = 21,000 ／ 送料 850 ／ 小計 21,850 ／ 税 2,185
  assert.equal(inv.salesAmount, 21000);
  assert.equal(inv.shippingFee, 850);
  assert.equal(inv.subtotal, 21850);
  assert.equal(inv.tax, 2185);
  assert.equal(inv.total, 24035);

  const csv = await api('GET', '/api/exports/moneyforward?from=2026-08-01&to=2026-08-31');
  const line = csv.body.split('\r\n').find((l) => l.includes(orderNo));
  assert.ok(line, '納品書CSVにこの受注が出ていること');
  // 納品書CSVの 小計／税／合計 の3列（CSVは数値も引用符で囲む）
  assert.ok(
    line.includes('"21850","2185","24035"'),
    `納品書の金額と一致すること: ${line.slice(0, 140)}`
  );
});

test('複数明細の受注は、受注番号ごとに1件の請求になる', async () => {
  const orderNo = await makeOrder({
    shippingFee: 1000,
    items: [
      { productId: 1, quantity: 10, unitPrice: 3000 },
      { productId: 2, quantity: 5, unitPrice: 4800 },
    ],
  });

  const inv = await invoice(orderNo);
  assert.equal(inv.lines.length, 2);
  // 21,000 + 16,800 = 37,800 ／ +送料1,000 = 38,800 ／ 税 3,880
  assert.equal(inv.salesAmount, 37800);
  assert.equal(inv.total, 42680);

  const { rows } = await openInvoices('?includeUnbilled=1&limit=1000');
  assert.equal(rows.filter((r) => r.orderNo === orderNo).length, 1, '候補に1件だけ出ること');
});

// --- まとめ入金・一部入金 ---------------------------------------------------

test('まとめ入金：1件の入金を3つの受注に割り当てられる', async () => {
  const a = await makeOrder({ quantity: 1, unitPrice: 1000 });  // 700 → 税込 770
  const b = await makeOrder({ quantity: 2, unitPrice: 1000 });  // 1400 → 1540
  const c = await makeOrder({ quantity: 3, unitPrice: 1000 });  // 2100 → 2310

  for (const [no, total] of [[a, 770], [b, 1540], [c, 2310]]) {
    assert.equal((await invoice(no)).total, total);
    assert.deepEqual(orderPaidOn(no), [null], '割り当て前は入金日が空であること');
  }

  const payment = await pay({ paidOn: '2026-09-30', customerId: 1, amount: 4620 });
  const res = await allocate(payment.id, [
    { orderNo: a, amount: 770 },
    { orderNo: b, amount: 1540 },
    { orderNo: c, amount: 2310 },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.used, 4620);
  assert.equal(res.body.unallocated, 0);

  for (const no of [a, b, c]) {
    assert.deepEqual(orderPaidOn(no), ['2026-09-30'], `${no} に入金日が入ること`);
  }
});

test('一部入金：足りないうちは入金日が入らない。足したら入る', async () => {
  const orderNo = await makeOrder({ quantity: 10, unitPrice: 1000 }); // 7,000 → 7,700

  const first = await pay({ paidOn: '2026-10-01', customerId: 1, amount: 5000 });
  await allocate(first.id, [{ orderNo, amount: 5000 }]);

  let inv = await invoice(orderNo);
  assert.equal(inv.total, 7700);
  assert.equal(inv.allocated, 5000);
  assert.equal(inv.remaining, 2700);
  assert.deepEqual(orderPaidOn(orderNo), [null], 'まだ入金日は入らないこと');

  const second = await pay({ paidOn: '2026-10-05', customerId: 1, amount: 2700 });
  await allocate(second.id, [{ orderNo, amount: 2700 }]);

  assert.equal(await invoice(orderNo), undefined, '残額が無くなり候補から消えること');
  assert.deepEqual(orderPaidOn(orderNo), ['2026-10-05'], '最後の入金日が入ること');
});

test('割り当てを減らすと入金日が戻る', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 }); // 770
  const payment = await pay({ paidOn: '2026-10-10', customerId: 1, amount: 770 });

  await allocate(payment.id, [{ orderNo, amount: 770 }]);
  assert.deepEqual(orderPaidOn(orderNo), ['2026-10-10'], '先に入っていること');

  await allocate(payment.id, [{ orderNo, amount: 500 }]);
  assert.deepEqual(orderPaidOn(orderNo), [null], '足りなくなったら消えること');
  assert.equal((await invoice(orderNo)).remaining, 270);
});

test('複数明細の受注は、全部の明細に入金日が入る', async () => {
  const orderNo = await makeOrder({
    items: [
      { productId: 1, quantity: 1, unitPrice: 1000 },
      { productId: 2, quantity: 1, unitPrice: 1000 },
    ],
  });
  const total = (await invoice(orderNo)).total;
  const payment = await pay({ paidOn: '2026-10-15', customerId: 1, amount: total });
  await allocate(payment.id, [{ orderNo, amount: total }]);

  assert.deepEqual(orderPaidOn(orderNo), ['2026-10-15', '2026-10-15']);
});

// --- 上限 -------------------------------------------------------------------

test('入金額を超えて割り当てられない', async () => {
  const a = await makeOrder({ quantity: 10, unitPrice: 1000 }); // 7,700
  const b = await makeOrder({ quantity: 10, unitPrice: 1000 }); // 7,700
  const payment = await pay({ paidOn: '2026-10-20', customerId: 1, amount: 10000 });

  const over = await allocate(payment.id, [
    { orderNo: a, amount: 7700 },
    { orderNo: b, amount: 7700 },
  ]);
  assert.equal(over.status, 422);
  assert.match(over.body.message, /入金額/);

  // 超えない額なら通る（上が「そもそも通らない条件」ではないこと）
  const ok = await allocate(payment.id, [
    { orderNo: a, amount: 7700 },
    { orderNo: b, amount: 2300 },
  ]);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.used, 10000);
  assert.deepEqual(orderPaidOn(a), ['2026-10-20'], '満額の方は入金日が入ること');
  assert.deepEqual(orderPaidOn(b), [null], '足りない方は入らないこと');
});

test('請求額を超えて割り当てられない（他の入金からの分も合わせて見る）', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 }); // 770

  const first = await pay({ paidOn: '2026-10-25', customerId: 1, amount: 500 });
  await allocate(first.id, [{ orderNo, amount: 500 }]);

  const second = await pay({ paidOn: '2026-10-26', customerId: 1, amount: 1000 });
  const over = await allocate(second.id, [{ orderNo, amount: 400 }]);
  assert.equal(over.status, 422, '合計870円は請求770円を超える');
  assert.match(over.body.message, /請求額を超えて/);

  const ok = await allocate(second.id, [{ orderNo, amount: 270 }]);
  assert.equal(ok.status, 200);
  assert.deepEqual(orderPaidOn(orderNo), ['2026-10-26']);
});

test('0円以下の割り当ては断る', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 });
  const payment = await pay({ paidOn: '2026-10-27', customerId: 1, amount: 1000 });
  const { status } = await allocate(payment.id, [{ orderNo, amount: 0 }]);
  assert.equal(status, 400);
});

// --- 端数で締める -----------------------------------------------------------

test('端数で締めると残額が0になり、入金の金額は使わない', async () => {
  // 振込手数料440円を引かれて入金された形
  const orderNo = await makeOrder({ quantity: 10, unitPrice: 1000 }); // 7,700
  const payment = await pay({ paidOn: '2026-11-01', customerId: 1, amount: 7260 });
  await allocate(payment.id, [{ orderNo, amount: 7260 }]);

  assert.equal((await invoice(orderNo)).remaining, 440);
  assert.deepEqual(orderPaidOn(orderNo), [null]);

  const settled = await api('POST', `/api/payments/${payment.id}/settle`, {
    orderNo, note: '振込手数料',
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));

  assert.equal(await invoice(orderNo), undefined, '残額が無くなること');
  assert.deepEqual(orderPaidOn(orderNo), ['2026-11-01'], '入金日が入ること');
  // 端数は入金の金額を使わない（未割当が増えない＝他に回せる額は変わらない）
  assert.equal(settled.body.used, 7260, '充当額は7,260円のまま');
  assert.equal(settled.body.unallocated, 0);
  const fraction = settled.body.allocations.find((a) => a.kind === '端数');
  assert.equal(fraction.amount, 440);
  assert.equal(fraction.note, '振込手数料');
});

test('端数には理由が要る', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 });
  const payment = await pay({ paidOn: '2026-11-02', customerId: 1, amount: 500 });
  await allocate(payment.id, [{ orderNo, amount: 500 }]);

  const empty = await api('POST', `/api/payments/${payment.id}/settle`, { orderNo, note: '  ' });
  assert.equal(empty.status, 400);

  const ok = await api('POST', `/api/payments/${payment.id}/settle`, { orderNo, note: '値引き' });
  assert.equal(ok.status, 200);
});

test('割り当てを直接送るときも、端数には理由が要る', async () => {
  // /settle を通さずに kind='端数' を送れてしまう道がある。
  // 画面のスキーマでは理由を必須にしていないので、サービス側で止める
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 }); // 770
  const payment = await pay({ paidOn: '2026-11-04', customerId: 1, amount: 770 });

  const noNote = await allocate(payment.id, [{ orderNo, amount: 770, kind: '端数' }]);
  assert.equal(noNote.status, 422);
  assert.match(noNote.body.message, /理由/);

  // 理由があれば通る（上が「そもそも通らない条件」ではないこと）
  const withNote = await allocate(payment.id, [
    { orderNo, amount: 770, kind: '端数', note: '全額値引き' },
  ]);
  assert.equal(withNote.status, 200);
  assert.equal(withNote.body.used, 0, '端数は入金の金額を使わないこと');
  assert.deepEqual(orderPaidOn(orderNo), ['2026-11-04']);
});

test('残額が無い請求は締められない', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 }); // 770
  const payment = await pay({ paidOn: '2026-11-03', customerId: 1, amount: 770 });
  await allocate(payment.id, [{ orderNo, amount: 770 }]);

  const { status } = await api('POST', `/api/payments/${payment.id}/settle`, {
    orderNo, note: '振込手数料',
  });
  assert.equal(status, 409);
});

// --- 入金の取消 -------------------------------------------------------------

test('入金を取り消すと、残額と入金日が戻る', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 }); // 770
  const payment = await pay({ paidOn: '2026-11-10', customerId: 1, amount: 770 });
  await allocate(payment.id, [{ orderNo, amount: 770 }]);

  assert.deepEqual(orderPaidOn(orderNo), ['2026-11-10'], '取消前は入っていること');
  assert.equal(await invoice(orderNo), undefined, '取消前は候補から消えていること');

  const res = await api('POST', `/api/payments/${payment.id}/cancel`, { reason: '金額を打ち間違えた' });
  assert.equal(res.status, 200);

  assert.deepEqual(orderPaidOn(orderNo), [null], '入金日が戻ること');
  assert.equal((await invoice(orderNo)).remaining, 770, '残額が戻ること');
});

test('取消理由は必須。二重取消は409。取消済みには割り当てられない', async () => {
  const payment = await pay({ paidOn: '2026-11-11', customerId: 1, amount: 100 });

  const empty = await api('POST', `/api/payments/${payment.id}/cancel`, { reason: '' });
  assert.equal(empty.status, 400);

  const first = await api('POST', `/api/payments/${payment.id}/cancel`, { reason: '誤り' });
  assert.equal(first.status, 200);

  const again = await api('POST', `/api/payments/${payment.id}/cancel`, { reason: '誤り' });
  assert.equal(again.status, 409);

  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 });
  const alloc = await allocate(payment.id, [{ orderNo, amount: 100 }]);
  assert.equal(alloc.status, 409);
});

test('取消済みの入金は一覧の既定で出ない', async () => {
  const hidden = (await api('GET', '/api/payments')).body;
  const shown = (await api('GET', '/api/payments?includeCancelled=1')).body;
  assert.ok(shown.total > hidden.total);
  assert.ok(hidden.rows.every((p) => p.is_cancelled === 0));
});

// --- 取消済みの受注 ---------------------------------------------------------

test('取消済みの受注は候補に出ないし、割り当てもできない', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 });
  assert.ok(await invoice(orderNo), '取り消す前は候補に出ていること');

  const order = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(orderNo);
  await api('POST', `/api/orders/${order.id}/cancel`, { reason: '誤登録' });

  assert.equal(await invoice(orderNo), undefined, '候補から消えること');

  const payment = await pay({ paidOn: '2026-11-15', customerId: 1, amount: 1000 });
  const { status, body } = await allocate(payment.id, [{ orderNo, amount: 770 }]);
  assert.equal(status, 404);
  assert.match(body.message, /取り消された受注/);
});

// --- 委託 -------------------------------------------------------------------

test('委託の報告にも割り当てられ、報告番号が採番されている', async () => {
  const orderNo = await makeOrder({ quantity: 10, unitPrice: 1000 });
  const order = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(orderNo);
  db.prepare("UPDATE orders SET sales_method = '委託' WHERE id = ?").run(order.id);

  const report = await api('POST', '/api/shipments/consignment', {
    orderId: order.id, reportMonth: '2026-11', quantity: 4,
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  assert.match(report.body.report_no, /^C2611-\d{4}$/, '報告番号が採番されること');

  db.prepare("UPDATE consignment_reports SET invoiced_on = '2026-11-30' WHERE id = ?")
    .run(report.body.id);

  const { rows } = await openInvoices('?limit=1000');
  const inv = rows.find((r) => r.reportId === report.body.id);
  assert.ok(inv, '候補に出ること');
  assert.equal(inv.kind, '委託');
  // 売価 1000×4×0.7 = 2,800 → 税込 3,080
  assert.equal(inv.total, 3080);

  const payment = await pay({ paidOn: '2026-11-20', customerId: 1, amount: 3080 });
  const res = await allocate(payment.id, [
    { consignmentReportId: report.body.id, amount: 3080 },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const after = db.prepare('SELECT paid_on FROM consignment_reports WHERE id = ?')
    .get(report.body.id);
  assert.equal(after.paid_on, '2026-11-20', '委託の報告にも入金日が入ること');
});

// --- まとめ入金（本支店） ---------------------------------------------------

test('本店への入金で、支店の請求が候補に出る', async () => {
  const branchOrder = await makeOrder({ customerId: 2, quantity: 1, unitPrice: 1000 });
  const otherOrder = await makeOrder({ customerId: 3, quantity: 1, unitPrice: 1000 });

  // 本店（id=1）で絞っても、支店（id=2）の請求が出る
  const family = await openInvoices('?customerId=1&limit=1000');
  assert.ok(family.rows.some((r) => r.orderNo === branchOrder), '支店の請求が出ること');
  assert.ok(
    !family.rows.some((r) => r.orderNo === otherOrder),
    '別会社の請求は出ないこと（出ていたら絞り込みが効いていない）'
  );

  // 支店で絞っても本店ぶんが出る（同じ家族を見ている）
  const fromBranch = await openInvoices('?customerId=2&limit=1000');
  assert.ok(fromBranch.rows.some((r) => r.orderNo === branchOrder));

  const payment = await pay({ paidOn: '2026-11-25', customerId: 1, amount: 770 });
  const res = await allocate(payment.id, [{ orderNo: branchOrder, amount: 770 }]);
  assert.equal(res.status, 200);
  assert.deepEqual(orderPaidOn(branchOrder), ['2026-11-25']);
});

// --- 候補の絞り込み ---------------------------------------------------------

test('請求日が入っていない受注は、既定では候補に出ない', async () => {
  const res = await api('POST', '/api/orders', {
    customerId: 1, productId: 1, quantity: 1, unitPrice: 1000, orderedOn: '2026-12-01',
  });
  const orderNo = res.body.order_no;   // 請求日を入れていない

  const billed = await openInvoices('?limit=1000');
  assert.ok(!billed.rows.some((r) => r.orderNo === orderNo), '既定では出ないこと');

  const all = await openInvoices('?includeUnbilled=1&limit=1000');
  assert.ok(all.rows.some((r) => r.orderNo === orderNo), '付ければ出ること');
});

// --- ダッシュボード ---------------------------------------------------------

test('ダッシュボードの未入金が、受注番号ごとに残額で出る', async () => {
  const orderNo = await makeOrder({ quantity: 10, unitPrice: 1000, orderedOn: '2026-07-01' });
  db.prepare("UPDATE orders SET payment_due_on = '2026-07-31' WHERE order_no = ?").run(orderNo);

  const before = (await api('GET', '/api/dashboard/unpaid?asOf=2026-09-01')).body;
  const beforeRow = before.find((r) => r.order_no === orderNo);
  assert.ok(beforeRow, '未入金に出ていること');
  assert.equal(beforeRow.invoiceTotal, 7700);
  assert.equal(beforeRow.remainingAmount, 7700);
  assert.equal(beforeRow.paidAmount, 0);

  const payment = await pay({ paidOn: '2026-08-20', customerId: 1, amount: 3000 });
  await allocate(payment.id, [{ orderNo, amount: 3000 }]);

  const after = (await api('GET', '/api/dashboard/unpaid?asOf=2026-09-01')).body;
  const afterRow = after.find((r) => r.order_no === orderNo);
  assert.ok(afterRow, '一部入金では消えないこと');
  assert.equal(afterRow.paidAmount, 3000);
  assert.equal(afterRow.remainingAmount, 4700, '残額が減ること');
});

test('複数明細の受注は、未入金に1行だけ出る', async () => {
  const orderNo = await makeOrder({
    orderedOn: '2026-07-02',
    items: [
      { productId: 1, quantity: 1, unitPrice: 1000 },
      { productId: 2, quantity: 1, unitPrice: 1000 },
    ],
  });
  db.prepare("UPDATE orders SET payment_due_on = '2026-07-31' WHERE order_no = ?").run(orderNo);

  const rows = (await api('GET', '/api/dashboard/unpaid?asOf=2026-09-01')).body;
  assert.equal(rows.filter((r) => r.order_no === orderNo).length, 1);
});

// --- 受注の編集との噛み合わせ -----------------------------------------------

test('割り当てのある受注は、編集から入金日を直せない', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 });
  const order = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(orderNo);

  // 割り当てる前は直せる
  const before = await api('PATCH', `/api/orders/${order.id}`, { paidOn: '2026-12-20' });
  assert.equal(before.status, 200);
  assert.equal(before.body.paid_on, '2026-12-20');

  const payment = await pay({ paidOn: '2026-12-25', customerId: 1, amount: 500 });
  await allocate(payment.id, [{ orderNo, amount: 500 }]);

  const after = await api('PATCH', `/api/orders/${order.id}`, { paidOn: '2026-12-26' });
  assert.equal(after.status, 422, '割り当てがあると断ること');
  assert.match(after.body.message, /入金タブ/);

  // 入金日以外は直せる
  const note = await api('PATCH', `/api/orders/${order.id}`, { note: '備考は直せる' });
  assert.equal(note.status, 200);
});

// --- 操作ログ ---------------------------------------------------------------

test('記録・消し込み・取消が操作ログに残る', async () => {
  const orderNo = await makeOrder({ quantity: 1, unitPrice: 1000 });
  const payment = await pay({ paidOn: '2026-12-28', customerId: 1, amount: 770, payerName: 'カナカン(カ' });
  await allocate(payment.id, [{ orderNo, amount: 770 }]);
  await api('POST', `/api/payments/${payment.id}/cancel`, { reason: '確認用' });

  const actions = db
    .prepare("SELECT action, summary FROM operation_logs WHERE target_id = ? AND target_type = 'payments' ORDER BY id")
    .all(payment.id);
  assert.deepEqual(actions.map((a) => a.action), ['payment.create', 'payment.allocate', 'payment.cancel']);
  assert.match(actions[0].summary, /カナカン\(カ/, '振込名義が残ること');
  assert.match(actions[2].summary, /確認用/);
});
