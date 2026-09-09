// 瓶詰め・箱詰めの記録を、全件・並べ替え・ページ送りで見られること。
//
// 以前は「直近30件」しか見られなかった。30という数字が
//   ・サービスの既定引数（listCancellable({ limit = 30 })）
//   ・APIの既定値（Number(req.query.limit) || 30）
//   ・画面が limit を送っていないこと
// の3か所に散っていて、それより古い記録は画面から追えなかった。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-ledger-records.sqlite');
const api = harness.api;

const TOTAL = 120;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'P001', '浄酎 300ml', 300, 35, '本', 3000, 0, 0)`
    ).run(generateUid(db, 'products'));
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'P002', '浄酎 700ml', 700, 35, '本', 7000, 0, 0)`
    ).run(generateUid(db, 'products'));

    // 120件。区分と商品と数量をばらけさせて、絞り込みと並べ替えを確かめられるようにする
    const insert = db.prepare(
      `INSERT INTO product_stock_ledger (history_code, txn_date, product_id, txn_type, quantity, is_cancelled)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const types = ['瓶詰', '箱詰', '出荷', '返品'];
    for (let i = 1; i <= TOTAL; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      insert.run(
        `L2608-${String(i).padStart(4, '0')}`,
        `2026-08-${day}`,
        (i % 2) + 1,
        types[i % 4],
        i,
        i % 10 === 0 ? 1 : 0
      );
    }
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('30件を超えて、全件を追える', async () => {
  const { status, body } = await api('GET', '/api/ledger-cancel?limit=500');

  assert.equal(status, 200);
  assert.equal(body.total, TOTAL);
  assert.equal(body.rows.length, TOTAL);
});

test('ページを送れる（51〜100件目が返る）', async () => {
  const { body } = await api('GET', '/api/ledger-cancel?limit=50&offset=50');

  assert.equal(body.total, TOTAL);
  assert.equal(body.rows.length, 50);
  assert.equal(body.offset, 50);

  // 1ページ目と重なっていないこと
  const first = await api('GET', '/api/ledger-cancel?limit=50&offset=0');
  const ids = new Set(first.body.rows.map((r) => r.id));
  assert.ok(body.rows.every((r) => !ids.has(r.id)), '1ページ目と同じ行が混ざっています');
});

test('見出しの列で並べ替えられる', async () => {
  const asc = await api('GET', '/api/ledger-cancel?sort=quantity&order=asc&limit=500');
  const quantities = asc.body.rows.map((r) => r.quantity);
  assert.deepEqual(quantities, [...quantities].sort((a, b) => a - b));

  const desc = await api('GET', '/api/ledger-cancel?sort=quantity&order=desc&limit=500');
  assert.equal(desc.body.rows[0].quantity, TOTAL);
});

test('状態（有効／取消済）で並べ替えられる', async () => {
  const { body } = await api('GET', '/api/ledger-cancel?sort=is_cancelled&order=desc&limit=5');
  assert.ok(body.rows.every((r) => r.is_cancelled === 1), '取消済みが先頭に来ていません');
});

test('許可していない列名を送っても壊れず、既定の順で返る', async () => {
  // 画面から来た文字列をそのままSQLに入れていないことの確認
  const attack = await api(
    'GET',
    `/api/ledger-cancel?sort=${encodeURIComponent('quantity; DROP TABLE product_stock_ledger;--')}&limit=5`
  );

  assert.equal(attack.status, 200);
  assert.equal(attack.body.total, TOTAL);
  // 表が消えていないこと
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM product_stock_ledger').get().c, TOTAL);

  const normal = await api('GET', '/api/ledger-cancel?limit=5');
  assert.deepEqual(
    attack.body.rows.map((r) => r.id),
    normal.body.rows.map((r) => r.id)
  );
});

test('区分で絞り込める', async () => {
  const { body } = await api('GET', '/api/ledger-cancel?txnType=箱詰&limit=500');

  assert.ok(body.rows.length > 0);
  assert.ok(body.rows.every((r) => r.txn_type === '箱詰'));
  assert.equal(body.total, body.rows.length);
});

test('状態で絞り込める', async () => {
  const cancelled = await api('GET', '/api/ledger-cancel?cancelled=true&limit=500');
  assert.equal(cancelled.body.total, 12); // 10の倍数の120件中12件
  assert.ok(cancelled.body.rows.every((r) => r.is_cancelled === 1));

  const active = await api('GET', '/api/ledger-cancel?cancelled=false&limit=500');
  assert.equal(active.body.total, TOTAL - 12);
});

test('期間で絞り込める', async () => {
  const { body } = await api('GET', '/api/ledger-cancel?from=2026-08-10&to=2026-08-12&limit=500');

  assert.ok(body.rows.length > 0);
  assert.ok(body.rows.every((r) => r.txn_date >= '2026-08-10' && r.txn_date <= '2026-08-12'));
});

test('絞り込みと並べ替えを重ねても、件数が合う', async () => {
  const { body } = await api(
    'GET',
    '/api/ledger-cancel?txnType=出荷&cancelled=false&sort=txn_date&order=asc&limit=10'
  );

  assert.equal(body.rows.length, Math.min(10, body.total));
  assert.ok(body.rows.every((r) => r.txn_type === '出荷' && r.is_cancelled === 0));

  const dates = body.rows.map((r) => r.txn_date);
  assert.deepEqual(dates, [...dates].sort());
});

test('1ページの件数には上限がある（500件）', async () => {
  const { body } = await api('GET', '/api/ledger-cancel?limit=99999');
  assert.equal(body.limit, 500);
});
