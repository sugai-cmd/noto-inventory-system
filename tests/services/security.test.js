// ログイン失敗回数の制限・2要素認証・操作ログの検証。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-security.sqlite');
const { api, rawFetch } = harness;

let db;

function login(body) {
  return rawFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test.before(async () => {
  ({ db } = await harness.setup());
});

test.after(async () => {
  await harness.teardown();
});

// --- ログイン失敗回数の制限 ---

test('連続して失敗すると一時的にログインを受け付けなくなる', async () => {
  const authService = require('../../src/services/authService');
  authService.createUser({ username: 'lockme', password: 'correct-password-1' });

  // 5回失敗させる
  for (let i = 0; i < authService.MAX_LOGIN_FAILURES; i++) {
    const res = await login({ username: 'lockme', password: 'wrong' });
    assert.equal(res.status, 401, `${i + 1}回目は401`);
  }

  // 6回目は、正しいパスワードでも受け付けない
  const locked = await login({ username: 'lockme', password: 'correct-password-1' });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'too_many_attempts');
});

test('存在しないIDでもロックされる（実在するIDか判別されない）', async () => {
  const authService = require('../../src/services/authService');
  for (let i = 0; i < authService.MAX_LOGIN_FAILURES; i++) {
    await login({ username: 'ghost-user', password: 'wrong' });
  }
  const res = await login({ username: 'ghost-user', password: 'anything' });
  assert.equal(res.status, 429);
});

test('ロックは他のユーザーに波及しない', async () => {
  const res = await login({ username: 'tester', password: 'test-password-123' });
  assert.equal(res.status, 200, '別のIDは影響を受けないこと');
});

test('ログイン成功で失敗回数がリセットされる', async () => {
  const authService = require('../../src/services/authService');
  authService.createUser({ username: 'resetme', password: 'correct-password-2' });

  // 上限手前まで失敗
  for (let i = 0; i < authService.MAX_LOGIN_FAILURES - 1; i++) {
    await login({ username: 'resetme', password: 'wrong' });
  }
  // 成功させる
  assert.equal((await login({ username: 'resetme', password: 'correct-password-2' })).status, 200);

  // 再び上限手前まで失敗しても、まだロックされない
  for (let i = 0; i < authService.MAX_LOGIN_FAILURES - 1; i++) {
    await login({ username: 'resetme', password: 'wrong' });
  }
  const stillOk = await login({ username: 'resetme', password: 'correct-password-2' });
  assert.equal(stillOk.status, 200, '成功でカウントがリセットされていること');
});

test('ログイン試行が記録される', async () => {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM login_attempts WHERE username = 'lockme' AND succeeded = 0")
    .get();
  assert.ok(row.c >= 5);
});

// --- 2要素認証 ---

test('2要素認証を設定して有効化できる', async () => {
  const totp = require('../../src/utils/totp');

  const setup = await api('POST', '/api/auth/totp/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]+$/, 'Base32の秘密鍵が返ること');
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);

  // この時点ではまだ有効になっていない
  const before = await api('GET', '/api/auth/me');
  assert.equal(before.body.user.totpEnabled, false);

  // 認証アプリが出すのと同じコードを計算して確認する
  const code = totp.generateCode(setup.body.secret, Math.floor(Date.now() / 1000 / 30));
  const confirm = await api('POST', '/api/auth/totp/confirm', { code });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.recoveryCodes.length, 10, 'リカバリコードが発行されること');

  const after = await api('GET', '/api/auth/me');
  assert.equal(after.body.user.totpEnabled, true);
});

test('2要素認証が有効だとパスワードだけではログインできない', async () => {
  const res = await login({ username: 'tester', password: 'test-password-123' });
  assert.equal(res.status, 401);
  // 画面側がコード入力欄を出せるよう、理由を区別して返す
  assert.equal((await res.json()).error, 'totp_required');
});

test('正しいコードを添えればログインできる', async () => {
  const totp = require('../../src/utils/totp');
  const secret = db.prepare("SELECT totp_secret FROM users WHERE username = 'tester'").get().totp_secret;
  const code = totp.generateCode(secret, Math.floor(Date.now() / 1000 / 30));

  const res = await login({ username: 'tester', password: 'test-password-123', totpCode: code });
  assert.equal(res.status, 200);
});

test('誤ったコードは拒否される', async () => {
  const res = await login({
    username: 'tester',
    password: 'test-password-123',
    totpCode: '000000',
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'invalid_totp');
});

test('秘密鍵はAPIから漏れない', async () => {
  const me = await api('GET', '/api/auth/me');
  assert.ok(!JSON.stringify(me.body).includes('totp_secret'));
  assert.ok(!JSON.stringify(me.body).includes('totpSecret'));

  const users = await api('GET', '/api/auth/users');
  assert.ok(!JSON.stringify(users.body).includes('totp_secret'));
});

test('リカバリコードは1回だけ使えて、使うと消える', async () => {
  const authService = require('../../src/services/authService');
  const totp = require('../../src/utils/totp');

  authService.createUser({ username: 'recov', password: 'recovery-password-1' });
  const user = db.prepare("SELECT id FROM users WHERE username = 'recov'").get();

  const { secret } = authService.beginTotpSetup(user.id);
  const code = totp.generateCode(secret, Math.floor(Date.now() / 1000 / 30));
  const { recoveryCodes } = authService.confirmTotpSetup(user.id, code);

  // リカバリコードでログインできる
  const first = await login({
    username: 'recov',
    password: 'recovery-password-1',
    totpCode: recoveryCodes[0],
  });
  assert.equal(first.status, 200);

  // 同じコードは二度目は通らない
  const second = await login({
    username: 'recov',
    password: 'recovery-password-1',
    totpCode: recoveryCodes[0],
  });
  assert.equal(second.status, 401);

  // 別のコードはまだ使える
  const third = await login({
    username: 'recov',
    password: 'recovery-password-1',
    totpCode: recoveryCodes[1],
  });
  assert.equal(third.status, 200);
});

test('リカバリコードは平文で保存されない', async () => {
  const row = db.prepare("SELECT totp_recovery_codes FROM users WHERE username = 'recov'").get();
  const stored = JSON.parse(row.totp_recovery_codes);
  assert.ok(stored.every((e) => e.salt && e.hash), 'ソルトとハッシュで保存されていること');
});

test('2要素認証の解除にはパスワードが必要', async () => {
  const wrong = await api('POST', '/api/auth/totp/disable', { password: 'wrong-password' });
  assert.equal(wrong.status, 422);

  const ok = await api('POST', '/api/auth/totp/disable', { password: 'test-password-123' });
  assert.equal(ok.status, 200);

  // 解除後はパスワードだけでログインできる
  const res = await login({ username: 'tester', password: 'test-password-123' });
  assert.equal(res.status, 200);
});

test('TOTPは時計が多少ずれていても通る（前後30秒）', () => {
  const totp = require('../../src/utils/totp');
  const secret = totp.generateSecret();
  const now = Date.now();

  const previous = totp.generateCode(secret, Math.floor(now / 1000 / 30) - 1);
  assert.equal(totp.verifyCode(secret, previous, { now }), true);

  const tooOld = totp.generateCode(secret, Math.floor(now / 1000 / 30) - 5);
  assert.equal(totp.verifyCode(secret, tooOld, { now }), false, '離れすぎたコードは通らない');
});

// --- 操作ログ ---

test('受注登録が操作ログに記録される', async () => {
  db.prepare(
    "INSERT INTO customers (uid, name, markup_rate) VALUES ('logcust1', 'ログ得意先', 0.7)"
  ).run();
  db.prepare(
    "INSERT INTO products (uid, name, list_price) VALUES ('logprod1', 'ログ商品', 1000)"
  ).run();
  const customerId = db.prepare("SELECT id FROM customers WHERE uid = 'logcust1'").get().id;
  const productId = db.prepare("SELECT id FROM products WHERE uid = 'logprod1'").get().id;

  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-05',
    customerId,
    productId,
    quantity: 3,
  });
  assert.equal(order.status, 201);

  const logs = await api('GET', '/api/auth/operation-logs?action=order');
  const entry = logs.body.find((l) => l.target_id === order.body.id);
  assert.ok(entry, '受注登録がログに残ること');
  assert.equal(entry.action, 'order.create');
  assert.equal(entry.username, 'tester', '操作した人が記録されること');
  assert.match(entry.summary, /ログ得意先/);
});

test('登録した記録に created_by が入る', async () => {
  const row = db.prepare('SELECT created_by FROM orders ORDER BY id DESC LIMIT 1').get();
  const tester = db.prepare("SELECT id FROM users WHERE username = 'tester'").get();
  assert.equal(row.created_by, tester.id);
});

test('操作ログは管理者以外は見られない', async () => {
  const authService = require('../../src/services/authService');
  authService.createUser({ username: 'loguser', password: 'log-password-1', role: 'staff' });

  const res = await login({ username: 'loguser', password: 'log-password-1' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const logs = await rawFetch('/api/auth/operation-logs', { headers: { Cookie: cookie } });
  assert.equal(logs.status, 403);
});
