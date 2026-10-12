// 送り状（Webゆうパックプリント）・納品書（マネーフォワード）の自動登録。
// ブラウザの操作は実物の画面が要るのでここでは差し替え、対象の選び方・CSV・記録・通知を見る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iconv = require('iconv-lite');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-ship-docs.sqlite');
const api = harness.api;

let db;
let svc;
let runner;
let orderService;

const logsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ship-docs-test-'));

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const parent = db
      .prepare(
        `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
         VALUES (?, 'カナカン', 0.7, 2, '末日')`
      )
      .run(generateUid(db, 'customers')).lastInsertRowid;
    db.prepare(
      `INSERT INTO customers (uid, name, parent_id, address)
       VALUES (?, 'カナカン酒類石川', ?, '〒920-0000 石川県金沢市佐奇森町ヲ88番地4 076-266-4455')`
    ).run(generateUid(db, 'customers'), parent);
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, address)
       VALUES (?, 'COREZO（金沢楽座）', 1, '〒920-0001 石川県金沢市テスト町1-1 076-000-0000')`
    ).run(generateUid(db, 'customers'));
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, address)
       VALUES (?, '株式会社ほか', 1, '〒920-0002 石川県金沢市ほか町1-1 076-000-0001')`
    ).run(generateUid(db, 'customers'));
    const productId = db
      .prepare(
        `INSERT INTO products (uid, name, volume_ml, list_price, jan_code)
         VALUES (?, 'JOCHU ホワイト35 300ml', 300, 1500, '4589501590860')`
      )
      .run(generateUid(db, 'products')).lastInsertRowid;
    db.prepare(
      `INSERT INTO carton_rules (product_id, quantity, carton_size, parcels) VALUES (?, 12, '80', 1)`
    ).run(productId);
  }));
  svc = require('../../src/services/shipDocsService');
  runner = require('../../src/services/shipDocs/runner');
  orderService = require('../../src/services/orderService');

  const order = (customerId, quantity, note, extra = {}) =>
    orderService.submitOrder({
      orderedOn: '2026-10-10', customerId, productId: 1, quantity,
      requestedDeliveryOn: '2026-10-15', note, ...extra,
    });
  order(2, 24, 'カナカン発注番号：73068150');      // O2610-0001 カナカン酒類石川
  order(3, 12, 'COREZO注文番号：K-1001', { deliveryAddress: '〒920-0003 石川県金沢市お客様町2-2 090-0000-0000 山田太郎' }); // 0002
  order(4, 12, null);                               // 0003 対象外の得意先
  order(2, 5, 'カナカン発注番号：73068151');        // 0004 段ボール対応表に無い本数
});

test.after(async () => {
  await harness.teardown();
});

test('対象はカナカン（支店）とCOREZOの未出荷の受注だけ', () => {
  const { customers, pending } = svc.findTargets();
  assert.deepEqual(customers.map((c) => c.name).sort(), ['COREZO（金沢楽座）', 'カナカン', 'カナカン酒類石川'].sort());
  assert.deepEqual(pending.yupack, ['O2610-0001', 'O2610-0002', 'O2610-0004']);
  assert.deepEqual(pending.moneyforward, ['O2610-0001', 'O2610-0002', 'O2610-0004']);
});

test('送り状CSV: 品名に発注番号、配達希望日＝入庫日、個数は対応表から（24本→2個）、Shift_JIS', () => {
  const dir = logsDir();
  const built = svc.buildCsv('yupack', ['O2610-0001', 'O2610-0002', 'O2610-0004'], dir);

  // 段ボールが決まらない受注は送り状に入れない（間違ったサイズで印刷されるのを防ぐ）
  assert.deepEqual(built.orderNos, ['O2610-0001', 'O2610-0002']);
  assert.deepEqual(built.problems.map((p) => p.orderNo), ['O2610-0004']);

  const text = iconv.decode(fs.readFileSync(built.file), 'Shift_JIS');
  const rows = text.trim().split('\r\n').map((r) => r.split(',').map((c) => c.replace(/^"|"$/g, '')));
  assert.equal(rows.length, 2);
  const kanakan = rows[0];
  assert.equal(kanakan.length, 72);
  assert.equal(kanakan[34], '浄酎 発注番号73068150');
  assert.equal(kanakan[51], '20261015');
  assert.equal(kanakan[36], '2');
  assert.equal(kanakan[16], 'カナカン酒類石川');
  // COREZOは品名に番号を入れない（頼まれているのはカナカンだけ）
  assert.equal(rows[1][34], '浄酎');
});

test('納品書CSV: 出荷前なので納品日＝納品希望日、納品ステータス「未納品」、備考に発注番号', () => {
  const dir = logsDir();
  const built = svc.buildCsv('moneyforward', ['O2610-0001'], dir);
  const lines = fs.readFileSync(built.file, 'utf8').replace(/^﻿/, '').trim().split('\r\n');
  const header = lines[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  const row = lines[1].split(',').map((c) => c.replace(/^"|"$/g, ''));
  const col = (name) => row[header.indexOf(name)];
  assert.equal(col('取引先名称'), 'カナカン酒類石川');
  assert.equal(col('納品日'), '2026/10/15');
  assert.equal(col('納品書番号'), 'O2610-0001');
  assert.equal(col('備考'), 'カナカン発注番号：73068150');
  assert.equal(col('納品ステータス'), '未納品');
});

test('登録できた側だけ記録し、失敗した側は次の実行でもう一度試す', async () => {
  const dir = logsDir();
  const calls = [];
  const summary = await runner.runShipDocs({
    logsDir: dir,
    openBrowser: async () => ({ close: async () => {} }),
    uploaders: {
      yupack: async (ctx, file) => { calls.push(['yupack', file]); return { message: '2件アップロードしました' }; },
      moneyforward: async () => { const e = new Error('二段階認証を求められました'); e.kind = 'login'; throw e; },
    },
  });

  const [y, m] = summary.results;
  assert.equal(y.status, 'uploaded');
  assert.deepEqual(y.orderNos, ['O2610-0001', 'O2610-0002']);
  assert.equal(m.status, 'failed');
  assert.equal(calls.length, 1);

  const { pending } = svc.findTargets();
  assert.deepEqual(pending.yupack, ['O2610-0004']); // 段ボール未決のものだけ残る
  assert.deepEqual(pending.moneyforward, ['O2610-0001', 'O2610-0002', 'O2610-0004']);

  const text = runner.buildSlackText(summary, { trigger: '自動' });
  assert.match(text, /送り状（Webゆうパックプリント）に2件登録しました/);
  assert.match(text, /納品書（マネーフォワード）の登録に失敗しました.*二段階認証/);
  assert.match(text, /ログインを確認してください/);
  assert.match(text, /O2610-0004 は登録していません（この商品と本数の組み合わせが段ボール対応表にありません）/);
  assert.ok(!fs.existsSync(path.join(dir, '.lock')));
});

test('発送済・取消済の受注は対象から外れる', () => {
  db.prepare(`UPDATE orders SET status = '発送済' WHERE order_no = 'O2610-0002'`).run();
  db.prepare(`UPDATE orders SET is_cancelled = 1 WHERE order_no = 'O2610-0004'`).run();
  const { pending } = svc.findTargets();
  assert.deepEqual(pending.yupack, []);
  assert.deepEqual(pending.moneyforward, ['O2610-0001']);
});

test('dry-runはCSVを作るだけで、記録もブラウザも使わない', async () => {
  const summary = await runner.runShipDocs({
    logsDir: logsDir(),
    dryRun: true,
    openBrowser: async () => { throw new Error('開いてはいけない'); },
  });
  assert.equal(summary.results.find((r) => r.target === 'moneyforward').status, 'dry_run');
  assert.deepEqual(svc.findTargets().pending.moneyforward, ['O2610-0001']);
});

test('実行中は二重に動かさない', async () => {
  const dir = logsDir();
  fs.writeFileSync(path.join(dir, '.lock'), '1');
  const summary = await runner.runShipDocs({ logsDir: dir, openBrowser: async () => ({}) });
  assert.equal(summary.skipped, true);
});

test('受注画面: 未登録の件数を返す', async () => {
  const { status, body } = await api('GET', '/api/ship-docs/status');
  assert.equal(status, 200);
  assert.deepEqual(body.pending.moneyforward, ['O2610-0001']);
  assert.ok(body.customers.includes('カナカン酒類石川'));
});
