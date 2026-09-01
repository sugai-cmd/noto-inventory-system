// 認証ミドルウェア。
// Cookieのセッショントークンから利用者を解決し、未ログインならアクセスを止める。

const authService = require('../services/authService');

const COOKIE_NAME = 'noto_session';

/** Cookieヘッダを読み解く（cookie-parser相当。依存を増やさないため自前で実装） */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * セッションCookieを発行する。
 * httpOnly: JavaScriptから読めない（XSSでトークンを盗まれにくくする）
 * sameSite=lax: 他サイトからの意図しないリクエストにCookieを付けない
 * secure: HTTPS接続のときだけ送る
 */
function setSessionCookie(res, token, expiresAt, { secure }) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: new Date(expiresAt),
    path: '/',
  });
}

function clearSessionCookie(res, { secure }) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

/**
 * 全リクエストでセッションを解決して req.user に載せる（ここでは弾かない）。
 */
function attachUser(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.sessionToken = cookies[COOKIE_NAME] ?? null;
  req.user = authService.resolveSession(req.sessionToken);
  next();
}

/**
 * ログイン必須。APIは401のJSON、画面へのアクセスはログイン画面へ誘導する。
 */
function requireAuth(req, res, next) {
  if (req.user) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized', message: 'ログインしてください' });
  }
  const next_ = encodeURIComponent(req.originalUrl);
  res.redirect(`/login.html?next=${next_}`);
}

/** 管理者のみ許可 */
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'forbidden', message: 'この操作には管理者権限が必要です' });
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireAdmin,
};
