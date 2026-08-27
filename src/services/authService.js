// ログイン認証。
//
// パスワードはNode.js標準のcrypto.scryptでハッシュ化する（外部ライブラリ不要）。
// scryptは計算に時間とメモリを要するため、総当たり攻撃に強い。
//
// セッションは「推測不可能なランダムトークンをDBに保存し、HttpOnly Cookieで渡す」方式。
// トークン自体が鍵なので署名は不要で、サーバー側で失効させられる（ログアウトが確実に効く）。

const crypto = require('node:crypto');
const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { BusinessRuleError, NotFoundError } = require('../utils/errors');

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 14;
const MIN_PASSWORD_LENGTH = 8;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

/**
 * パスワード照合。比較にかかる時間から情報が漏れないよう timingSafeEqual を使う。
 */
function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new BusinessRuleError(
      `パスワードは${MIN_PASSWORD_LENGTH}文字以上で設定してください`
    );
  }
}

/** 画面やAPIに返してよい項目だけに絞る（ハッシュ・ソルトは決して返さない） */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: !!row.is_active,
    lastLoginAt: row.last_login_at,
  };
}

function createUser({ username, displayName, password, role = 'staff' }) {
  const db = getConnection();
  assertPasswordStrength(password);

  const name = (username ?? '').trim();
  if (!name) throw new BusinessRuleError('ログインIDを入力してください');

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (existing) throw new BusinessRuleError(`ログインID「${name}」は既に使われています`);

  const { salt, hash } = hashPassword(password);
  const result = db
    .prepare(
      `INSERT INTO users (uid, username, display_name, password_salt, password_hash, role)
       VALUES (@uid, @username, @displayName, @salt, @hash, @role)`
    )
    .run({
      uid: generateUid(db, 'users'),
      username: name,
      displayName: (displayName ?? '').trim() || name,
      salt,
      hash,
      role,
    });

  return toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
}

function listUsers() {
  const db = getConnection();
  return db.prepare('SELECT * FROM users ORDER BY username').all().map(toPublicUser);
}

function countUsers() {
  const db = getConnection();
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get().c;
}

function changePassword(userId, { currentPassword, newPassword }) {
  const db = getConnection();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new NotFoundError('ユーザーが見つかりません');

  if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
    throw new BusinessRuleError('現在のパスワードが違います');
  }
  assertPasswordStrength(newPassword);

  const { salt, hash } = hashPassword(newPassword);
  db.prepare(
    `UPDATE users SET password_salt = ?, password_hash = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(salt, hash, userId);

  // パスワードを変えたら、他の端末に残っているセッションは無効にする
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return true;
}

/**
 * ログイン。成功したらセッショントークンを返す。
 * IDが存在しない場合とパスワード違いで応答を変えないようにし、
 * 「そのIDは存在する」という情報を与えないようにする。
 */
function login({ username, password, userAgent }) {
  const db = getConnection();
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
    .get((username ?? '').trim());

  const ok = user && verifyPassword(password ?? '', user.password_salt, user.password_hash);
  if (!ok) {
    throw new BusinessRuleError('ログインIDまたはパスワードが違います', {
      status: 401,
      code: 'invalid_credentials',
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, user_agent)
     VALUES (?, ?, ?, ?)`
  ).run(token, user.id, expiresAt, userAgent ?? null);

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

  return { token, expiresAt, user: toPublicUser(user) };
}

function logout(token) {
  if (!token) return false;
  const db = getConnection();
  return db.prepare('DELETE FROM sessions WHERE token = ?').run(token).changes > 0;
}

/**
 * トークンからログイン中のユーザーを解決する。
 * 期限切れのセッションはその場で削除する。
 */
function resolveSession(token) {
  if (!token) return null;
  const db = getConnection();

  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.is_active = 1`
    )
    .get(token);

  if (!row) return null;

  if (new Date(row.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return toPublicUser(row);
}

/** 期限切れセッションの掃除（起動時に実行する） */
function purgeExpiredSessions() {
  const db = getConnection();
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

module.exports = {
  createUser,
  listUsers,
  countUsers,
  changePassword,
  login,
  logout,
  resolveSession,
  purgeExpiredSessions,
  SESSION_DAYS,
  MIN_PASSWORD_LENGTH,
};
