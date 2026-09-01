// 容器移動・未納税移出と、在庫監査レポートの検証。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

// 認証を有効にしたまま（本番と同じ構成で）テストする
const harness = createHarness('test-tank-audit.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
  db.prepare(`INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
              VALUES (?, '株式会社NOTO', 0.7, 1, '末日')`).run(generateUid(db, 'customers'));
  db.prepare(`INSERT INTO products (uid, name, volume_ml, list_price, tax_per_unit,
                                    initial_product_stock, initial_wip_stock)
              VALUES (?, '浄酎 300ml', 300, 3000, 300, 0, 0)`).run(generateUid(db, 'products'));
  db.prepare(`INSERT INTO materials (uid, name, unit, initial_stock)
              VALUES (?, '300ml瓶', '本', 1000)`).run(generateUid(db, 'materials'));
  db.prepare(`INSERT INTO product_recipes (product_id, material_id, qty_required, process)
              VALUES (1, 1, 1, '瓶詰')`).run();

  // T-01: 度数40が500L / T-02: 空（容量100Lと小さめ） / T-03: 度数30が100L
  db.prepare(`INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l, current_abv)
              VALUES (?, 'T-01', '浄酎タンク1', 'ステンレスタンク', 1000, 500, 40)`).run(generateUid(db, 'tanks'));
  db.prepare(`INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
              VALUES (?, 'T-02', '浄酎タンク2', 'ステンレスタンク', 100, 0)`).run(generateUid(db, 'tanks'));
  db.prepare(`INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l, current_abv)
              VALUES (?, 'T-03', '浄酎タンク3', 'ステンレスタンク', 1000, 100, 30)`).run(generateUid(db, 'tanks'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('容器移動: 移動元が減り移動先が増える', async () => {
  const { status, body } = await api('POST', '/api/tank-operations/transfer', {
    fromTankId: 1,
    toTankId: 3,
    quantityL: 100,
    txnDate: '2026-08-10',
  });
  assert.equal(status, 201);
  assert.equal(body.from.after.current_volume_l, 400); // 500 - 100
  assert.equal(body.to.after.current_volume_l, 200);   // 100 + 100
});

test('容器移動: 移動先の理論度数が加重平均で更新される', async () => {
  // 直前のテストで T-03 は「度数30が100L」に「度数40が100L」が入った状態
  const abv = db.prepare('SELECT current_abv FROM tanks WHERE id = 3').get().current_abv;
  assert.equal(abv, 35); // (100*30 + 100*40) / 200
});

test('容器移動: 残量を超える移動は422で拒否される', async () => {
  const { status, body } = await api('POST', '/api/tank-operations/transfer', {
    fromTankId: 1,
    toTankId: 2,
    quantityL: 9999,
  });
  assert.equal(status, 422);
  assert.match(body.message, /タンク残量が不足/);
});

test('容器移動: 移動先の容量を超える移動は422で拒否される', async () => {
  // T-02 は最大100L
  const { status, body } = await api('POST', '/api/tank-operations/transfer', {
    fromTankId: 1,
    toTankId: 2,
    quantityL: 150,
  });
  assert.equal(status, 422);
  assert.match(body.message, /容量を超えます/);
});

test('容器移動: 移動元と移動先が同じなら422', async () => {
  const { status, body } = await api('POST', '/api/tank-operations/transfer', {
    fromTankId: 1,
    toTankId: 1,
    quantityL: 10,
  });
  assert.equal(status, 422);
  assert.match(body.message, /同じタンク/);
});

test('未納税移出: 払出元が減り、搬出先が備考に残る', async () => {
  const { status, body } = await api('POST', '/api/tank-operations/tax-free-transfer', {
    fromTankId: 1,
    quantityL: 50,
    destination: '他社酒造場A',
    txnDate: '2026-08-11',
  });
  assert.equal(status, 201);
  assert.equal(body.from.after.current_volume_l, 350); // 400 - 50

  const row = db.prepare('SELECT * FROM tank_ledger WHERE id = ?').get(body.tankLedgerId);
  assert.equal(row.txn_type, '未納税移出');
  assert.equal(row.to_tank_id, null); // 社外なので受入先タンクはない
  assert.match(row.note, /搬出先: 他社酒造場A/);
});

test('タンク入出庫履歴が取得できる', async () => {
  const { status, body } = await api('GET', '/api/tank-operations/ledger?tankId=1');
  assert.equal(status, 200);
  const types = body.map((r) => r.txn_type);
  assert.ok(types.includes('容器移動'));
  assert.ok(types.includes('未納税移出'));
});

test('在庫監査: 問題がなければ検出件数0', async () => {
  const { status, body } = await api('GET', '/api/audit');
  assert.equal(status, 200);
  assert.equal(body.totalIssues, 0);
  assert.equal(body.sections.length, 5);
});

test('在庫監査④: レシピ通りに資材が消費されていれば差異なし', async () => {
  await api('POST', '/api/bottling', {
    productId: 1,
    quantity: 100,
    tankId: 1,
    volumeL: 30,
    txnDate: '2026-08-12',
  });

  const { body } = await api('GET', '/api/audit');
  assert.equal(body.materialConsumption.length, 0);
});

test('在庫監査④: 資材消費がレシピと食い違えば検出される', async () => {
  // 瓶詰めで自動生成された消費行を書き換えて、意図的に差異を作る
  db.prepare(
    `UPDATE material_stock_ledger SET quantity = 80
     WHERE product_ledger_id = (SELECT id FROM product_stock_ledger WHERE txn_type = '瓶詰' LIMIT 1)`
  ).run();

  const { body } = await api('GET', '/api/audit');
  assert.equal(body.materialConsumption.length, 1);
  const issue = body.materialConsumption[0];
  assert.equal(issue.materialName, '300ml瓶');
  assert.equal(issue.expected, 100);
  assert.equal(issue.actual, 80);
  assert.equal(issue.diff, -20);
});

test('在庫監査③: 発送済なのに出荷履歴がない受注を検出する', async () => {
  // 出荷履歴を作らずに発送済にした受注を用意する
  db.prepare(
    `INSERT INTO orders (order_no, ordered_on, customer_id, product_id, quantity, status, delivered_on)
     VALUES ('O2608-9001', '2026-08-01', 1, 1, 5, '発送済', '2026-08-02')`
  ).run();

  const { body } = await api('GET', '/api/audit');
  const found = body.orderShipments.shippedWithoutLedger.find((o) => o.order_no === 'O2608-9001');
  assert.ok(found, '出荷履歴のない発送済受注が検出されること');
  assert.equal(found.quantity, 5);
});

test('在庫監査②: 在庫がマイナスなら検出される', async () => {
  // 在庫以上の出荷を直接書き込んでマイナスを作る
  db.prepare(
    `INSERT INTO product_stock_ledger (txn_date, product_id, txn_type, quantity)
     VALUES ('2026-08-20', 1, '出荷', 99999)`
  ).run();

  const { body } = await api('GET', '/api/audit');
  assert.equal(body.negativeStock.products.length, 1);
  assert.ok(body.negativeStock.products[0].product_stock < 0);
});

test('在庫監査①: 同一日・同一商品・同一数量の重複を検出する', async () => {
  const insert = db.prepare(
    `INSERT INTO product_stock_ledger (history_code, txn_date, product_id, txn_type, quantity)
     VALUES (?, '2026-08-21', 1, '返品', 3)`
  );
  insert.run('L2608-9001');
  insert.run('L2608-9002');

  const { body } = await api('GET', '/api/audit');
  const dup = body.duplicates.find((d) => d.txn_type === '返品' && d.quantity === 3);
  assert.ok(dup, '重複の疑いが検出されること');
  assert.equal(dup.count, 2);
});

test('在庫監査⑤: 完了済みなのに継足がない蒸留を検出する', async () => {
  db.prepare(
    `INSERT INTO distillations (distillation_code, started_on, started_time, status, output_l)
     VALUES ('D2608-9001', '2026-08-01', '09:00', '完了', 50)`
  ).run();

  const { body } = await api('GET', '/api/audit');
  const found = body.orphans.completedDistillationWithoutFill.find(
    (d) => d.distillation_code === 'D2608-9001'
  );
  assert.ok(found, '継足のない完了済み蒸留が検出されること');
});

test('在庫監査: 検出があれば totalIssues と各セクションの件数が一致する', async () => {
  const { body } = await api('GET', '/api/audit');
  assert.ok(body.totalIssues > 0);
  const sum = body.sections.reduce((acc, s) => acc + s.count, 0);
  assert.equal(body.totalIssues, sum);
});

test('在庫監査は読み取り専用（実行してもデータが変わらない）', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM product_stock_ledger').get().c;
  await api('GET', '/api/audit');
  const after = db.prepare('SELECT COUNT(*) AS c FROM product_stock_ledger').get().c;
  assert.equal(after, before);
});
