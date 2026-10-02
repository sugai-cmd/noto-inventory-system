// 誤登録した受注の取消と、商品の差し替え（PR H）。
//
// 取消の本体は「数えない側」なので、**取消の前後で数字が動くことを対で見る**。
// 「取消後に0件」だけを見ると、そもそも0件の条件を書いていても通ってしまう
// （この案件では、何も確かめていない試験を4回書いた）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-order-cancel.sqlite');
const { api } = harness;

let db;

/** 受注を1件作る。返すのは orders.id */
async function makeOrder({
  productId = 1,
  quantity = 10,
  orderedOn = '2026-08-10',
  unitPrice = 3000,
  salesMethod,
  requestedDeliveryOn,
} = {}) {
  const body = { customerId: 1, productId, quantity, orderedOn, unitPrice };
  if (salesMethod) body.salesMethod = salesMethod;
  if (requestedDeliveryOn) body.requestedDeliveryOn = requestedDeliveryOn;
  const res = await api('POST', '/api/orders', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id ?? res.body.orders?.[0]?.id;
}

const listOf = async (query = '') => (await api('GET', `/api/orders${query}`)).body;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, '取消テスト商店', 0.7, 1, '末日')`
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

// --- 理由と二重取消 ---------------------------------------------------------

test('取消理由は必須', async () => {
  const id = await makeOrder();

  const empty = await api('POST', `/api/orders/${id}/cancel`, { reason: '' });
  assert.equal(empty.status, 400);
  assert.match(JSON.stringify(empty.body.details), /取消理由は必須です/);

  const blank = await api('POST', `/api/orders/${id}/cancel`, { reason: '   ' });
  assert.equal(blank.status, 400, '空白だけの理由も断ること（スキーマで trim している）');

  const missing = await api('POST', `/api/orders/${id}/cancel`, {});
  assert.equal(missing.status, 400, '理由を送らなくても断ること');

  // 理由があれば通る（上の2つが「そもそも通らない条件」ではないこと）
  const ok = await api('POST', `/api/orders/${id}/cancel`, { reason: '商品を間違えて登録した' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.is_cancelled, 1);
  assert.equal(ok.body.order.cancel_reason, '商品を間違えて登録した');
  assert.ok(ok.body.order.cancelled_at, '取消日時が入ること');
  assert.deepEqual(ok.body.warnings, []);
});

test('二重に取り消すと409', async () => {
  const id = await makeOrder();
  await api('POST', `/api/orders/${id}/cancel`, { reason: '1回目' });

  const again = await api('POST', `/api/orders/${id}/cancel`, { reason: '2回目' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'conflict');
});

test('存在しない受注の取消は404', async () => {
  const { status } = await api('POST', '/api/orders/99999/cancel', { reason: 'x' });
  assert.equal(status, 404);
});

// --- 一覧と集計 -------------------------------------------------------------

test('取り消すと一覧と集計から外れる（件数・本数・売価が減る）', async () => {
  const id = await makeOrder({ quantity: 7, unitPrice: 1000 });

  const before = await listOf();
  const salesAmount = before.rows.find((r) => r.id === id).sales_amount;
  assert.equal(salesAmount, Math.round(1000 * 7 * 0.7));

  await api('POST', `/api/orders/${id}/cancel`, { reason: '集計から外れることの確認' });

  const after = await listOf();
  assert.equal(after.total, before.total - 1, '一覧の総件数が1件減ること');
  assert.equal(after.rows.find((r) => r.id === id), undefined, '一覧に出ないこと');

  assert.equal(after.summary.lines, before.summary.lines - 1);
  assert.equal(after.summary.quantity, before.summary.quantity - 7);
  assert.equal(after.summary.salesAmount, before.summary.salesAmount - salesAmount);
});

test('includeCancelled を付けると取消済みも出る', async () => {
  const id = await makeOrder();
  await api('POST', `/api/orders/${id}/cancel`, { reason: '表示の確認' });

  const hidden = await listOf();
  const shown = await listOf('?includeCancelled=1');

  assert.equal(hidden.rows.find((r) => r.id === id), undefined);
  const row = shown.rows.find((r) => r.id === id);
  assert.ok(row, '付けたときは出ること');
  assert.equal(row.is_cancelled, 1);
  assert.equal(row.cancel_reason, '表示の確認');
  assert.ok(shown.total > hidden.total);
});

test('取消済みを表示しても、集計には足されない', async () => {
  // 画面に「集計・CSV・ダッシュボードには入りません」と書いてある。
  // 以前は一覧と同じ条件を集計にも渡していたので、チェックを入れると
  // 合計金額が跳ね上がっていた。
  //
  // **行が増えるのに合計が変わらない**ことを対で見る。合計だけを見ると、
  // そもそも行が増えていない条件でも通ってしまう
  const id = await makeOrder({ quantity: 9, unitPrice: 5000, orderedOn: '2026-10-25' });

  const beforeHidden = await listOf();
  const beforeShown = await listOf('?includeCancelled=1');

  await api('POST', `/api/orders/${id}/cancel`, { reason: '集計に足されないことの確認' });

  const hidden = await listOf();
  const shown = await listOf('?includeCancelled=1');

  // 取り消しても「含める」側の件数は変わらない（隠す側からだけ消える）。
  // 他の試験でも取り消しているので、件数そのものではなく**差**で見る
  assert.equal(shown.total, beforeShown.total, '含める側には残ること');
  assert.equal(hidden.total, beforeHidden.total - 1, '隠す側からは消えること');
  assert.equal(
    shown.total - hidden.total,
    beforeShown.total - beforeHidden.total + 1,
    '隠れている件数が1件増えること'
  );
  assert.ok(shown.rows.some((r) => r.id === id && r.is_cancelled === 1));

  assert.deepEqual(
    shown.summary,
    hidden.summary,
    '取消済みを表示しても集計は変わらないこと'
  );
});

test('1件だけ引くときは取消済みも返る（画面で状態を出すため）', async () => {
  const id = await makeOrder();
  await api('POST', `/api/orders/${id}/cancel`, { reason: '詳細は引けること' });

  const { status, body } = await api('GET', `/api/orders/${id}`);
  assert.equal(status, 200);
  assert.equal(body.is_cancelled, 1);
});

// --- ダッシュボード・売上目標・CSV・在庫監査 --------------------------------

test('ダッシュボードの未入金・出荷予定・注文予測から外れる', async () => {
  // 未入金になる受注（入金予定日が過去で入金日が無い）
  const id = await makeOrder({ quantity: 3, requestedDeliveryOn: '2026-08-20' });
  db.prepare("UPDATE orders SET payment_due_on = '2026-08-31' WHERE id = ?").run(id);

  const unpaid = () => api('GET', '/api/dashboard/unpaid?asOf=2026-09-30');
  const due = () => api('GET', '/api/dashboard/shipments-due?onDate=2026-08-20');

  const beforeUnpaid = (await unpaid()).body;
  const beforeDue = (await due()).body;
  assert.ok(
    beforeUnpaid.some((r) => r.id === id),
    '取消前は未入金に出ていること（出ていないと以下が空振りする）'
  );
  assert.ok(beforeDue.some((r) => r.id === id), '取消前は出荷予定に出ていること');

  await api('POST', `/api/orders/${id}/cancel`, { reason: 'ダッシュボードから外れることの確認' });

  const afterUnpaid = (await unpaid()).body;
  const afterDue = (await due()).body;
  assert.equal(afterUnpaid.find((r) => r.id === id), undefined);
  assert.equal(afterDue.find((r) => r.id === id), undefined);
  assert.equal(
    afterUnpaid.length,
    beforeUnpaid.length - 1,
    '1件だけ減ること（全部消えていないこと）'
  );
});

test('注文予測から外れる', async () => {
  // 同じ得意先で3回以上の注文があると予測が出る（minOrders = 3）
  for (const date of ['2026-05-01', '2026-05-15', '2026-06-01', '2026-06-15']) {
    await makeOrder({ orderedOn: date, quantity: 1 });
  }
  const before = (await api('GET', '/api/dashboard/order-forecast')).body;
  const beforeEntry = before.find((f) => f.customerName === '取消テスト商店');
  assert.ok(beforeEntry, '取消前は予測が出ていること');
  assert.equal(beforeEntry.lastOrderedOn, '2026-06-15');

  // 直近の注文を取り消すと、間隔の計算に使う注文が1つ減る
  const latest = db
    .prepare("SELECT id FROM orders WHERE is_cancelled = 0 AND ordered_on = '2026-06-15' LIMIT 1")
    .get();
  await api('POST', `/api/orders/${latest.id}/cancel`, { reason: '予測の計算から外れることの確認' });

  const after = (await api('GET', '/api/dashboard/order-forecast')).body;
  const afterEntry = after.find((f) => f.customerName === '取消テスト商店');
  assert.equal(
    afterEntry.lastOrderedOn,
    '2026-06-01',
    '最後の注文日が取消済みのままになっていないこと'
  );
  assert.equal(afterEntry.orderCount, beforeEntry.orderCount - 1);
});

test('売上目標の実績から外れる', async () => {
  const id = await makeOrder({ quantity: 5, unitPrice: 2000, orderedOn: '2026-07-01' });
  db.prepare("UPDATE orders SET delivered_on = '2026-07-10' WHERE id = ?").run(id);
  const salesAmount = (await api('GET', `/api/orders/${id}`)).body.sales_amount;

  const before = (await api('GET', '/api/sales-targets/progress?month=2026-07')).body;
  assert.equal(before.actualAmount, salesAmount, '取消前は実績に乗っていること');

  await api('POST', `/api/orders/${id}/cancel`, { reason: '実績から外れることの確認' });

  const after = (await api('GET', '/api/sales-targets/progress?month=2026-07')).body;
  assert.equal(after.actualAmount, before.actualAmount - salesAmount);
  assert.equal(after.breakdown.purchase.count, before.breakdown.purchase.count - 1);
});

test('CSV（ゆうパック・マネーフォワード）から外れる', async () => {
  const id = await makeOrder({ quantity: 2, orderedOn: '2026-09-01' });

  const beforeYu = await api('GET', '/api/exports/yupack?from=2026-09-01&to=2026-09-30');
  const beforeMf = await api('GET', '/api/exports/moneyforward?from=2026-09-01&to=2026-09-30');
  const beforeYuRows = Number(beforeYu.res.headers.get('x-row-count'));
  const beforeMfRows = Number(beforeMf.res.headers.get('x-row-count'));
  assert.ok(beforeYuRows > 0, '取消前は出力に入っていること');

  await api('POST', `/api/orders/${id}/cancel`, { reason: 'CSVから外れることの確認' });

  const afterYu = await api('GET', '/api/exports/yupack?from=2026-09-01&to=2026-09-30');
  const afterMf = await api('GET', '/api/exports/moneyforward?from=2026-09-01&to=2026-09-30');
  assert.equal(Number(afterYu.res.headers.get('x-row-count')), beforeYuRows - 1);
  assert.equal(Number(afterMf.res.headers.get('x-row-count')), beforeMfRows - 1);
});

test('在庫監査の「発送済なのに出荷行がない」に出なくなる', async () => {
  // 出荷行を作らずに発送済だけ立てる（移行データでこの形が実在する）
  const id = await makeOrder({ quantity: 4, orderedOn: '2026-09-05' });
  db.prepare("UPDATE orders SET status = '発送済', delivered_on = '2026-09-06' WHERE id = ?").run(id);

  const orderNo = (await api('GET', `/api/orders/${id}`)).body.order_no;
  const before = (await api('GET', '/api/audit')).body.orderShipments.shippedWithoutLedger;
  assert.ok(before.some((r) => r.order_no === orderNo), '取消前は鳴っていること');

  await api('POST', `/api/orders/${id}/cancel`, { reason: '監査が鳴り続けないことの確認' });

  const after = (await api('GET', '/api/audit')).body.orderShipments.shippedWithoutLedger;
  assert.equal(after.find((r) => r.order_no === orderNo), undefined);
  assert.equal(after.length, before.length - 1);
});

// --- ガードレール -----------------------------------------------------------

test('出荷の記録が生きているうちは取り消せない。出荷を取り消してからなら通る', async () => {
  const id = await makeOrder({ quantity: 2, orderedOn: '2026-10-01' });
  const shipped = await api('POST', `/api/orders/${id}/ship`, { deliveredOn: '2026-10-02' });
  assert.equal(shipped.status, 200);

  const blocked = await api('POST', `/api/orders/${id}/cancel`, { reason: '出荷済みを取り消したい' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /出荷の記録が残っています/);
  assert.match(blocked.body.message, /L2610-/, 'どの履歴が邪魔しているか分かること');

  // 出荷を取り消せば通る（上の409が「そもそも通らない条件」ではないこと）
  const cancelLedger = await api('POST', `/api/ledger-cancel/${shipped.body.stockLedgerId}`, {
    reason: '誤出荷',
  });
  assert.equal(cancelLedger.status, 200);

  const allowed = await api('POST', `/api/orders/${id}/cancel`, { reason: '出荷を取り消したあと' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.order.is_cancelled, 1);
});

test('status を手で未着手に戻しても、出荷行が生きていれば取り消せない', async () => {
  // status は編集で変えられるので、status だけを見ていると抜けられてしまう
  const id = await makeOrder({ quantity: 1, orderedOn: '2026-10-03' });
  await api('POST', `/api/orders/${id}/ship`, { deliveredOn: '2026-10-04' });
  await api('PATCH', `/api/orders/${id}`, { status: '未着手' });

  const { status, body } = await api('POST', `/api/orders/${id}/cancel`, { reason: '抜け道の確認' });
  assert.equal(status, 409);
  assert.match(body.message, /出荷の記録が残っています/);
});

test('委託販売実績報告が紐付いていると取り消せない（報告番号を出す）', async () => {
  const id = await makeOrder({ quantity: 10, orderedOn: '2026-10-05', salesMethod: '委託' });
  const report = await api('POST', '/api/shipments/consignment', {
    orderId: id,
    reportMonth: '2026-10',
    quantity: 4,
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));

  const { status, body } = await api('POST', `/api/orders/${id}/cancel`, { reason: '委託の確認' });
  assert.equal(status, 409);
  assert.match(body.message, /委託販売実績報告/);
  // 報告の取消手段がまだ無いので、どの報告が邪魔しているかが分からないと行き止まりになる
  assert.match(body.message, new RegExp(report.body.report_no), '報告番号で名指しすること');
  assert.match(body.message, /2026-10/);
});

test('請求済み・入金済みは止めずに警告を返す', async () => {
  const id = await makeOrder({ quantity: 1, orderedOn: '2026-10-06' });
  await api('POST', `/api/orders/${id}/invoice`, { invoicedOn: '2026-10-07' });
  await api('POST', `/api/orders/${id}/payment`, { paidOn: '2026-10-08' });

  const { status, body } = await api('POST', `/api/orders/${id}/cancel`, {
    reason: '請求を間違えたので取り消す',
  });
  assert.equal(status, 200, '止めないこと（請求を間違えたときに直せなくなる）');
  assert.equal(body.order.is_cancelled, 1);
  assert.equal(body.warnings.length, 2);
  assert.ok(body.warnings.some((w) => /請求済み/.test(w)));
  assert.ok(body.warnings.some((w) => /入金済み/.test(w)));
});

test('取消済みの受注は発送・請求・入金・返品・委託報告ができない', async () => {
  const id = await makeOrder({ quantity: 1, orderedOn: '2026-10-09', salesMethod: '委託' });
  await api('POST', `/api/orders/${id}/cancel`, { reason: '後続の操作を断ることの確認' });

  const ship = await api('POST', `/api/orders/${id}/ship`, {});
  assert.equal(ship.status, 409);
  assert.match(ship.body.message, /取消済み/);

  const invoice = await api('POST', `/api/orders/${id}/invoice`, {});
  assert.equal(invoice.status, 409);

  const payment = await api('POST', `/api/orders/${id}/payment`, {});
  assert.equal(payment.status, 409);

  const ret = await api('POST', '/api/shipments/returns', {
    orderId: id, productId: 1, quantity: 1, txnDate: '2026-10-10',
  });
  assert.equal(ret.status, 409);

  const consign = await api('POST', '/api/shipments/consignment', {
    orderId: id, reportMonth: '2026-10', quantity: 1,
  });
  assert.equal(consign.status, 409);
});

test('請求の一括記録では、取消済みをスキップして理由を返す', async () => {
  const id = await makeOrder({ quantity: 1, orderedOn: '2026-10-11' });
  db.prepare("UPDATE orders SET delivered_on = '2026-10-12' WHERE id = ?").run(id);
  await api('POST', `/api/orders/${id}/cancel`, { reason: '一括請求から外れることの確認' });

  const { body } = await api('POST', '/api/orders/invoices/bulk', {
    orderIds: [id],
    invoicedOn: '2026-10-13',
  });
  assert.equal(body.updated.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.match(body.skipped[0].reason, /取消済み/);
});

test('委託の報告待ちの候補からも外れる', async () => {
  // 報告が付いた委託受注は取り消せないので、**報告が無いうち**に取り消す形で確かめる
  const id = await makeOrder({ quantity: 8, orderedOn: '2026-10-20', salesMethod: '委託' });

  const before = (await api('GET', '/api/shipments/consignment/pending')).body;
  const beforeRow = before.find((r) => r.id === id);
  assert.ok(beforeRow, '取消前は報告待ちに出ていること');
  assert.equal(beforeRow.remaining_quantity, 8);

  await api('POST', `/api/orders/${id}/cancel`, { reason: '報告待ちから外れることの確認' });

  const after = (await api('GET', '/api/shipments/consignment/pending')).body;
  assert.equal(after.find((r) => r.id === id), undefined);
  assert.equal(after.length, before.length - 1);
});

test('請求の候補（納品済み・未請求）にも出ない', async () => {
  const id = await makeOrder({ quantity: 1, orderedOn: '2026-10-14' });
  db.prepare("UPDATE orders SET delivered_on = '2026-10-15' WHERE id = ?").run(id);

  const before = (await api('GET', '/api/orders/pending-invoices')).body;
  assert.ok(before.some((r) => r.id === id), '取消前は候補に出ていること');

  await api('POST', `/api/orders/${id}/cancel`, { reason: '請求候補から外れることの確認' });

  const after = (await api('GET', '/api/orders/pending-invoices')).body;
  assert.equal(after.find((r) => r.id === id), undefined);
  assert.equal(after.length, before.length - 1);
});

// --- 受注番号 ---------------------------------------------------------------

test('取り消しても受注番号は使い回されない', async () => {
  // 物理削除だと、その月の最後を消したときに次の登録が同じ番号を取る
  // （採番は既存の最大連番+1）。取消は行を残すので、番号は進む
  const id = await makeOrder({ orderedOn: '2026-11-01', quantity: 1 });
  const cancelledNo = (await api('GET', `/api/orders/${id}`)).body.order_no;
  await api('POST', `/api/orders/${id}/cancel`, { reason: '番号が進むことの確認' });

  const nextId = await makeOrder({ orderedOn: '2026-11-02', quantity: 1 });
  const nextNo = (await api('GET', `/api/orders/${nextId}`)).body.order_no;

  assert.notEqual(nextNo, cancelledNo);
  assert.ok(nextNo > cancelledNo, `${cancelledNo} の次が ${nextNo} になること`);
});

// --- 修正履歴 ---------------------------------------------------------------

test('修正履歴に「受注リスト」として理由つきで出る', async () => {
  const id = await makeOrder({ quantity: 6, orderedOn: '2026-11-05' });
  const orderNo = (await api('GET', `/api/orders/${id}`)).body.order_no;
  await api('POST', `/api/orders/${id}/cancel`, { reason: '修正履歴に残ることの確認' });

  const { body } = await api('GET', `/api/corrections?targetCode=${orderNo}`);
  const row = body.rows.find((r) => r.target_type === '受注リスト');
  assert.ok(row, '受注リストの行が出ること');
  assert.equal(row.target_code, orderNo);
  assert.match(row.action, /浄酎 300ml 6本/);
  assert.equal(row.reason, '修正履歴に残ることの確認');
  assert.equal(row.detail, '取消テスト商店');
  assert.equal(row.user_name, 'テスト管理者', '誰が取り消したかが残ること');

  const options = await api('GET', '/api/corrections/options');
  assert.ok(options.body.targetTypes.includes('受注リスト'), '対象種別に出ること');
});

// --- 商品の差し替え ---------------------------------------------------------

test('未発送なら商品を差し替えられ、単価が新しい商品の上代になる', async () => {
  const id = await makeOrder({ productId: 1, quantity: 4, orderedOn: '2026-11-10' });
  const before = (await api('GET', `/api/orders/${id}`)).body;
  assert.equal(before.unit_price, 3000);

  const { status, body } = await api('PATCH', `/api/orders/${id}`, { productId: 2 });
  assert.equal(status, 200);
  assert.equal(body.product_id, 2);
  assert.equal(body.product_name, '浄酎 500ml');
  assert.equal(body.unit_price, 4800, '新しい商品の上代が入ること');
  // 単価×本数×掛率で組み直される
  assert.equal(body.sales_amount, Math.round(4800 * 4 * 0.7));
  assert.notEqual(body.sales_amount, before.sales_amount);
});

test('単価を一緒に送ったら、そちらを使う（上代で上書きしない）', async () => {
  const id = await makeOrder({ productId: 1, quantity: 2, orderedOn: '2026-11-11' });
  const { body } = await api('PATCH', `/api/orders/${id}`, { productId: 2, unitPrice: 4000 });
  assert.equal(body.product_id, 2);
  assert.equal(body.unit_price, 4000);
  assert.equal(body.sales_amount, Math.round(4000 * 2 * 0.7));
});

test('差し替えは商品名で操作ログに残る（idではない）', async () => {
  const id = await makeOrder({ productId: 1, quantity: 1, orderedOn: '2026-11-12' });
  await api('PATCH', `/api/orders/${id}`, { productId: 2 });

  const log = db
    .prepare("SELECT * FROM operation_logs WHERE action = 'order.update' ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(log.summary, /商品: 浄酎 300ml → 浄酎 500ml/);
});

test('同じ商品を送っただけなら変更として扱わない', async () => {
  const id = await makeOrder({ productId: 1, quantity: 1, orderedOn: '2026-11-13' });
  const logsBefore = db
    .prepare("SELECT COUNT(*) AS n FROM operation_logs WHERE action = 'order.update'")
    .get().n;

  const { status, body } = await api('PATCH', `/api/orders/${id}`, { productId: 1 });
  assert.equal(status, 200);
  assert.equal(body.product_id, 1);

  const logsAfter = db
    .prepare("SELECT COUNT(*) AS n FROM operation_logs WHERE action = 'order.update'")
    .get().n;
  assert.equal(logsAfter, logsBefore, '操作ログを増やさないこと');
});

test('無い商品に差し替えようとすると404', async () => {
  const id = await makeOrder({ productId: 1, quantity: 1, orderedOn: '2026-11-14' });
  const { status } = await api('PATCH', `/api/orders/${id}`, { productId: 9999 });
  assert.equal(status, 404);
});

test('取消済みの受注は編集できない', async () => {
  const id = await makeOrder({ quantity: 1, orderedOn: '2026-11-15' });
  await api('POST', `/api/orders/${id}/cancel`, { reason: '編集を断ることの確認' });

  const { status, body } = await api('PATCH', `/api/orders/${id}`, { quantity: 2 });
  assert.equal(status, 422);
  assert.match(body.message, /取消済み/);
});

// --- 送料の明細数 -----------------------------------------------------------

test('取消済みの明細は「複数明細」に数えない', async () => {
  // 2明細で登録してから1明細を取り消すと、残りは1明細。
  // 段ボールの推奨は「複数明細は対象外」なので、ここが効かないと推奨が出ない
  const created = await api('POST', '/api/orders', {
    customerId: 1,
    orderedOn: '2026-12-01',
    items: [
      { productId: 1, quantity: 12 },
      { productId: 2, quantity: 1 },
    ],
  });
  assert.equal(created.status, 201);
  const [first, second] = created.body.lines;
  assert.equal(created.body.lines.length, 2);

  const blocked = await api('GET', `/api/orders/${first.id}/carton-suggestion`);
  assert.match(blocked.body.reason ?? '', /複数明細/, '取消前は複数明細として断られること');

  await api('POST', `/api/orders/${second.id}/cancel`, { reason: '明細の取消' });

  const after = await api('GET', `/api/orders/${first.id}/carton-suggestion`);
  assert.doesNotMatch(after.body.reason ?? '', /複数明細/, '1明細として扱われること');
});
