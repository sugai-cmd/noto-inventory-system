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
const totp = require('../utils/totp');

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 14;
const MIN_PASSWORD_LENGTH = 8;
// 総当たり対策：同じIDで連続してこの回数失敗すると、一定時間受け付けなくなる
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_WINDOW_MINUTES = 15;

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
    totpEnabled: !!row.totp_enabled,
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
 * 直近の連続失敗回数を数える。
 * 最後に成功したログインより後の失敗だけを数えるので、
 * 一度成功すればカウントはリセットされる。
 */
function recentFailureCount(db, username) {
  const lastSuccess = db
    .prepare(
      `SELECT attempted_at FROM login_attempts
       WHERE username = ? AND succeeded = 1
       ORDER BY id DESC LIMIT 1`
    )
    .get(username);

  const since = lastSuccess?.attempted_at ?? '1970-01-01';
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempts
       WHERE username = ? AND succeeded = 0
         AND attempted_at > ?
         AND attempted_at > datetime('now', ?)`
    )
    .get(username, since, `-${LOCKOUT_WINDOW_MINUTES} minutes`).c;
}

function recordAttempt(db, username, succeeded, ipAddress) {
  db.prepare(
    'INSERT INTO login_attempts (username, succeeded, ip_address) VALUES (?, ?, ?)'
  ).run(username, succeeded ? 1 : 0, ipAddress ?? null);
}

/**
 * ログイン。
 *
 * 総当たり対策として、同じIDで連続して失敗が続くと一時的に受け付けなくなる。
 * 失敗の記録はIDごとに行う（存在しないIDでも記録するので、
 * 「ロックされた＝そのIDは実在する」と分かってしまうことはない）。
 *
 * 2要素認証が有効な利用者は、パスワードに加えて認証アプリのコードが必要になる。
 */
function login({ username, password, totpCode, userAgent, ipAddress }) {
  const db = getConnection();
  const name = (username ?? '').trim();

  const failures = recentFailureCount(db, name);
  if (failures >= MAX_LOGIN_FAILURES) {
    throw new BusinessRuleError(
      `ログインの失敗が続いたため、${LOCKOUT_WINDOW_MINUTES}分ほど時間をおいてからお試しください`,
      { status: 429, code: 'too_many_attempts' }
    );
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
    .get(name);

  const passwordOk =
    user && verifyPassword(password ?? '', user.password_salt, user.password_hash);
  if (!passwordOk) {
    recordAttempt(db, name, false, ipAddress);
    throw new BusinessRuleError('ログインIDまたはパスワードが違います', {
      status: 401,
      code: 'invalid_credentials',
    });
  }

  // 2要素認証
  if (user.totp_enabled) {
    if (!totpCode) {
      // パスワードは合っているので、コード入力欄を出すよう画面に伝える
      throw new BusinessRuleError('認証アプリのコードを入力してください', {
        status: 401,
        code: 'totp_required',
      });
    }
    if (!consumeTotpOrRecoveryCode(db, user, totpCode)) {
      recordAttempt(db, name, false, ipAddress);
      throw new BusinessRuleError('認証コードが違います', {
        status: 401,
        code: 'invalid_totp',
      });
    }
  }

  recordAttempt(db, name, true, ipAddress);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, user_agent)
     VALUES (?, ?, ?, ?)`
  ).run(token, user.id, expiresAt, userAgent ?? null);

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

  return { token, expiresAt, user: toPublicUser(user) };
}

/**
 * 認証アプリのコード、または使い捨てのリカバリコードを検証する。
 * リカバリコードは使ったら消す（1回限り）。
 */
function consumeTotpOrRecoveryCode(db, user, code) {
  if (totp.verifyCode(user.totp_secret, code)) return true;

  const stored = user.totp_recovery_codes ? JSON.parse(user.totp_recovery_codes) : [];
  const normalized = String(code).trim().toLowerCase();

  const index = stored.findIndex((entry) => {
    const { hash } = hashPassword(normalized, entry.salt);
    return hash === entry.hash;
  });
  if (index < 0) return false;

  stored.splice(index, 1);
  db.prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?').run(
    JSON.stringify(stored),
    user.id
  );
  return true;
}

/**
 * 2要素認証の設定を始める。まだ有効化はせず、秘密鍵とQR用URIを返す。
 * 認証アプリに登録してもらい、confirmTotp でコードが合うことを確認してから有効にする。
 */
function beginTotpSetup(userId) {
  const db = getConnection();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new NotFoundError('ユーザーが見つかりません');
  if (user.totp_enabled) {
    throw new BusinessRuleError('2要素認証は既に有効です');
  }

  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, userId);

  return {
    secret,
    otpauthUri: totp.buildOtpAuthUri({ secret, username: user.username }),
  };
}

/**
 * 認証アプリのコードが合うことを確認して2要素認証を有効にする。
 * 同時に、認証器を無くしたとき用のリカバリコードを発行する
 * （この時だけ平文で返す。保存はハッシュ化したものだけ）。
 */
function confirmTotpSetup(userId, code) {
  const db = getConnection();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new NotFoundError('ユーザーが見つかりません');
  if (!user.totp_secret) {
    throw new BusinessRuleError('先に2要素認証の設定を開始してください');
  }
  if (!totp.verifyCode(user.totp_secret, code)) {
    throw new BusinessRuleError('認証コードが違います。時刻がずれていないか確認してください');
  }

  const recoveryCodes = totp.generateRecoveryCodes();
  const hashed = recoveryCodes.map((plain) => {
    const { salt, hash } = hashPassword(plain.toLowerCase());
    return { salt, hash };
  });

  db.prepare(
    'UPDATE users SET totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?'
  ).run(JSON.stringify(hashed), userId);

  return { recoveryCodes };
}

/** 2要素認証を解除する。悪用を防ぐため、パスワードの再入力を求める。 */
function disableTotp(userId, password) {
  const db = getConnection();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new NotFoundError('ユーザーが見つかりません');
  if (!verifyPassword(password ?? '', user.password_salt, user.password_hash)) {
    throw new BusinessRuleError('パスワードが違います');
  }

  db.prepare(
    'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = ?'
  ).run(userId);
  return true;
}

/** 古いログイン試行の記録を掃除する */
function purgeOldLoginAttempts(days = 90) {
  const db = getConnection();
  return db
    .prepare("DELETE FROM login_attempts WHERE attempted_at <= datetime('now', ?)")
    .run(`-${days} days`).changes;
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
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  purgeOldLoginAttempts,
  SESSION_DAYS,
  MIN_PASSWORD_LENGTH,
  MAX_LOGIN_FAILURES,
  LOCKOUT_WINDOW_MINUTES,
};
