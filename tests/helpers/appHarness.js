// テスト用のアプリ起動ヘルパー。
//
// 認証を有効にしたまま（＝本番と同じ構成で）テストできるよう、
// 管理者ユーザーを作ってログインし、以降のリクエストにセッションCookieを付ける。

const fs = require('node:fs');
const path = require('node:path');

const TEST_USER = { username: 'tester', password: 'test-password-123', role: 'admin' };

/**
 * @param {string} dbName - db/ 配下に作るテスト用DBのファイル名
 * @returns {{setup: Function, teardown: Function}}
 */
function createHarness(dbName) {
  const dbPath = path.resolve(__dirname, '..', '..', 'db', dbName);
  removeDbFiles(dbPath);
  // config.js は読込時に DB_PATH を評価するため、他のrequireより前に設定する
  process.env.DB_PATH = dbPath;

  const state = { server: null, baseUrl: null, cookie: null };

  async function setup(seed) {
    const { migrate } = require('../../src/db/migrate');
    const { getConnection } = require('../../src/db/connection');
    const { createApp } = require('../../src/app');
    const authService = require('../../src/services/authService');
    const { generateUid } = require('../../src/utils/uid');

    migrate();
    const db = getConnection();
    if (seed) seed(db, generateUid);

    authService.createUser({ ...TEST_USER, displayName: 'テスト管理者' });

    state.server = createApp().listen(0);
    await new Promise((resolve) => state.server.once('listening', resolve));
    state.baseUrl = `http://127.0.0.1:${state.server.address().port}`;

    const res = await fetch(`${state.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER.username, password: TEST_USER.password }),
    });
    if (!res.ok) throw new Error(`テスト用ログインに失敗しました (HTTP ${res.status})`);
    state.cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    return { db, baseUrl: state.baseUrl };
  }

  async function teardown() {
    if (state.server) await new Promise((resolve) => state.server.close(resolve));
    removeDbFiles(dbPath);
  }

  /** ログイン済みとしてAPIを叩く */
  async function api(method, urlPath, body) {
    const headers = { Cookie: state.cookie };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${state.baseUrl}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const isJson = res.headers.get('content-type')?.includes('application/json');
    return { status: res.status, body: isJson && text ? JSON.parse(text) : text, res };
  }

  /** 認証なしで叩く（保護されているかの確認用） */
  function rawFetch(urlPath, init) {
    return fetch(`${state.baseUrl}${urlPath}`, init);
  }

  return { setup, teardown, api, rawFetch, state, TEST_USER };
}

function removeDbFiles(dbPath) {
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
}

module.exports = { createHarness, TEST_USER };
