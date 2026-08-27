const express = require('express');
const { z } = require('zod');
const authService = require('../services/authService');
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

module.exports = router;
