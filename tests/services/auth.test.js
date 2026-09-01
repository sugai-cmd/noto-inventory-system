// ログイン認証の検証。
// 自宅からもアクセスする運用のため、未ログインで業務データに到達できないことを担保する。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-auth.sqlite');
const { api, rawFetch } = harness;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(`INSERT INTO products (uid, name, initial_product_stock, initial_wip_stock)
                VALUES (?, '浄酎 300ml', 10, 0)`).run(generateUid(db, 'products'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('未ログインではAPIが401で拒否される', async () => {
  for (const path of [
    '/api/products',
    '/api/orders',
    '/api/products/stock',
    '/api/audit',
    '/api/exports/moneyforward',
    '/api/distillations',
  ]) {
    const res = await rawFetch(path);
    assert.equal(res.status, 401, `${path} が保護されていること`);
  }
});

test('未ログインで画面を開くとログイン画面へ誘導される', async () => {
  const res = await rawFetch('/index.html', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\.html\?next=/);
});

test('ログイン画面と、その表示に必要な資材は未ログインでも取得できる', async () => {
  for (const path of ['/login.html', '/assets/css/app.css', '/assets/js/app.js', '/favicon.svg']) {
    const res = await rawFetch(path);
    assert.equal(res.status, 200, `${path} は未ログインでも配信されること`);
  }
});

test('ログインするとセッションCookieが発行される', async () => {
  const res = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test-password-123' }),
  });
  assert.equal(res.status, 200);

  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('noto_session='));
  assert.ok(session, 'セッションCookieが返ること');
  // XSSでトークンを盗まれないよう、JavaScriptから読めない設定になっていること
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
});

test('ログイン済みならAPIが使える', async () => {
  const { status, body } = await api('GET', '/api/products');
  assert.equal(status, 200);
  assert.equal(body[0].name, '浄酎 300ml');
});

test('パスワードが違えば401（IDの存在有無で応答を変えない）', async () => {
  const wrongPassword = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'wrong-password' }),
  });
  const unknownUser = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'no-such-user', password: 'test-password-123' }),
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  // 「そのIDは存在する」と分かってしまわないよう、同じ文言を返す
  assert.equal((await wrongPassword.json()).message, (await unknownUser.json()).message);
});

test('パスワードは平文で保存されない', async () => {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get('tester');
  assert.ok(!JSON.stringify(row).includes('test-password-123'), '平文が残っていないこと');
  assert.ok(row.password_salt.length > 0);
  assert.ok(row.password_hash.length > 0);
  // 同じパスワードでもソルトが違えばハッシュも変わる
  const other = require('../../src/services/authService');
  other.createUser({ username: 'tester2', password: 'test-password-123' });
  const row2 = db.prepare('SELECT * FROM users WHERE username = ?').get('tester2');
  assert.notEqual(row.password_hash, row2.password_hash);
});

test('APIレスポンスにパスワード情報が含まれない', async () => {
  const { body } = await api('GET', '/api/auth/me');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('password'), 'passwordを含むキーが返らないこと');
});

test('ログアウトするとセッションが失効する', async () => {
  const login = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test-password-123' }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const before = await rawFetch('/api/products', { headers: { Cookie: cookie } });
  assert.equal(before.status, 200);

  await rawFetch('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });

  const after = await rawFetch('/api/products', { headers: { Cookie: cookie } });
  assert.equal(after.status, 401, 'ログアウト後は同じCookieで通らないこと');
});

test('デタラメなトークンでは通らない', async () => {
  const res = await rawFetch('/api/products', {
    headers: { Cookie: 'noto_session=' + 'a'.repeat(64) },
  });
  assert.equal(res.status, 401);
});

test('期限切れのセッションは無効', async () => {
  const authService = require('../../src/services/authService');
  const { token } = authService.login({ username: 'tester', password: 'test-password-123' });

  db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE token = ?").run(token);

  const res = await rawFetch('/api/products', { headers: { Cookie: `noto_session=${token}` } });
  assert.equal(res.status, 401);
  // 期限切れの行はその場で片付けられる
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE token = ?').get(token).c, 0);
});

test('短すぎるパスワードは拒否される', async () => {
  const authService = require('../../src/services/authService');
  assert.throws(
    () => authService.createUser({ username: 'weak', password: 'short' }),
    /8文字以上/
  );
});

test('同じログインIDは登録できない', async () => {
  const authService = require('../../src/services/authService');
  assert.throws(
    () => authService.createUser({ username: 'tester', password: 'another-password-1' }),
    /既に使われています/
  );
});

test('パスワード変更後は古いセッションが使えなくなる', async () => {
  const authService = require('../../src/services/authService');
  authService.createUser({ username: 'pwuser', password: 'first-password-1' });

  const login = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pwuser', password: 'first-password-1' }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const changed = await rawFetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPassword: 'first-password-1', newPassword: 'second-password-2' }),
  });
  assert.equal(changed.status, 200);

  const after = await rawFetch('/api/products', { headers: { Cookie: cookie } });
  assert.equal(after.status, 401, '変更前のセッションが失効していること');

  // 新しいパスワードではログインできる
  const relogin = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pwuser', password: 'second-password-2' }),
  });
  assert.equal(relogin.status, 200);
});

test('一般ユーザーはユーザー管理APIを使えない', async () => {
  const authService = require('../../src/services/authService');
  authService.createUser({ username: 'staffuser', password: 'staff-password-1', role: 'staff' });

  const login = await rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'staffuser', password: 'staff-password-1' }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const res = await rawFetch('/api/auth/users', { headers: { Cookie: cookie } });
  assert.equal(res.status, 403);

  // 管理者なら使える
  const adminRes = await api('GET', '/api/auth/users');
  assert.equal(adminRes.status, 200);
});
