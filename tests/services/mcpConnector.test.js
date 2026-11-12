// 音声入力のコネクタ（MCP）を、claude.ai と同じ手順（OAuthでログイン → /mcp）で検証する。
//
// いちばん大事なのは「画面から入れた場合と結果が1円・0.1Lも変わらない」こと。
// 同じ構成のタンクを2組用意し、片方は画面のAPI、もう片方はコネクタで
// 開始 → 投入追加 → 完了 を行って、台帳・タンク液量・酒税の集計を突き合わせる。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-mcp-connector.sqlite');
const api = harness.api;

const VOICE_USER = { username: 'voice', password: 'voice-password-123' };
const NO_TOTP_USER = { username: 'nototp', password: 'nototp-password-123' };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let db;
let mcpServer;
let mcpBase;
let totpSecret;
let accessToken;
let refreshToken;
let clientId;

/** タンクIDを名前から引く */
const tankId = (code) => db.prepare('SELECT id FROM tanks WHERE code = ?').get(code).id;

function seedTanks(db, generateUid) {
  const insert = db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, ?, ?, ?, ?, 0)`
  );
  for (const set of ['A', 'B']) {
    insert.run(generateUid(db, 'tanks'), `SP-${set}1`, `原酒ポリ${set}1`, '原酒ポリタンク', 200);
    insert.run(generateUid(db, 'tanks'), `SP-${set}2`, `原酒ポリ${set}2`, '原酒ポリタンク', 200);
    insert.run(generateUid(db, 'tanks'), `T-${set}`, `浄酎タンク${set}`, 'ステンレスタンク', 1000);
    insert.run(generateUid(db, 'tanks'), `U-${set}`, `残渣タンク${set}`, 'PP', 500);
  }
  // 名前が重なるタンク（あいまいな指定の試験用）
  insert.run(generateUid(db, 'tanks'), 'T-X1', '予備タンク', 'ステンレスタンク', 100);
  insert.run(generateUid(db, 'tanks'), 'T-X2', '予備 タンク', 'ステンレスタンク', 100);
  // 小さい浄酎タンク（最大液量超過の注意点の試験用）
  insert.run(generateUid(db, 'tanks'), 'T-S', '小タンク', 'ステンレスタンク', 10);
}

// --- OAuth（claude.ai がする手順） ---

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function currentTotp() {
  const totp = require('../../src/utils/totp');
  return totp.generateCode(totpSecret, Math.floor(Date.now() / 1000 / 30));
}

async function registerClient(redirectUris = [CALLBACK]) {
  return fetch(`${mcpBase}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
}

/** ログイン画面を開いて pendingId を取り出す */
async function openLoginPage(client, challenge) {
  const url = new URL(`${mcpBase}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: `${mcpBase}/mcp`,
  }).toString();
  const res = await fetch(url);
  const html = await res.text();
  return { res, html, pendingId: html.match(/name="pendingId" value="([^"]+)"/)?.[1] };
}

function submitLogin(fields) {
  return fetch(`${mcpBase}/oauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

async function postToken(fields) {
  const res = await fetch(`${mcpBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.json() };
}

// --- MCP ---

let rpcId = 0;
async function rpc(method, params, token = accessToken) {
  const res = await fetch(`${mcpBase}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** ツールを呼び、結果のJSONを返す（isError なら error を返す） */
async function callTool(name, args) {
  const { status, body } = await rpc('tools/call', { name, arguments: args });
  assert.equal(status, 200, JSON.stringify(body));
  const result = body.result;
  const payload = JSON.parse(result.content[0].text);
  return { isError: Boolean(result.isError), ...payload };
}

/** 記録が増えていないかを確かめるための行数 */
function rowCounts() {
  const tables = [
    'distillations',
    'distillation_details',
    'distillation_residues',
    'raw_sake_ledger',
    'tank_ledger',
    'operation_logs',
    'mcp_requests',
  ];
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));
}

test.before(async () => {
  ({ db } = await harness.setup(seedTanks));
  const authService = require('../../src/services/authService');
  const totp = require('../../src/utils/totp');

  // 2要素認証を有効にした利用者（コネクタでログインできる）と、無効の利用者
  authService.createUser({ ...VOICE_USER, displayName: '音声入力の人', role: 'admin' });
  authService.createUser({ ...NO_TOTP_USER, displayName: '2要素なしの人', role: 'admin' });
  totpSecret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE username = ?').run(totpSecret, VOICE_USER.username);

  const { createMcpApp } = require('../../src/mcp/mcpApp');
  mcpServer = http.createServer();
  await new Promise((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
  mcpBase = `http://127.0.0.1:${mcpServer.address().port}`;
  mcpServer.on('request', createMcpApp({ publicUrl: mcpBase, rateLimit: false }));

  // 両方の組に同じだけ原酒を入れておく
  for (const set of ['A', 'B']) {
    for (const [code, quantity] of [[`SP-${set}1`, 150], [`SP-${set}2`, 80]]) {
      const r = await api('POST', '/api/raw-sake-receipts', {
        txnDate: '2026-11-01',
        toTankId: tankId(code),
        quantity,
        supplier: '山田酒造',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
  }
});

test.after(async () => {
  if (mcpServer) await new Promise((resolve) => mcpServer.close(resolve));
  await harness.teardown();
});

// --- 認証 ---

test('認証なし・でたらめなトークンでは /mcp に入れない', async () => {
  const none = await rpc('tools/list', {}, null);
  assert.equal(none.status, 401);
  const bad = await rpc('tools/list', {}, 'not-a-real-token');
  assert.equal(bad.status, 401);
});

test('公開用のアプリからは、画面・/api は見えない', async () => {
  for (const path of ['/api/tanks', '/api/distillations', '/distillation.html', '/login.html', '/']) {
    const res = await fetch(`${mcpBase}${path}`);
    assert.equal(res.status, 404, path);
  }
});

test('案内（メタデータ）が /mcp を指している', async () => {
  const pr = await (await fetch(`${mcpBase}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(pr.resource, `${mcpBase}/mcp`);
  const as = await (await fetch(`${mcpBase}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.registration_endpoint, `${mcpBase}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('claude.ai 以外のリダイレクト先ではクライアント登録できない', async () => {
  const res = await registerClient(['https://evil.example.com/callback']);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_client_metadata');
});

test('2要素認証が無効の利用者はコネクタでログインできない', async () => {
  const reg = await (await registerClient()).json();
  const { challenge } = pkce();
  const { pendingId } = await openLoginPage(reg.client_id, challenge);
  const res = await submitLogin({ pendingId, ...NO_TOTP_USER, totpCode: '000000' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /2要素認証が有効になっていません/);
});

test('パスワード違いは画面のログインと同じく失敗として数えられる', async () => {
  const reg = await (await registerClient()).json();
  const { challenge } = pkce();
  const { pendingId } = await openLoginPage(reg.client_id, challenge);
  const res = await submitLogin({ pendingId, username: VOICE_USER.username, password: 'wrong', totpCode: currentTotp() });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /ログインIDまたはパスワードが違います/);
  const row = db
    .prepare('SELECT succeeded FROM login_attempts WHERE username = ? ORDER BY id DESC LIMIT 1')
    .get(VOICE_USER.username);
  assert.equal(row.succeeded, 0);
});

test('登録 → ログイン → 認可コード → トークン の一連が通る', async () => {
  const reg = await registerClient();
  assert.equal(reg.status, 201);
  clientId = (await reg.json()).client_id;

  const { verifier, challenge } = pkce();
  const page = await openLoginPage(clientId, challenge);
  assert.equal(page.res.status, 200);
  assert.ok(page.pendingId);
  assert.match(page.html, /取消・修正・削除はできません/);

  const login = await submitLogin({ pendingId: page.pendingId, ...VOICE_USER, totpCode: currentTotp() });
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
  assert.equal(location.searchParams.get('state'), 'state-123');
  const code = location.searchParams.get('code');

  // PKCE の検証値が違えば断る
  const wrong = await postToken({
    grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: clientId, redirect_uri: CALLBACK,
  });
  assert.equal(wrong.status, 400);

  const token = await postToken({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK,
    resource: `${mcpBase}/mcp`,
  });
  assert.equal(token.status, 200, JSON.stringify(token.body));
  accessToken = token.body.access_token;
  refreshToken = token.body.refresh_token;

  // 認可コードは1回しか使えない
  const again = await postToken({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK,
  });
  assert.equal(again.status, 400);

  // DBにはトークンそのものを残さない
  const stored = db.prepare('SELECT token_hash FROM oauth_tokens').all().map((r) => r.token_hash);
  assert.ok(!stored.includes(accessToken));
});

test('リフレッシュトークンは使うと新しくなり、古いものは使えなくなる', async () => {
  const first = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const reused = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  assert.equal(reused.status, 400);
  accessToken = first.body.access_token;
  refreshToken = first.body.refresh_token;
});

test('ツールは7つだけ（取消・修正・削除・原酒入荷は無い）', async () => {
  const { status, body } = await rpc('tools/list', {});
  assert.equal(status, 200);
  assert.deepEqual(body.result.tools.map((t) => t.name).sort(), [
    'add_distillation_input',
    'complete_distillation',
    'get_distillation',
    'get_distillation_options',
    'list_active_distillations',
    'list_tanks',
    'start_distillation',
  ]);
});

// --- 読み取り ---

test('タンク一覧に種別と液量が出る', async () => {
  const r = await callTool('list_tanks', { kind: '原酒' });
  const a1 = r.tanks.find((t) => t.code === 'SP-A1');
  assert.equal(a1.kind, '原酒');
  assert.equal(a1.currentVolumeL, 150);
  assert.ok(r.tanks.every((t) => t.kind === '原酒'));
});

test('タンクの名前があいまいなときは登録せず候補を返す', async () => {
  const before = rowCounts();
  const r = await callTool('complete_distillation', {
    distillation: 1,
    completedOn: '2026-11-12',
    completedTime: '10:00',
    outputL: 1,
    outputTank: '予備タンク ',
    preview: true,
  });
  // 蒸留記録はタンクより先に引くので、記録が無ければそこで止まる（タンクの候補選びまで進まない）
  assert.ok(r.isError);
  assert.equal(r.error.code, 'distillation_not_found');

  const amb = await callTool('start_distillation', {
    startedOn: '2026-11-12',
    startedTime: '09:00',
    items: [{ tank: 'よびたんく', volumeL: 1 }],
    preview: true,
  });
  assert.ok(amb.isError);
  assert.equal(amb.error.code, 'tank_not_found');

  const loose = await callTool('start_distillation', {
    startedOn: '2026-11-12',
    startedTime: '09:00',
    items: [{ tank: 'ﾖﾋﾞﾀﾝｸ', volumeL: 1 }],
    preview: true,
  });
  assert.ok(loose.isError);

  const twin = await callTool('start_distillation', {
    startedOn: '2026-11-12',
    startedTime: '09:00',
    items: [{ tank: '予備　タンク', volumeL: 1 }], // 全角空白。空白を無視すると2本に当たる
    preview: true,
  });
  assert.ok(twin.isError);
  assert.equal(twin.error.code, 'tank_ambiguous');
  assert.deepEqual(twin.error.candidates.map((c) => c.code).sort(), ['T-X1', 'T-X2']);
  assert.deepEqual(rowCounts(), before);
});

// --- 画面との一致 ---

const START = { startedOn: '2026-11-10', startedTime: '08:30', plannedDuration: '8時間' };
const COMPLETE = {
  completedOn: '2026-11-10',
  completedTime: '17:45',
  outputL: 52.4,
  outputAbv: 41.5,
  residue: { quantity: 120.5, abv: 2.1, saltStatus: '有', saltInputQty: 300, saltConcentration: 1.2 },
};

let screenDistillationId;
let mcpDistillationId;

test('preview では何も保存されず、保存される内容とタンクの変化が返る', async () => {
  const before = rowCounts();
  const r = await callTool('start_distillation', {
    ...START,
    plannedDuration: '480分',
    items: [{ tank: '原酒ポリB1', volumeL: 100.5, note: '一回目' }],
    preview: true,
  });
  assert.equal(r.isError, false);
  assert.equal(r.preview, true);
  assert.equal(r.saved, false);
  assert.equal(r.wouldSucceed, true);
  assert.equal(r.input.plannedDuration, '8時間');
  assert.equal(r.record.total_input_l, 100.5);
  const b1 = r.tanks.find((t) => t.code === 'SP-B1');
  assert.deepEqual([b1.beforeL, b1.afterL, b1.changeL], [150, 49.5, -100.5]);
  assert.deepEqual(rowCounts(), before);
});

test('残量超過は preview で注意点とエラーが返り、本登録では画面と同じエラーになる', async () => {
  const before = rowCounts();
  const p = await callTool('start_distillation', {
    ...START,
    items: [{ tank: 'SP-B2', volumeL: 999 }],
    preview: true,
  });
  assert.equal(p.wouldSucceed, false);
  assert.ok(p.warnings.some((w) => w.includes('残量 80L より投入量 999L が多い')));

  const screen = await api('POST', '/api/distillations', {
    ...START,
    items: [{ tankId: tankId('SP-A2'), volumeL: 999 }],
  });
  assert.equal(screen.status, 422);

  const real = await callTool('start_distillation', {
    ...START,
    items: [{ tank: 'SP-B2', volumeL: 999 }],
    requestKey: 'key-over-capacity',
  });
  assert.ok(real.isError);
  assert.equal(real.error.message, screen.body.message.replace('原酒ポリA2', '原酒ポリB2'));
  assert.deepEqual(rowCounts(), before);
});

test('本登録には requestKey が要る', async () => {
  const r = await callTool('start_distillation', { ...START, items: [{ tank: 'SP-B1', volumeL: 100.5 }] });
  assert.ok(r.isError);
  assert.equal(r.error.code, 'request_key_required');
});

test('開始：画面（A組）とコネクタ（B組）で同じ記録になる', async () => {
  const screen = await api('POST', '/api/distillations', {
    ...START,
    items: [
      { tankId: tankId('SP-A1'), volumeL: 100.5, note: '一回目' },
      { tankId: tankId('SP-A2'), volumeL: 30.25 },
    ],
  });
  assert.equal(screen.status, 201, JSON.stringify(screen.body));
  screenDistillationId = screen.body.distillationId;

  const r = await callTool('start_distillation', {
    ...START,
    plannedDuration: '8h',
    items: [
      { tank: '原酒ポリB1', volumeL: 100.5, note: '一回目' },
      { tank: 'SP-B2', volumeL: 30.25 },
    ],
    requestKey: 'key-start-0001',
  });
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(r.saved, true);
  mcpDistillationId = r.record.id;
  assert.equal(r.record.status, '蒸留中');
  assert.equal(r.tanks.find((t) => t.code === 'SP-B1').afterL, 49.5);
});

test('同じ requestKey で2回呼んでも1件しか登録されない', async () => {
  const before = rowCounts();
  const again = await callTool('start_distillation', {
    ...START,
    plannedDuration: '8時間',
    items: [
      { tank: tankId('SP-B1'), volumeL: 100.5, note: '一回目' },
      { tank: '原酒ポリB2', volumeL: 30.25 },
    ],
    requestKey: 'key-start-0001',
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.record.id, mcpDistillationId);
  assert.deepEqual(rowCounts(), before);

  const conflict = await callTool('start_distillation', {
    ...START,
    items: [{ tank: 'SP-B1', volumeL: 1 }],
    requestKey: 'key-start-0001',
  });
  assert.ok(conflict.isError);
  assert.equal(conflict.error.code, 'request_key_conflict');
  assert.deepEqual(rowCounts(), before);
});

test('投入追加：画面とコネクタで同じ記録になる', async () => {
  const screen = await api('POST', `/api/distillations/${screenDistillationId}/details`, {
    tankId: tankId('SP-A2'),
    volumeL: 12.3,
    note: '追加',
  });
  assert.equal(screen.status, 201, JSON.stringify(screen.body));

  const code = db.prepare('SELECT distillation_code FROM distillations WHERE id = ?').get(mcpDistillationId).distillation_code;
  const r = await callTool('add_distillation_input', {
    distillation: code,
    tank: '原酒ポリB2',
    volumeL: 12.3,
    note: '追加',
    requestKey: 'key-add-0001',
  });
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(r.record.total_input_l, screen.body.totalInputL);
});

test('完了：画面とコネクタで同じ記録になる', async () => {
  const screen = await api('POST', `/api/distillations/${screenDistillationId}/complete`, {
    completedOn: COMPLETE.completedOn,
    completedTime: COMPLETE.completedTime,
    outputTankId: tankId('T-A'),
    outputL: COMPLETE.outputL,
    outputAbv: COMPLETE.outputAbv,
    residue: {
      collectedOn: COMPLETE.completedOn,
      collectedTime: COMPLETE.completedTime,
      saltStatus: '有',
      saltInputQty: 300,
      quantity: 120.5,
      abv: 2.1,
      saltConcentration: 1.2,
      destinationTankId: tankId('U-A'),
    },
  });
  assert.equal(screen.status, 200, JSON.stringify(screen.body));

  const preview = await callTool('complete_distillation', {
    distillation: mcpDistillationId,
    completedOn: COMPLETE.completedOn,
    completedTime: COMPLETE.completedTime,
    outputL: COMPLETE.outputL,
    outputAbv: COMPLETE.outputAbv,
    outputTank: '浄酎タンクB',
    residue: { quantityL: 120.5, abv: 2.1, destinationTank: '残渣タンクB', saltStatus: '有', saltInputQty: 300, saltConcentration: 1.2 },
    preview: true,
  });
  assert.equal(preview.wouldSucceed, true, JSON.stringify(preview));
  assert.deepEqual(preview.warnings, []);

  const r = await callTool('complete_distillation', {
    distillation: mcpDistillationId,
    completedOn: COMPLETE.completedOn,
    completedTime: COMPLETE.completedTime,
    outputL: COMPLETE.outputL,
    outputAbv: COMPLETE.outputAbv,
    outputTank: '浄酎タンクB',
    residue: { quantityL: 120.5, abv: 2.1, destinationTank: '残渣タンクB', saltStatus: '有', saltInputQty: 300, saltConcentration: 1.2 },
    requestKey: 'key-complete-0001',
  });
  assert.equal(r.isError, false, JSON.stringify(r));
  const t = r.tanks.find((x) => x.code === 'T-B');
  assert.deepEqual([t.beforeL, t.afterL], [0, 52.4]);
});

test('A組とB組で、蒸留記録・明細・残渣・台帳・タンク液量が一致する', () => {
  const header = (id) => {
    const row = db.prepare('SELECT * FROM distillations WHERE id = ?').get(id);
    const { id: _id, uid, distillation_code, input_summary, output_tank_id, created_at, updated_at, ...rest } = row;
    return rest;
  };
  assert.deepEqual(header(mcpDistillationId), header(screenDistillationId));

  const details = (id) =>
    db.prepare('SELECT input_l, note, is_cancelled FROM distillation_details WHERE distillation_id = ? ORDER BY id').all(id);
  assert.deepEqual(details(mcpDistillationId), details(screenDistillationId));

  const residues = (id) =>
    db
      .prepare(
        `SELECT collected_on, collected_time, quantity, abv, salt_status, salt_input_qty, salt_concentration, destination
           FROM distillation_residues WHERE distillation_id = ? ORDER BY id`
      )
      .all(id);
  assert.deepEqual(residues(mcpDistillationId), residues(screenDistillationId));

  const rawLedger = (id) =>
    db.prepare('SELECT txn_date, txn_type, quantity, is_cancelled FROM raw_sake_ledger WHERE distillation_id = ? ORDER BY id').all(id);
  assert.deepEqual(rawLedger(mcpDistillationId), rawLedger(screenDistillationId));

  const tankLedger = (id) =>
    db.prepare('SELECT txn_date, txn_type, quantity_l, abv, data_kind, is_cancelled FROM tank_ledger WHERE distillation_id = ? ORDER BY id').all(id);
  assert.deepEqual(tankLedger(mcpDistillationId), tankLedger(screenDistillationId));

  const vol = (view, code, col = 'current_volume_l') =>
    db.prepare(`SELECT ${col} AS v FROM ${view} WHERE tank_id = ?`).get(tankId(code)).v;
  for (const n of ['1', '2']) {
    assert.equal(vol('v_raw_sake_tank_volume', `SP-B${n}`), vol('v_raw_sake_tank_volume', `SP-A${n}`));
  }
  assert.equal(vol('v_tank_monitor', 'T-B'), vol('v_tank_monitor', 'T-A'));
  assert.equal(vol('v_residue_tank_collected', 'U-B', 'collected_l'), vol('v_residue_tank_collected', 'U-A', 'collected_l'));

  // 原酒ロットの引き当ても同じ量になる
  const lots = (id) =>
    db
      .prepare(
        `SELECT SUM(a.quantity) AS q FROM raw_sake_lot_allocations a
           JOIN raw_sake_ledger l ON l.id = a.payout_ledger_id WHERE l.distillation_id = ?`
      )
      .get(id)?.q ?? null;
  assert.equal(lots(mcpDistillationId), lots(screenDistillationId));
  assert.ok(lots(mcpDistillationId) > 0);
});

test('酒税の集計が、画面とコネクタで同じだけ変わる', async () => {
  // 蒸留の記録は酒税の集計に入らないが、入らないことも含めて同じであることを確かめる。
  // B組の記録を一時的に取り除いた集計と、A組を取り除いた集計を比べる
  const report = async () => (await api('GET', '/api/liquor-tax/monthly?month=2026-11')).body;
  const full = await report();
  const without = async (id) => {
    let result;
    const rollback = Symbol('rollback');
    try {
      db.transaction(() => {
        db.prepare('UPDATE tank_ledger SET is_cancelled = 1 WHERE distillation_id = ?').run(id);
        db.prepare('UPDATE raw_sake_ledger SET is_cancelled = 1 WHERE distillation_id = ?').run(id);
        result = require('../../src/services/liquorTaxService').monthlyReport('2026-11');
        throw rollback;
      })();
    } catch (err) {
      if (err !== rollback) throw err;
    }
    return result;
  };
  assert.deepEqual(await without(mcpDistillationId), await without(screenDistillationId));
  assert.ok(full);
});

test('操作ログに「音声入力（MCP）経由」と登録者が残る', () => {
  const rows = db
    .prepare("SELECT action, username, summary, detail_json FROM operation_logs WHERE action LIKE 'mcp.%' ORDER BY id")
    .all();
  assert.deepEqual(rows.map((r) => r.action), [
    'mcp.distillation.start',
    'mcp.distillation.addDetail',
    'mcp.distillation.complete',
  ]);
  for (const r of rows) {
    assert.equal(r.username, VOICE_USER.username);
    assert.match(r.summary, /^【音声入力（MCP）経由】/);
    assert.equal(JSON.parse(r.detail_json).via, 'mcp');
  }
  // 投入追加はサービスの操作ログにも登録者が入る
  const add = db
    .prepare("SELECT username FROM operation_logs WHERE action = 'distillation.addDetail' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(add.username, VOICE_USER.username);
});

test('完了済みの記録には投入追加・完了ができない（画面と同じ）', async () => {
  const add = await callTool('add_distillation_input', {
    distillation: mcpDistillationId,
    tank: 'SP-B1',
    volumeL: 1,
    requestKey: 'key-add-after-complete',
  });
  assert.ok(add.isError);
  assert.equal(add.error.code, 'conflict');

  const done = await callTool('complete_distillation', {
    distillation: mcpDistillationId,
    completedOn: '2026-11-11',
    completedTime: '10:00',
    outputL: 1,
    outputTank: 'T-B',
    preview: true,
  });
  assert.equal(done.wouldSucceed, false);
  assert.ok(done.warnings.some((w) => w.includes('完了です')));
});

test('最大液量超過・度数の範囲外・日時の前後は preview の注意点に出る', async () => {
  const start = await callTool('start_distillation', {
    startedOn: '2026-11-12',
    startedTime: '09:00',
    items: [{ tank: 'SP-B1', volumeL: 5 }],
    requestKey: 'key-start-0002',
  });
  assert.equal(start.isError, false, JSON.stringify(start));

  const p = await callTool('complete_distillation', {
    distillation: start.record.id,
    completedOn: '2026-11-11',
    completedTime: '08:00',
    outputL: 20,
    outputAbv: 140,
    outputTank: '小タンク',
    residue: { quantityL: 1, destinationTank: 'U-B', saltStatus: '有' },
    preview: true,
  });
  assert.equal(p.wouldSucceed, true, JSON.stringify(p));
  const joined = p.warnings.join('\n');
  assert.match(joined, /最大液量 10L を超えます/);
  assert.match(joined, /0〜100% の範囲外/);
  assert.match(joined, /投入開始日時 .* より前/);
  assert.match(joined, /投入量の合計 5L より多い/);
  assert.match(joined, /食塩「有」ですが投入量/);

  // 残渣の行き先に浄酎タンクを指定すると、画面と同じく本登録で断られる
  const wrongResidue = await callTool('complete_distillation', {
    distillation: start.record.id,
    completedOn: '2026-11-12',
    completedTime: '18:00',
    outputL: 3,
    outputTank: 'T-B',
    residue: { quantityL: 1, destinationTank: 'T-A' },
    requestKey: 'key-complete-wrong-residue',
  });
  assert.ok(wrongResidue.isError);
  assert.match(wrongResidue.error.message, /残渣の行き先は残渣タンクだけです/);
});

test('2要素認証を無効にすると、発行済みのトークンも使えなくなる', async () => {
  db.prepare('UPDATE users SET totp_enabled = 0 WHERE username = ?').run(VOICE_USER.username);
  try {
    const r = await rpc('tools/list', {});
    assert.equal(r.status, 401);
  } finally {
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE username = ?').run(VOICE_USER.username);
  }
});

test('蒸留設定時間の書き方をそろえる', () => {
  const { normalizePlannedDuration } = require('../../src/mcp/plannedDuration');
  const cases = {
    '8時間': '8時間',
    '8h': '8時間',
    '８時間': '8時間',
    '480分': '8時間',
    '8時間半': '8時間30分',
    '1.5時間': '1時間30分',
    '7時間 45分': '7時間45分',
    '45分': '45分',
    '8:30': '8時間30分',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(normalizePlannedDuration(input), { value: expected, recognized: true }, input);
  }
  assert.deepEqual(normalizePlannedDuration('いつもどおり'), { value: 'いつもどおり', recognized: false });
  assert.deepEqual(normalizePlannedDuration(undefined), { value: undefined, recognized: true });
});
