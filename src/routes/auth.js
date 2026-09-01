const express = require('express');
const { z } = require('zod');
const authService = require('../services/authService');
const operationLogService = require('../services/operationLogService');
const { validateRequest } = require('../middlewares/validateRequest');
const {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
} = require('../middlewares/auth');

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1, 'ログインIDを入力してください'),
  password: z.string().min(1, 'パスワードを入力してください'),
  // 2要素認証が有効な利用者のみ必要
  totpCode: z.string().optional(),
});

const createUserSchema = z.object({
  username: z.string().min(1, 'ログインIDを入力してください'),
  displayName: z.string().optional(),
  password: z.string().min(authService.MIN_PASSWORD_LENGTH),
  role: z.enum(['admin', 'staff']).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '現在のパスワードを入力してください'),
  newPassword: z.string().min(authService.MIN_PASSWORD_LENGTH),
});

/** HTTPS接続なら secure Cookie を使う（リバースプロキシ経由も考慮） */
function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

router.post('/login', validateRequest(loginSchema), (req, res, next) => {
  try {
    const { token, expiresAt, user } = authService.login({
      ...req.body,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    setSessionCookie(res, token, expiresAt, { secure: isSecure(req) });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  authService.logout(req.sessionToken);
  clearSessionCookie(res, { secure: isSecure(req) });
  res.json({ ok: true });
});

/** ログイン状態の確認。画面側がログイン中の表示に使う */
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, validateRequest(changePasswordSchema), (req, res, next) => {
  try {
    authService.changePassword(req.user.id, req.body);
    // パスワード変更で自分のセッションも失効するため、Cookieを消して再ログインさせる
    clearSessionCookie(res, { secure: isSecure(req) });
    res.json({ ok: true, message: 'パスワードを変更しました。もう一度ログインしてください。' });
  } catch (err) {
    next(err);
  }
});

// 利用者の管理は管理者のみ
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  res.json(authService.listUsers());
});

router.post('/users', requireAuth, requireAdmin, validateRequest(createUserSchema), (req, res, next) => {
  try {
    res.status(201).json(authService.createUser(req.body));
  } catch (err) {
    next(err);
  }
});

// --- 2要素認証 ---

// 設定を始める（秘密鍵とQR用URIを返す。この時点ではまだ有効にならない）
router.post('/totp/setup', requireAuth, (req, res, next) => {
  try {
    res.json(authService.beginTotpSetup(req.user.id));
  } catch (err) {
    next(err);
  }
});

// 認証アプリのコードを確認して有効化する（リカバリコードはここでだけ平文で返る）
router.post(
  '/totp/confirm',
  requireAuth,
  validateRequest(z.object({ code: z.string().min(6) })),
  (req, res, next) => {
    try {
      res.json(authService.confirmTotpSetup(req.user.id, req.body.code));
    } catch (err) {
      next(err);
    }
  }
);

// 解除（パスワードの再入力が必要）
router.post(
  '/totp/disable',
  requireAuth,
  validateRequest(z.object({ password: z.string().min(1) })),
  (req, res, next) => {
    try {
      authService.disableTotp(req.user.id, req.body.password);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// --- 操作ログ（管理者のみ） ---
router.get('/operation-logs', requireAuth, requireAdmin, (req, res) => {
  res.json(
    operationLogService.list({
      from: req.query.from,
      to: req.query.to,
      userId: req.query.userId ? Number(req.query.userId) : undefined,
      action: req.query.action,
      targetType: req.query.targetType,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    })
  );
});

module.exports = router;
