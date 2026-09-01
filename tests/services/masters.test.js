// マスタ登録画面（/masters.html）が使うAPIの検証。
// 得意先・酒蔵・原酒のCRUDと、画面に出る制約違反メッセージ。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-masters.sqlite');
const { api, rawFetch } = harness;

test.before(async () => {
  await harness.setup();
});

test.after(async () => {
  await harness.teardown();
});

// --- 画面 ---

test('マスタ画面はログインしないと開けない', async () => {
  const res = await rawFetch('/masters.html', { redirect: 'manual' });
  assert.equal(res.status, 302);
  // ログイン後に元の画面へ戻れるよう、遷移先が引き継がれる
  assert.equal(res.headers.get('location'), '/login.html?next=%2Fmasters.html');
});

test('ログイン済みならマスタ画面が返る', async () => {
  const { status, body } = await api('GET', '/masters.html');
  assert.equal(status, 200);
  assert.match(body, /製品レシピ/);
});

// --- 得意先 ---

test('得意先を登録・編集できる', async () => {
  const created = await api('POST', '/api/customers', {
    code: 'C001',
    name: '能登酒店',
    markupRate: 0.7,
    paymentTermMonths: 1,
    paymentTermDay: '末日',
    salesRep: '菅井',
    onboardedMonth: '2026-04',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.markup_rate, 0.7);
  assert.match(created.body.uid, /^[a-z0-9]{8}$/);

  const updated = await api('PUT', `/api/customers/${created.body.id}`, {
    markupRate: 0.65,
    salesSubRep: '山田',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.markup_rate, 0.65);
  assert.equal(updated.body.sales_sub_rep, '山田');
  // 送らなかった項目は元の値が残る
  assert.equal(updated.body.sales_rep, '菅井');
  assert.equal(updated.body.name, '能登酒店');
});

test('得意先名の重複は日本語のメッセージで拒否される', async () => {
  const { status, body } = await api('POST', '/api/customers', { name: '能登酒店' });
  assert.equal(status, 409);
  assert.equal(body.message, 'その得意先名はすでに登録されています。');
});

test('取引開始月をYYYY-MM以外で送ると400になる（2.0の日付方針）', async () => {
  const { status, body } = await api('POST', '/api/customers', {
    name: '日付テスト商店',
    onboardedMonth: '2026-04-01',
  });
  assert.equal(status, 400);
  assert.match(JSON.stringify(body.details), /YYYY-MM/);
});

// --- 酒蔵・原酒 ---

test('酒蔵を登録・編集・削除できる', async () => {
  const created = await api('POST', '/api/breweries', {
    name: '白山酒造',
    address: '石川県白山市',
    phone: '076-000-0000',
    startedOn: '2026-04-01',
  });
  assert.equal(created.status, 201);

  const updated = await api('PUT', `/api/breweries/${created.body.id}`, { contact: '田中' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.contact, '田中');
  assert.equal(updated.body.address, '石川県白山市');

  const removed = await api('DELETE', `/api/breweries/${created.body.id}`);
  assert.equal(removed.status, 204);

  const gone = await api('GET', `/api/breweries/${created.body.id}`);
  assert.equal(gone.status, 404);
});

test('原酒は酒蔵を選んでも、一覧にない名前を直接入力しても登録できる', async () => {
  const brewery = await api('POST', '/api/breweries', { name: '能登杜氏酒造' });

  const linked = await api('POST', '/api/raw-sake-brands', {
    name: '純米原酒A',
    breweryId: brewery.body.id,
    abv: 18.5,
  });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.brewery_id, brewery.body.id);

  // 未登録の酒蔵名はbrewery_name_rawに退避され、brewery_idはNULLのまま（8-2）
  const free = await api('POST', '/api/raw-sake-brands', {
    name: '純米原酒B',
    breweryName: 'まだ登録していない蔵',
  });
  assert.equal(free.status, 201);
  assert.equal(free.body.brewery_id, null);
  assert.equal(free.body.brewery_name_raw, 'まだ登録していない蔵');
});

test('酒蔵IDと酒蔵名の同時指定は400になる', async () => {
  const brewery = await api('POST', '/api/breweries', { name: '二重指定テスト蔵' });
  const { status } = await api('POST', '/api/raw-sake-brands', {
    name: '二重指定原酒',
    breweryId: brewery.body.id,
    breweryName: '別の蔵',
  });
  assert.equal(status, 400);
});

test('原酒から参照されている酒蔵は削除できず、理由が日本語で返る', async () => {
  const brewery = await api('POST', '/api/breweries', { name: '参照されている蔵' });
  await api('POST', '/api/raw-sake-brands', {
    name: '参照している原酒',
    breweryId: brewery.body.id,
  });

  const { status, body } = await api('DELETE', `/api/breweries/${brewery.body.id}`);
  assert.equal(status, 409);
  assert.match(body.message, /参照されているため削除できません/);

  // 削除されていないこと
  const still = await api('GET', `/api/breweries/${brewery.body.id}`);
  assert.equal(still.status, 200);
});

test('原酒を編集・削除できる', async () => {
  const created = await api('POST', '/api/raw-sake-brands', {
    name: '編集テスト原酒',
    abv: 17,
    initialStock: 300,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.initial_stock, 300);

  const updated = await api('PUT', `/api/raw-sake-brands/${created.body.id}`, {
    abv: 17.5,
    status: '保管中',
    producedOn: '令和8年8月',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.abv, 17.5);
  assert.equal(updated.body.produced_on, '令和8年8月');

  const removed = await api('DELETE', `/api/raw-sake-brands/${created.body.id}`);
  assert.equal(removed.status, 204);
});

// --- 存在しないAPI ---

test('存在しない /api/... はHTMLではなくJSONで404を返す', async () => {
  const { status, body, res } = await api('GET', '/api/does-not-exist');
  assert.equal(status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(body.error, 'unknown_endpoint');
  // 原因（サーバーが古いまま）に気づける文言になっていること
  assert.match(body.message, /再起動/);
  assert.match(body.message, /GET \/api\/does-not-exist/);
});

test('存在しないAPIへのPOSTも同じ形で返る', async () => {
  const { status, body } = await api('POST', '/api/nope', { a: 1 });
  assert.equal(status, 404);
  assert.equal(body.error, 'unknown_endpoint');
  assert.match(body.message, /POST \/api\/nope/);
});

test('画面ファイルの404は従来どおり（APIの404だけを変えている）', async () => {
  const { status } = await api('GET', '/no-such-page.html');
  assert.equal(status, 404);
});
