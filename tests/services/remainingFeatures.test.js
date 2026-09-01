// 今回追加した業務機能の検証。
// 資材入荷／返品／サンプル送付／委託販売実績報告／売上目標／タンク登録／
// 商品＋レシピ登録／請求一括処理／ロック管理。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-remaining.sqlite');
const { api } = harness;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(`INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
                VALUES (?, '株式会社NOTO', 0.7, 1, '末日')`).run(generateUid(db, 'customers'));
    db.prepare(`INSERT INTO materials (uid, name, unit, unit_price, lot_size, proper_stock_qty, initial_stock, supplier_name)
                VALUES (?, '300ml瓶', '本', 100, 500, 1000, 200, 'ガラス商事')`).run(generateUid(db, 'materials'));
    db.prepare(`INSERT INTO materials (uid, name, unit, unit_price, initial_stock)
                VALUES (?, 'キャップ', '個', 20, 500)`).run(generateUid(db, 'materials'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 資材入荷 ---

test('資材入荷で在庫が増え、単価はマスタから補完される', async () => {
  const { status, body } = await api('POST', '/api/materials/receipts', {
    materialId: 1,
    quantity: 500,
    txnDate: '2026-08-01',
  });
  assert.equal(status, 201);
  assert.equal(body.after.current_stock, 700); // 初期200 + 入荷500

  const row = db.prepare('SELECT * FROM material_stock_ledger ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.txn_type, '入荷');
  assert.equal(row.unit_price, 100, 'マスタの単価が使われること');
  assert.equal(row.total_price, 50000, '合計金額が計算されること');
  assert.equal(row.counterparty, 'ガラス商事', '発注先が補完されること');
});

test('ロット数の倍数でない入荷は422で拒否される', async () => {
  // 300ml瓶は500本単位
  const { status, body } = await api('POST', '/api/materials/receipts', {
    materialId: 1,
    quantity: 300,
  });
  assert.equal(status, 422);
  assert.match(body.message, /500本単位/);
});

test('ロット数が未設定の資材は任意の数で入荷できる', async () => {
  const { status, body } = await api('POST', '/api/materials/receipts', {
    materialId: 2,
    quantity: 137,
  });
  assert.equal(status, 201);
  assert.equal(body.after.current_stock, 637);
});

test('入荷画面の初期値が取得できる', async () => {
  const { status, body } = await api('GET', '/api/materials/1/receipt-defaults');
  assert.equal(status, 200);
  assert.equal(body.unitPrice, 100);
  assert.equal(body.lotSize, 500);
  assert.equal(body.currentStock, 700);
});

test('資材マスタを登録・編集できる', async () => {
  const created = await api('POST', '/api/materials', {
    name: '化粧箱',
    unit: '枚',
    unitPrice: 50,
    properStockQty: 200,
  });
  assert.equal(created.status, 201);

  const updated = await api('PUT', `/api/materials/${created.body.id}`, { unitPrice: 60 });
  assert.equal(updated.body.unit_price, 60);

  // 同名は登録できない
  const dup = await api('POST', '/api/materials', { name: '化粧箱' });
  assert.equal(dup.status, 422);
});

// --- 商品＋レシピ登録 ---

test('商品とレシピを同時に登録できる', async () => {
  const { status, body } = await api('POST', '/api/products', {
    name: '浄酎 300ml',
    volumeMl: 300,
    listPrice: 3000,
    taxPerUnit: 300,
    initialProductStock: 50,
    initialWipStock: 0,
    recipe: [
      { materialId: 1, qtyRequired: 1, process: '瓶詰' },
      { materialId: 2, qtyRequired: 1, process: '瓶詰' },
      { materialId: 3, qtyRequired: 1, process: '箱詰' },
    ],
  });
  assert.equal(status, 201);
  assert.equal(body.recipe.length, 3);

  // 登録したレシピが瓶詰めで実際に使われる
  const recipe = await api('GET', '/api/recipe/1');
  assert.equal(recipe.body['瓶詰'].length, 2);
  assert.equal(recipe.body['箱詰'].length, 1);
});

test('レシピの重複はエラーになる', async () => {
  const { status, body } = await api('POST', '/api/products', {
    name: '重複テスト商品',
    recipe: [
      { materialId: 1, qtyRequired: 1, process: '瓶詰' },
      { materialId: 1, qtyRequired: 2, process: '瓶詰' },
    ],
  });
  assert.equal(status, 422);
  assert.match(body.message, /重複/);
});

test('レシピを後から差し替えられる', async () => {
  const { status, body } = await api('PUT', '/api/products/1/recipe', {
    recipe: [{ materialId: 1, qtyRequired: 2, process: '瓶詰' }],
  });
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].qty_required, 2);

  // 元に戻しておく（後続テストのため）
  await api('PUT', '/api/products/1/recipe', {
    recipe: [
      { materialId: 1, qtyRequired: 1, process: '瓶詰' },
      { materialId: 2, qtyRequired: 1, process: '瓶詰' },
    ],
  });
});

// --- タンク登録 ---

test('タンクを登録・編集できる', async () => {
  const created = await api('POST', '/api/tanks', {
    code: 'T-01',
    name: '浄酎タンク1',
    containerType: 'ステンレスタンク',
    maxVolumeL: 1000,
    initialVolumeL: 500,
    currentAbv: 40,
  });
  assert.equal(created.status, 201);

  const monitor = await api('GET', '/api/tanks/monitor');
  assert.equal(monitor.body.find((t) => t.code === 'T-01').current_volume_l, 500);

  const updated = await api('PUT', `/api/tanks/${created.body.id}`, { location: '熟成室' });
  assert.equal(updated.body.location, '熟成室');
});

test('容器IDや容器名称の重複は拒否される', async () => {
  const dupCode = await api('POST', '/api/tanks', { code: 'T-01', name: '別の名前' });
  assert.equal(dupCode.status, 422);

  const dupName = await api('POST', '/api/tanks', { code: 'T-99', name: '浄酎タンク1' });
  assert.equal(dupName.status, 422);
});

test('初期在庫量が最大容量を超えるタンクは登録できない', async () => {
  const { status, body } = await api('POST', '/api/tanks', {
    code: 'T-02',
    name: 'あふれるタンク',
    maxVolumeL: 100,
    initialVolumeL: 200,
  });
  assert.equal(status, 422);
  assert.match(body.message, /最大容量を超え/);
});

// --- 返品 ---

test('返品すると在庫が戻る', async () => {
  const before = await api('GET', '/api/products/1/stock');

  const { status, body } = await api('POST', '/api/shipments/returns', {
    productId: 1,
    quantity: 3,
    customerId: 1,
    reason: '破損のため',
    txnDate: '2026-08-15',
  });
  assert.equal(status, 201);
  assert.equal(body.after.product_stock, before.body.product_stock + 3);

  const row = db.prepare("SELECT * FROM product_stock_ledger WHERE txn_type = '返品' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.counterparty, '株式会社NOTO');
  assert.equal(row.note, '破損のため');
});

test('受注に紐付けた返品で、受注数を超える返品は拒否される', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-05',
    customerId: 1,
    productId: 1,
    quantity: 5,
  });

  const tooMany = await api('POST', '/api/shipments/returns', {
    productId: 1,
    quantity: 10,
    orderId: order.body.id,
  });
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.body.message, /受注数を超え/);

  const ok = await api('POST', '/api/shipments/returns', {
    productId: 1,
    quantity: 2,
    orderId: order.body.id,
  });
  assert.equal(ok.status, 201);
});

// --- サンプル送付 ---

test('サンプル送付でサンプルIDが採番され、在庫が減る', async () => {
  const before = await api('GET', '/api/products/1/stock');

  const { status, body } = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 2,
    customerId: 1,
    contactName: '山本様',
    shippedOn: '2026-08-20',
    note: '展示会用',
  });
  assert.equal(status, 201);
  assert.equal(body.sampleNo, 'S2608-0001');
  assert.equal(body.after.product_stock, before.body.product_stock - 2);

  // 出荷履歴と確実に紐付く（8-1の設計）
  const ledger = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(body.stockLedgerId);
  assert.equal(ledger.sample_shipment_id, body.sampleId);
  assert.equal(ledger.order_id, null, '受注とは紐付かないこと');
  assert.equal(ledger.tax_amount, 600, '課税額が計算されること（300円×2本）');
});

test('サンプル送付の一覧が取得できる', async () => {
  const { body } = await api('GET', '/api/shipments/samples');
  assert.equal(body.length, 1);
  assert.equal(body[0].customer_name, '株式会社NOTO');
  assert.equal(body[0].product_name, '浄酎 300ml');
});

// --- 委託販売実績報告 ---

test('委託でない受注は実績報告できない', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-01',
    customerId: 1,
    productId: 1,
    quantity: 10,
    salesMethod: '買取',
  });

  const { status, body } = await api('POST', '/api/shipments/consignment', {
    orderId: order.body.id,
    reportMonth: '2026-08',
    quantity: 5,
  });
  assert.equal(status, 422);
  assert.match(body.message, /委託販売ではありません/);
});

test('委託販売の実績を報告でき、入金予定日が月末になる', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-01',
    customerId: 1,
    productId: 1,
    quantity: 20,
    salesMethod: '委託',
  });

  const { status, body } = await api('POST', '/api/shipments/consignment', {
    orderId: order.body.id,
    reportMonth: '2026-09',
    quantity: 8,
  });
  assert.equal(status, 201);
  assert.equal(body.payment_due_on, '2026-09-30', '転記月の月末が入ること');
  assert.equal(body.quantity, 8);
  assert.ok(body.invoiced_on, '請求日が自動記録されること');

  // 同じ月の二重報告は拒否
  const dup = await api('POST', '/api/shipments/consignment', {
    orderId: order.body.id,
    reportMonth: '2026-09',
    quantity: 1,
  });
  assert.equal(dup.status, 409);

  // 別の月なら追加できるが、合計が受注数を超えるとエラー
  const tooMany = await api('POST', '/api/shipments/consignment', {
    orderId: order.body.id,
    reportMonth: '2026-10',
    quantity: 20,
  });
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.body.message, /受注本数を超え/);
});

test('未報告の委託受注が一覧できる', async () => {
  const { body } = await api('GET', '/api/shipments/consignment/pending');
  const entry = body.find((o) => o.remaining_quantity > 0);
  assert.ok(entry);
  assert.equal(entry.reported_quantity, 8);
  assert.equal(entry.remaining_quantity, 12); // 20 - 8
});

// --- 売上目標と進捗率 ---

test('売上目標を設定でき、再設定で上書きされる', async () => {
  const first = await api('POST', '/api/sales-targets', {
    targetMonth: '2026-09',
    targetAmount: 500000,
  });
  assert.equal(first.status, 201);

  const second = await api('POST', '/api/sales-targets', {
    targetMonth: '2026-09',
    targetAmount: 600000,
  });
  assert.equal(second.body.target_amount, 600000);

  const list = await api('GET', '/api/sales-targets');
  assert.equal(list.body.filter((t) => t.target_month === '2026-09').length, 1, '重複しないこと');
});

test('当月進捗率が計算される（委託は報告分のみ計上）', async () => {
  const { status, body } = await api('GET', '/api/sales-targets/progress?month=2026-09');
  assert.equal(status, 200);
  assert.equal(body.targetAmount, 600000);
  // 9月に報告された委託分：3000円 × 8本 × 0.7 = 16800
  assert.equal(body.breakdown.consignment.amount, 16800);
  assert.equal(body.actualAmount, 16800);
  assert.equal(body.progressRate, 2.8); // 16800 / 600000
  assert.equal(body.remainingAmount, 583200);
});

test('目標未設定の月は進捗率をnullで返す（0%と誤解させない）', async () => {
  const { body } = await api('GET', '/api/sales-targets/progress?month=2027-01');
  assert.equal(body.targetAmount, null);
  assert.equal(body.progressRate, null);
});

// --- 請求日の一括記録 ---

test('請求対象の候補が取得できる', async () => {
  // 納品済みにする
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-02',
    customerId: 1,
    productId: 1,
    quantity: 1,
  });
  await api('POST', `/api/orders/${order.body.id}/ship`, { deliveredOn: '2026-08-03' });

  const { body } = await api('GET', '/api/orders/pending-invoices');
  assert.ok(body.some((o) => o.id === order.body.id), '納品済みかつ未請求が候補に出ること');
});

test('請求日を一括で記録でき、処理済みはスキップされる', async () => {
  const pending = await api('GET', '/api/orders/pending-invoices');
  const ids = pending.body.map((o) => o.id);

  const first = await api('POST', '/api/orders/invoices/bulk', {
    orderIds: ids,
    invoicedOn: '2026-08-31',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.updated.length, ids.length);
  assert.equal(first.body.skipped.length, 0);

  // 二度目は全てスキップされる
  const second = await api('POST', '/api/orders/invoices/bulk', {
    orderIds: ids,
    invoicedOn: '2026-08-31',
  });
  assert.equal(second.body.updated.length, 0);
  assert.equal(second.body.skipped.length, ids.length);
  assert.match(second.body.skipped[0].reason, /既に請求済み/);
});

// --- ロック管理 ---

test('蒸留のロックを取得・解放できる', async () => {
  db.prepare(
    `INSERT INTO distillations (distillation_code, started_on, started_time, status)
     VALUES ('D2608-0001', '2026-08-01', '09:00', '蒸留中')`
  ).run();
  const distillationId = db.prepare("SELECT id FROM distillations WHERE distillation_code = 'D2608-0001'").get().id;

  const acquired = await api('POST', `/api/locks/distillations/${distillationId}`);
  assert.equal(acquired.status, 201);
  assert.equal(acquired.body.locked_by, 'tester');

  const list = await api('GET', '/api/locks');
  assert.ok(list.body.some((l) => l.distillation_id === distillationId));

  const released = await api('DELETE', `/api/locks/distillations/${distillationId}`);
  assert.equal(released.body.released, true);
});

test('他の人がロック中なら取得できない', async () => {
  const authService = require('../../src/services/authService');
  const distillationId = db.prepare("SELECT id FROM distillations LIMIT 1").get().id;

  // 別の人がロックしている状態を作る
  db.prepare(
    `INSERT INTO resource_locks (target_type, distillation_id, locked_by)
     VALUES ('distillation', ?, 'someone-else')`
  ).run(distillationId);

  const { status, body } = await api('POST', `/api/locks/distillations/${distillationId}`);
  assert.equal(status, 409);
  assert.match(body.message, /someone-else/);

  // 管理者なら他人のロックも外せる
  const released = await api('DELETE', `/api/locks/distillations/${distillationId}`);
  assert.equal(released.body.released, true);

  assert.ok(authService); // 参照済みであることの明示
});

test('24時間経過したロックは自動で失効する', async () => {
  const distillationId = db.prepare('SELECT id FROM distillations LIMIT 1').get().id;
  db.prepare(
    `INSERT INTO resource_locks (target_type, distillation_id, locked_by, locked_at)
     VALUES ('distillation', ?, 'old-user', datetime('now', '-25 hours'))`
  ).run(distillationId);

  // 期限切れなので、別の人でも取得できる
  const { status } = await api('POST', `/api/locks/distillations/${distillationId}`);
  assert.equal(status, 201);
});
