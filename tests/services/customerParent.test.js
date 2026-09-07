// 得意先の本店・支店。
//
// カナカンのように支店を持つ会社は、請求・与信・担当が本店単位で決まっている一方、
// 受注・納品は支店単位で来る。支店の欄が空のときだけ本店の値を使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-customer-parent.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 本店。請求まわりだけ持っていて、住所も本社のもの
    db.prepare(
      `INSERT INTO customers (uid, code, name, markup_rate, payment_term_months, payment_term_day,
                              invoice_due_note, invoice_contact, address)
       VALUES (?, 'C0900', 'カナカン', 0.7, 2, '末日', '月初に業務課へ郵送', '業務課',
               '〒920-0901 金沢市彦三町1-2-1')`
    ).run(generateUid(db, 'customers'));

    // 支店A: 支払いサイトを自分で持っている（本店より優先されるべき）
    db.prepare(
      `INSERT INTO customers (uid, code, name, markup_rate, payment_term_months, payment_term_day,
                              address, parent_id)
       VALUES (?, 'C0008', 'カナカン酒類石川', 0.7, 1, '末日', '石川県金沢市佐奇森町788-4', 1)`
    ).run(generateUid(db, 'customers'));

    // 支店B: 支払いサイトが空欄（実データのカナカン富山・福井と同じ状態）
    db.prepare(
      `INSERT INTO customers (uid, code, name, address, parent_id)
       VALUES (?, 'C0105', 'カナカン酒類福井', '福井市重立町28字辻54', 1)`
    ).run(generateUid(db, 'customers'));

    // 親を持たない普通の得意先
    db.prepare(
      `INSERT INTO customers (uid, code, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, 'C0002', '株式会社表酒店', 0.75, 1, '末日')`
    ).run(generateUid(db, 'customers'));

    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, list_price, initial_product_stock, initial_wip_stock)
       VALUES (?, 'JOCHU White NOTO 35 300ml', 300, 3300, 500, 0)`
    ).run(generateUid(db, 'products'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('支払いサイトが空欄の支店は、本店の値を引き継ぐ', async () => {
  const { status, body } = await api('GET', '/api/customers/3/billing');
  assert.equal(status, 200);
  assert.equal(body.name, 'カナカン酒類福井');
  assert.equal(body.payment_term_months, 2);   // 本店の「翌々月」
  assert.equal(body.payment_term_day, '末日');
  assert.equal(body.markup_rate, 0.7);
  assert.equal(body.invoice_contact, '業務課');
  // どこから来た値かが分かる
  assert.equal(body.inheritedFrom.payment_term_months, 'カナカン');
  assert.equal(body.parentName, 'カナカン');
});

test('支店に値が入っていれば支店が勝つ', async () => {
  const { body } = await api('GET', '/api/customers/2/billing');
  assert.equal(body.name, 'カナカン酒類石川');
  assert.equal(body.payment_term_months, 1);   // 支店の「翌月」。本店の2ではない
  assert.equal(body.inheritedFrom.payment_term_months, undefined);
  // 空欄の項目だけ引き継ぐ
  assert.equal(body.invoice_contact, '業務課');
  assert.equal(body.inheritedFrom.invoice_contact, 'カナカン');
});

test('住所は継承しない（支店ごとに違うため）', async () => {
  const { body } = await api('GET', '/api/customers/3/billing');
  assert.equal(body.address, '福井市重立町28字辻54');
});

test('本店が無い得意先はこれまで通り', async () => {
  const { body } = await api('GET', '/api/customers/4/billing');
  assert.equal(body.payment_term_months, 1);
  assert.equal(body.parentName, null);
  assert.deepEqual(body.inheritedFrom, {});
});

test('空欄だった支店でも、受注の入金予定日が本店の支払いサイトから出る', async () => {
  // これが直したかったこと。本店を設定する前は入金予定日が空になっていた。
  const { body } = await api(
    'GET',
    '/api/orders/defaults?customerId=3&productId=1&quantity=12&deliveredOn=2026-09-04'
  );
  assert.equal(body.paymentDueOn, '2026-11-30');  // 納品9/4 + 翌々月末日
  assert.equal(body.markupRate, 0.7);             // 掛率も本店から

  // 支店が自分の支払いサイトを持っていれば、そちらが使われる
  const branch = await api(
    'GET',
    '/api/orders/defaults?customerId=2&productId=1&quantity=12&deliveredOn=2026-09-04'
  );
  assert.equal(branch.body.paymentDueOn, '2026-10-31'); // 翌月末日
});

test('発送済にしたときの入金予定日も本店から計算される', async () => {
  const created = await api('POST', '/api/orders', {
    orderedOn: '2026-09-02',
    customerId: 3,
    productId: 1,
    quantity: 12,
  });
  assert.equal(created.status, 201);

  const shipped = await api('POST', `/api/orders/${created.body.id}/ship`, {
    deliveredOn: '2026-09-04',
  });
  assert.equal(shipped.body.order.payment_due_on, '2026-11-30');
});

test('本店の名前でも支店を検索できる', async () => {
  const { body } = await api('GET', '/api/customers/search?q=カナカン');
  const names = body.map((c) => c.name);
  assert.ok(names.includes('カナカン酒類石川'));
  assert.ok(names.includes('カナカン酒類福井'));
  assert.ok(names.includes('カナカン'));

  // 検索結果に本店名が付いてくる（画面で併記するため）
  const fukui = body.find((c) => c.name === 'カナカン酒類福井');
  assert.equal(fukui.parent_name, 'カナカン');
});

test('自分自身を本店にはできない', async () => {
  const { status, body } = await api('PUT', '/api/customers/2', { parentId: 2 });
  assert.equal(status, 422);
  assert.match(body.message, /自分自身を本店にはできません/);
});

test('本店と支店が輪になる指定を弾く', async () => {
  // カナカン（本店）の本店に、その支店であるカナカン酒類石川を指定しようとする
  const { status, body } = await api('PUT', '/api/customers/1', { parentId: 2 });
  assert.equal(status, 422);
  assert.match(body.message, /輪になります/);
});

test('本店は外せる', async () => {
  const detached = await api('PUT', '/api/customers/3', { parentId: '' });
  assert.equal(detached.status, 200);
  assert.equal(detached.body.parent_id, null);

  // 外すと引き継ぎも無くなる
  const billing = await api('GET', '/api/customers/3/billing');
  assert.equal(billing.body.payment_term_months, null);

  // 戻す
  const back = await api('PUT', '/api/customers/3', { parentId: 1 });
  assert.equal(back.body.parent_id, 1);
});

test('本店を送らない更新では、本店が消えない', async () => {
  // CSV取り込みは本店の列を持たないことがある。そのとき既存の本店を消してはいけない
  const { body } = await api('PUT', '/api/customers/3', { note: '備考だけ直す' });
  assert.equal(body.parent_id, 1);
  assert.equal(body.note, '備考だけ直す');
});

test('3段（本社→支社→営業所）でも根まで辿る', async () => {
  const uid = () => Math.random().toString(36).slice(2, 10);
  db.prepare(
    `INSERT INTO customers (uid, code, name, parent_id) VALUES (?, 'C0951', 'カナカン酒類石川 営業所', 2)`
  ).run(uid());
  const id = db.prepare("SELECT id FROM customers WHERE code = 'C0951'").get().id;

  const { body } = await api('GET', `/api/customers/${id}/billing`);
  // 直近の親（石川）が持つ支払いサイトが勝つ
  assert.equal(body.payment_term_months, 1);
  assert.equal(body.inheritedFrom.payment_term_months, 'カナカン酒類石川');
  // 石川も持っていない請求先は、その上の本店から取る
  assert.equal(body.invoice_contact, '業務課');
  assert.equal(body.inheritedFrom.invoice_contact, 'カナカン');
});
