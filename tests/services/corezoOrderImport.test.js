// COREZO（金沢楽座）の注文メールから受注を登録する。
//
// 見本は実物と同じ書式だが、**氏名・住所・電話番号は作り物**に差し替えてある
// （実際のお客様の個人情報をリポジトリに入れないため）。
//
// 空振りしないように:
//   - 売価は上代×掛け率で出る。**メールの金額（消費者価格）ではない**ことを対で見る
//   - 送料は税抜909円。請求額が取り決めどおり 3,904円 になることまで見る
//   - 複数商品は1受注の複数明細になり、送料が二重に乗らないこと
//   - 同じ注文番号は二度登録しないこと（取消済みでも復活させない）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-corezo.sqlite');

let db;
let importService;
let invoiceAmount;

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'corezo');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');

const JAN_JOCHU = '5702583400004';
const JAN_IMO = '5880598400001';

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 掛け率0.8（卸8掛け）。上代3,300円 → 売価2,640円
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, '金沢楽座', 0.8, 1, '末日')`
    ).run(generateUid(db, 'customers'));

    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, tax_category, list_price, jan_code,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, '浄酎 ホワイト35 300ml', 300, 35, 'スピリッツ', 3300, ?, 500, 0)`
    ).run(generateUid(db, 'products'), JAN_JOCHU);

    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, tax_category, list_price, jan_code,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, '能登 金の時 本格芋焼酎', 720, 25, '単式蒸留焼酎', 2000, ?, 500, 0)`
    ).run(generateUid(db, 'products'), JAN_IMO);
  }));

  importService = require('../../src/services/corezoOrderImportService');
  invoiceAmount = require('../../src/services/invoiceAmount');
});

test.after(async () => {
  await harness.teardown();
});

// --- 登録 -------------------------------------------------------------------

test('贈り物の注文（1商品）を受注に登録する', () => {
  const r = importService.importFromText(fixture('order-gift'));
  assert.equal(r.status, 'registered', r.reasons?.join(' / '));

  const order = r.order;
  assert.equal(order.quantity, 5);
  assert.equal(order.ordered_on, '2026-10-01', '受注日はメールの受信日');
  assert.equal(order.requested_delivery_on, '2026-10-16', 'お届け日が納品希望日になること');
  assert.equal(order.note, 'COREZO注文番号：140882');

  // 売価は上代3,300×0.8×5本。**メールの消費者価格（4,630）ではない**
  assert.equal(order.unit_price, 3300);
  assert.equal(order.markup_rate, 0.8);
  assert.equal(order.sales_amount, 13200);

  // お届け先は本文のまま入れる（送り状CSVがこの形を読める）
  assert.match(order.delivery_address, /贈先 次郎/);
  assert.match(order.delivery_address, /山口県萩市中小川1631/);
  assert.match(order.delivery_address, /18時～20時/);
});

// 上の試験と対で見る。消費者価格をそのまま入れていたら、ここで必ず落ちる
test('請求額は取り決めどおり（売価×1.1 + 送料1,000円）になる', () => {
  const r = importService.importFromText(fixture('order-two-items'));
  assert.equal(r.status, 'registered', r.reasons?.join(' / '));

  const invoice = invoiceAmount.orderInvoice(db, r.order.order_no);
  // 浄酎 3,300×0.8×1本 ＝ 2,640 ／ 芋焼酎 2,000×0.8×2本 ＝ 3,200
  assert.equal(invoice.salesAmount, 5840);
  assert.equal(invoice.shippingFee, 909, '送料は税抜909円で入れる');
  // (5,840 + 909) × 1.1 ＝ 7,423.9 → 7,424
  assert.equal(invoice.total, 7424);

});

// 菅井さんが示した「浄酎300ml 1本なら 3,904円（税込）」が、そのまま出ることを見る。
// これが合わないと、送料の税の入れ方（909円 か 1,000円 か）を間違えている
test('浄酎300ml 1本の注文は、請求額がちょうど3,904円になる', () => {
  const text = fixture('order-gift')
    .replace('ご注文番号：140882', 'ご注文番号：149993')
    .replace('数量：5 個', '数量：1 個');

  const r = importService.importFromText(text);
  assert.equal(r.status, 'registered', r.reasons?.join(' / '));

  const invoice = invoiceAmount.orderInvoice(db, r.order.order_no);
  assert.equal(invoice.salesAmount, 2640, '上代3,300 × 掛け率0.8');
  assert.equal(invoice.shippingFee, 909);
  assert.equal(invoice.total, 3904);
});

test('1通に複数商品があれば、同じ受注番号の複数明細になる（送料は1行目だけ）', () => {
  const rows = db
    .prepare(`SELECT * FROM orders WHERE note = 'COREZO注文番号：141709' ORDER BY line_no`)
    .all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].order_no, rows[1].order_no, '同じ受注番号であること');
  assert.equal(rows[0].line_no, 1);
  assert.equal(rows[1].line_no, 2);
  assert.equal(rows[0].shipping_fee, 909);
  assert.equal(rows[1].shipping_fee, 0, '送料が二重に乗らないこと');
  assert.equal(rows[1].quantity, 2);
});

test('同じ注文番号は二度登録しない', () => {
  const again = importService.importFromText(fixture('order-gift'));
  assert.equal(again.status, 'duplicate');
  assert.match(again.reasons[0], /140882 は受注 .* として登録済み/);

  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE note = 'COREZO注文番号：140882'`)
    .get().n;
  assert.equal(count, 1);
});

test('取り消した受注も「登録済み」として扱う（勝手に復活させない）', () => {
  const order = db
    .prepare(`SELECT * FROM orders WHERE note = 'COREZO注文番号：140882' LIMIT 1`)
    .get();
  db.prepare('UPDATE orders SET is_cancelled = 1 WHERE id = ?').run(order.id);

  const again = importService.importFromText(fixture('order-gift'));
  assert.equal(again.status, 'duplicate');
  assert.match(again.reasons[0], /取消済み/);

  db.prepare('UPDATE orders SET is_cancelled = 0 WHERE id = ?').run(order.id);
});

// --- 登録しない場合 ---------------------------------------------------------

test('配送先変更などの連絡メールは登録せず、人に知らせる', () => {
  const r = importService.importFromText(fixture('notice-address-change'));
  assert.equal(r.status, 'notice');
  assert.match(r.reasons[0], /配送先住所変更/);
  assert.match(r.reasons[0], /140773/);
});

test('COREZOと関係のないメールは「未分類」に回す', () => {
  const r = importService.importFromText('いつもお世話になっております。発注をお願いします。');
  assert.equal(r.status, 'not_corezo');
});

test('商品コードが商品マスタに無ければ登録せず、候補を出す', () => {
  const text = fixture('order-gift')
    .replace('ご注文番号：140882', 'ご注文番号：149999')
    .replaceAll(JAN_JOCHU, '4999999999999');

  const r = importService.importFromText(text);
  assert.equal(r.status, 'needs_review');
  assert.match(r.reasons.join(' '), /4999999999999/);
  assert.ok(r.candidates.product.length, '近い商品名が候補に出ること');

  // 対で見る。正しいコードなら通ること（全部 needs_review なら試験の意味が無い）
  const ok = importService.importFromText(
    fixture('order-gift').replace('ご注文番号：140882', 'ご注文番号：149998')
  );
  assert.equal(ok.status, 'registered');
});

test('お届け先が複数あるメールは登録しない（送り状が1枚しか出ないため）', () => {
  const base = fixture('order-gift').replace('ご注文番号：140882', 'ご注文番号：149997');
  const extra = `

◎お届け先
　お名前　：別先 三郎　様
　郵便番号：〒920-0001
　住所　　：石川県金沢市テスト1-1
　電話番号：076-111-1111
　お届け日：指定なし
お届け時間：指定なし
`;
  const text = base.replace('************************************************\n　注文者情報', extra + '************************************************\n　注文者情報');

  const r = importService.importFromText(text);
  assert.equal(r.status, 'needs_review');
  assert.match(r.reasons.join(' '), /お届け先が2件/);
});

test('得意先マスタに掛け率が無ければ、登録はするが注意を出す', () => {
  db.prepare(`UPDATE customers SET markup_rate = NULL WHERE name = '金沢楽座'`).run();
  const r = importService.importFromText(
    fixture('order-gift').replace('ご注文番号：140882', 'ご注文番号：149996')
  );
  assert.equal(r.status, 'registered');
  assert.match(r.warnings.join(' '), /掛け率が登録されていない/);
  // 掛け率が無いと上代そのまま（3,300×5本）になる
  assert.equal(r.order.sales_amount, 16500);

  db.prepare(`UPDATE customers SET markup_rate = 0.8 WHERE name = '金沢楽座'`).run();
});

test('得意先「金沢楽座」がマスタに無ければ登録しない', () => {
  db.prepare(`UPDATE customers SET name = '別の店' WHERE name = '金沢楽座'`).run();
  const r = importService.importFromText(
    fixture('order-gift').replace('ご注文番号：140882', 'ご注文番号：149995')
  );
  assert.equal(r.status, 'needs_review');
  assert.match(r.reasons.join(' '), /金沢楽座（COREZO）/);

  db.prepare(`UPDATE customers SET name = '金沢楽座' WHERE name = '別の店'`).run();
});

// --- dry-run ----------------------------------------------------------------

test('--dry-run は登録しない', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const r = importService.importFromText(
    fixture('order-gift').replace('ご注文番号：140882', 'ご注文番号：149994'),
    { dryRun: true }
  );
  assert.equal(r.status, 'dry_run');
  assert.equal(r.plan.shippingFee, 909);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
});
