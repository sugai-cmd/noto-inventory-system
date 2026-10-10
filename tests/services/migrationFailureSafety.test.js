// 移行SQLが落ちても、サーバーは起動すること。
//
// **これが今回の事故で一番困った点。**
// 0027 の報告番号の採番が既存番号と衝突して migrate() が例外を投げ、
// server.js ごと落ちて画面が一切出なくなった。利用者からは
// 「急にアクセスできない。ローカルホストも同様」としか見えず、
// 原因に辿り着く手段が無かった（業務が停止した）。
//
// 移行が落ちたときは:
//   ・サーバーは起動する（画面は出る）
//   ・どのファイルで落ちたかが分かる
//   ・読み取りは通る（調べ物・印刷は続けられる）
//   ・**記録の追加・変更は止める**（中途半端なスキーマで書かせない）

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-migration-failure.sqlite');
const api = harness.api;

const {
  setMigrationState,
  getMigrationState,
  migrationNotice,
} = require('../../src/middlewares/migrationState');

test.before(async () => {
  await harness.setup();
});

test.after(async () => {
  setMigrationState({ ok: true });
  await harness.teardown();
});

test('ふだんは「取り込み済み」を返し、何も止めない', async () => {
  setMigrationState({ ok: true });

  const state = await api('GET', '/api/migration-state');
  assert.equal(state.status, 200);
  assert.equal(state.body.ok, true);
  assert.equal(state.body.notice, null);

  // 更新系が通ること（止まっていないことを対で見る）
  const ok = await api('POST', '/api/breweries', { name: '通常時の酒蔵' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('移行が落ちていても、画面と読み取りは生きている', async () => {
  setMigrationState({ ok: false, failed: '0027_payments.sql', message: 'UNIQUE constraint failed' });

  // ここが本題。サーバーが応答すること
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);

  const list = await api('GET', '/api/breweries');
  assert.equal(list.status, 200, '読み取りまで止めると調べ物もできない');
});

test('どのファイルで落ちたかが分かる', async () => {
  const state = await api('GET', '/api/migration-state');
  assert.equal(state.body.ok, false);
  assert.equal(state.body.failed, '0027_payments.sql');
  assert.match(state.body.notice, /0027_payments\.sql/);
  assert.match(state.body.notice, /記録の追加・変更はできません/);
  assert.match(migrationNotice(), /logs\/error\.log/, '次に何をすればよいかを書く');
});

test('記録の追加・変更は止める', async () => {
  // 中途半端なスキーマに書くと、あとから直せないデータが増える
  const res = await api('POST', '/api/breweries', { name: '移行中の酒蔵' });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /取り込みが完了していません/);

  // 実際に増えていないこと（メッセージだけ出して書いていた、を防ぐ）
  const list = await api('GET', '/api/breweries');
  assert.ok(
    !list.body.some((b) => b.name === '移行中の酒蔵'),
    '止めたのに登録されています'
  );
});

test('ログインとログアウトは止めない（止めると誰も入れない）', async () => {
  const res = await api('POST', '/api/auth/login', { username: 'tester', password: 'wrong' });
  // 認証の判定まで届いていること（422 で門前払いされていない）
  assert.notEqual(res.status, 422, 'ログインまで止めると復旧作業ができない');
});

test('状態は上書きできる（直したら元に戻る）', async () => {
  setMigrationState({ ok: true });
  assert.equal(getMigrationState().ok, true);

  const res = await api('POST', '/api/breweries', { name: '復旧後の酒蔵' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});
