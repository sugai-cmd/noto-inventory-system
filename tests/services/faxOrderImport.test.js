// カナカンの発注書FAXの取込。
//
// フィクスチャは実物（2026-10-10着信、発注番号73068150）をTesseract（jpn）で読んだ生の出力。
//   psm4: 全項目読めた回 / psm6: 罫線の行が崩れて入庫日・発注番号が読めなかった回

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-fax-order-import.sqlite');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'fax', name), 'utf8');
const PSM4 = fixture('kanakan-20261010-psm4.txt');
const PSM6 = fixture('kanakan-20261010-psm6.txt');

let db;
let svc;
let parser;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const parentId = db
      .prepare(
        `INSERT INTO customers (uid, code, name, markup_rate, payment_term_months, payment_term_day)
         VALUES (?, 'C0900', 'カナカン', 0.7, 2, '末日')`
      )
      .run(generateUid(db, 'customers')).lastInsertRowid;
    for (const [code, name] of [
      ['C0008', 'カナカン酒類石川'],
      ['C0009', 'カナカン酒類七尾'],
      ['C0105', 'カナカン酒類福井'],
    ]) {
      db.prepare(
        `INSERT INTO customers (uid, code, name, parent_id) VALUES (?, ?, ?, ?)`
      ).run(generateUid(db, 'customers'), code, name, parentId);
    }
    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, list_price, jan_code)
       VALUES (?, 'JOCHU ホワイト35 300ml', 300, 1500, '4589501590860')`
    ).run(generateUid(db, 'products'));
  }));
  // src/ の require は harness.setup のあと（テスト用DBを掴ませるため）
  svc = require('../../src/services/faxOrderImportService');
  parser = require('../../src/services/faxOrder/kanakanParser');
});

test.after(async () => {
  await harness.teardown();
});

test('実物のOCR結果から全項目が読める（丸数字・1文字ごとの空白を吸収）', () => {
  const p = parser.parseKanakanOrder(PSM4);
  assert.deepEqual(p.errors, []);
  assert.equal(p.isKanakan, true);
  assert.equal(p.orderNumber, '73068150');
  assert.equal(p.orderedOn, '2026-10-10');
  assert.equal(p.deliveryOn, '2026-10-15');
  assert.equal(p.warehouse, 'カナカン酒類石川');
  assert.equal(p.office, '酒類石川営業所');
  assert.equal(p.jan, '4589501590860');
  assert.equal(p.perCase, 12);
  assert.equal(p.cases, 2);
  assert.equal(p.quantity, 24);
});

test('崩れた回は読めなかった項目をエラーとして返し、推測で埋めない', () => {
  const p = parser.parseKanakanOrder(PSM6);
  assert.equal(p.orderNumber, null);
  assert.equal(p.deliveryOn, null);
  assert.deepEqual(p.missing.sort(), ['deliveryOn', 'orderNumber']);
});

test('複数回の読み取りをまとめると、崩れた回の欠けを別の回で補える', () => {
  const merged = svc.mergeParsed([PSM6, PSM4].map(parser.parseKanakanOrder));
  assert.deepEqual(merged.errors, []);
  assert.equal(merged.orderNumber, '73068150');
  assert.equal(merged.deliveryOn, '2026-10-15');
});

test('JANはチェックデジットで検算する（1桁の読み違いは採用しない）', () => {
  assert.equal(parser.isValidJan('4589501590860'), true);
  assert.equal(parser.isValidJan('4589501590868'), false);
  const broken = PSM4.replace('⑤ ⑨ 0 ⑧ ⑥ 0', '⑤ ⑨ 0 ⑧ ⑥ ⑧');
  assert.equal(parser.parseKanakanOrder(broken).jan, null);
});

test('カナカン以外のFAXは対象外として何もしない', () => {
  const r = svc.importFromTexts('株式会社サンプル商事\n注文書\n商品A 10本');
  assert.equal(r.status, 'not_kanakan');
});

test('dry-runは登録せずに登録予定の内容を返す', () => {
  const r = svc.importFromTexts([PSM6, PSM4], { dryRun: true, sourceName: 'fax.pdf' });
  assert.equal(r.status, 'dry_run');
  assert.equal(r.plan.customerName, 'カナカン酒類石川');
  assert.equal(r.plan.quantity, 24);
  assert.equal(r.plan.requestedDeliveryOn, '2026-10-15');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('受注として登録される（得意先は支店、納品希望日＝入庫日、noteに発注番号）', () => {
  const r = svc.importFromTexts([PSM4], { sourceName: '60000520261010100805_001.pdf' });
  assert.equal(r.status, 'registered');

  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.order.id);
  const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(row.customer_id);
  assert.equal(customer.name, 'カナカン酒類石川');
  assert.equal(row.ordered_on, '2026-10-10');
  assert.equal(row.requested_delivery_on, '2026-10-15');
  assert.equal(row.quantity, 24);
  assert.equal(row.status, '未着手');
  assert.match(row.note, /^カナカン発注番号：73068150\n/);
  // 掛率は支店が空欄なので本店（カナカン 0.7）を引き継ぐ
  assert.equal(row.markup_rate, 0.7);
  assert.equal(row.sales_amount, Math.round(1500 * 24 * 0.7));
});

test('同じ発注番号は二重に登録しない', () => {
  const r = svc.importFromTexts([PSM4]);
  assert.equal(r.status, 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('別の支店（七尾）の発注書は七尾の得意先になる', () => {
  const nanao = PSM4.replace(/73068150|⑦ ③ 0 ⑥ ⑧ ① ⑤ 0/, '⑦ ③ 0 ⑥ ⑧ ① ⑤ ①').replace(
    '納 入 倉 庫 カ ナ カ ン 酒 類 石 川\n酒 類 石 川 営 業 所',
    '納 入 倉 庫 カ ナ カ ン 酒 類 七 尾\n酒 類 七 尾 営 業 所'
  );
  const r = svc.importFromTexts([nanao], { dryRun: true });
  assert.equal(r.status, 'dry_run');
  assert.equal(r.parsed.orderNumber, '73068151');
  assert.equal(r.plan.customerName, 'カナカン酒類七尾');
});

test('得意先が決まらないときは登録せず、候補を付けて要確認にする', () => {
  const unknown = PSM4.replace('⑦ ③ 0 ⑥ ⑧ ① ⑤ 0', '⑦ ③ 0 ⑥ ⑧ ① ⑤ ②').replace(
    '納 入 倉 庫 カ ナ カ ン 酒 類 石 川\n酒 類 石 川 営 業 所',
    '納 入 倉 庫 カ ナ カ ン 酒 類 富 山\n酒 類 富 山 営 業 所'
  );
  const r = svc.importFromTexts([unknown]);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.reasons.some((m) => m.includes('カナカン酒類富山')));
  assert.ok(r.candidates.customer.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('JANが商品マスタにないときは登録せず要確認にする', () => {
  // 4589501590877 はチェックデジットの合う別のJAN
  const other = PSM4.replace('⑦ ③ 0 ⑥ ⑧ ① ⑤ 0', '⑦ ③ 0 ⑥ ⑧ ① ⑤ ③').replace(
    '④ ⑤ ⑧ ⑨ ⑤ 0 ① ⑤ ⑨ 0 ⑧ ⑥ 0',
    '④ ⑤ ⑧ ⑨ ⑤ 0 ① ⑤ ⑨ 0 ⑧ ⑦ ⑦'
  );
  const r = svc.importFromTexts([other]);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.reasons.some((m) => m.includes('4589501590877')));
});
