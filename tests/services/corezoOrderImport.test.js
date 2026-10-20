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
//   - 商品は**商品名だけ**で決まる。メールの商品コード（COREZO側の番号）は見ない
//   - 他社の商品は外す。「浄酎白長野35 300」（長野・同じ度数と容量）と取り違えないこと

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

// 本番の商品マスタと同じ名前にしておく（メールの商品名と表記がまるで違うことを試すため）
const NOTO_WHITE_300 = 'JOCHU White NOTO 35 300ml';
const NOTO_GOLD_300 = 'JOCHU Gold NOTO MIZUNARA 35 300ml';
const GOLD_ITEM_NAME = '【石川・能登】能登浄酎 JOCHU Gold MIZUNARA(和スピリッツ)35度 300ml';

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 掛け率0.8（卸8掛け）。上代3,300円 → 売価2,640円
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, '金沢楽座', 0.8, 1, '末日')`
    ).run(generateUid(db, 'customers'));

    const insertProduct = db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, tax_category, list_price, jan_code,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, ?, ?, 35, 'スピリッツ', ?, ?, 500, 0)`
    );
    insertProduct.run(generateUid(db, 'products'), NOTO_WHITE_300, 300, 3300, '4589501590907');
    // 度数・容量が同じで産地だけ違う。取り違えないことを見るために入れておく
    insertProduct.run(generateUid(db, 'products'), '浄酎白長野35 300', 300, 3300, null);
    insertProduct.run(generateUid(db, 'products'), NOTO_GOLD_300, 300, 4950, null);
    insertProduct.run(generateUid(db, 'products'), '浄酎白能登35 1000 パウチ', 1000, 6000, null);
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
  // 能登の白35度300ml。同じ度数・容量の長野の商品ではないこと
  assert.equal(r.plan.items[0].productName, NOTO_WHITE_300);

  // 売価は上代3,300×0.8×5本。**メールの消費者価格（4,630）ではない**
  assert.equal(order.unit_price, 3300);
  assert.equal(order.markup_rate, 0.8);
  assert.equal(order.sales_amount, 13200);

  // お届け先は本文のまま入れる（送り状CSVがこの形を読める）
  assert.match(order.delivery_address, /贈先 次郎/);
  assert.match(order.delivery_address, /山口県萩市中小川1631/);
  assert.match(order.delivery_address, /18時～20時/);
});

// 実物の2商品の注文は、当社の浄酎と他社の芋焼酎の組み合わせだった
test('他社の商品は外して、当社の商品だけを登録する（注意は出す）', () => {
  const r = importService.importFromText(fixture('order-two-items'));
  assert.equal(r.status, 'registered', r.reasons?.join(' / '));
  assert.deepEqual(r.plan.items.map((i) => i.productName), [NOTO_WHITE_300]);
  assert.match(r.warnings.join(' '), /「能登 金の時 本格芋焼酎」2個は当社の商品ではない/);

  // 上の試験と対で見る。消費者価格をそのまま入れていたら、ここで必ず落ちる
  const invoice = invoiceAmount.orderInvoice(db, r.order.order_no);
  assert.equal(invoice.salesAmount, 2640, '浄酎 3,300×0.8×1本。芋焼酎は入らない');
  assert.equal(invoice.shippingFee, 909, '送料は税抜909円で入れる');
  assert.equal(invoice.total, 3904);
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

test('1通に当社の商品が複数あれば、同じ受注番号の複数明細になる（送料は1行目だけ）', () => {
  const text = fixture('order-two-items')
    .replace('ご注文番号：141709', 'ご注文番号：141799')
    .replaceAll('能登 金の時 本格芋焼酎', GOLD_ITEM_NAME);
  const r = importService.importFromText(text);
  assert.equal(r.status, 'registered', r.reasons?.join(' / '));
  // 白 3,300×0.8×1本 ＝ 2,640 ／ 金 4,950×0.8×2本 ＝ 7,920
  assert.equal(invoiceAmount.orderInvoice(db, r.order.order_no).salesAmount, 10560);

  const rows = db
    .prepare(`SELECT * FROM orders WHERE note = 'COREZO注文番号：141799' ORDER BY line_no`)
    .all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].order_no, rows[1].order_no, '同じ受注番号であること');
  assert.equal(rows[0].line_no, 1);
  assert.equal(rows[1].line_no, 2);
  assert.equal(rows[0].shipping_fee, 909);
  assert.equal(rows[1].shipping_fee, 0, '送料が二重に乗らないこと');
  assert.equal(rows[1].quantity, 2);
  assert.equal(rows[1].product_id, db.prepare('SELECT id FROM products WHERE name = ?').get(NOTO_GOLD_300).id);
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

test('メールの商品コードは見ない（当社のJANと違っても商品名で決まる）', () => {
  const text = fixture('order-gift')
    .replace('ご注文番号：140882', 'ご注文番号：149999')
    .replaceAll('5702583400004', '4999999999999');

  const r = importService.importFromText(text, { dryRun: true });
  assert.equal(r.status, 'dry_run', r.reasons?.join(' / '));
  assert.equal(r.plan.items[0].productName, NOTO_WHITE_300);
});

test('長野の浄酎は長野の商品になる（産地で見分ける）', () => {
  const text = fixture('order-gift')
    .replace('ご注文番号：140882', 'ご注文番号：149992')
    .replaceAll('【石川・能登】能登浄酎', '【長野】長野浄酎');

  const r = importService.importFromText(text, { dryRun: true });
  assert.equal(r.status, 'dry_run', r.reasons?.join(' / '));
  assert.equal(r.plan.items[0].productName, '浄酎白長野35 300');
});

test('浄酎なのに商品マスタで決まらなければ登録せず、候補を出す', () => {
  const text = fixture('order-gift')
    .replace('ご注文番号：140882', 'ご注文番号：149991')
    .replaceAll('35度 300ml', '35度 500ml');

  const r = importService.importFromText(text);
  assert.equal(r.status, 'needs_review');
  assert.match(r.reasons.join(' '), /当たる商品が商品マスタにありません/);
  assert.ok(r.candidates.product.length, '近い商品名が候補に出ること');
});

test('他社の商品だけの注文は登録しない', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const text = fixture('order-gift')
    .replace('ご注文番号：140882', 'ご注文番号：149990')
    .replaceAll('【石川・能登】能登浄酎 JOCHU White(和スピリッツ)35度 300ml', '能登 金の時 本格芋焼酎');

  const r = importService.importFromText(text);
  assert.equal(r.status, 'not_ours');
  assert.match(r.reasons[0], /当社の商品が入っていない/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
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
