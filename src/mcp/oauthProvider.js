// コネクタ（claude.ai のカスタムコネクタ）のログイン。OAuth 2.1 の認可サーバー。
//
// 流れ：claude.ai がクライアント登録 → 利用者のブラウザで /authorize（ここでID・パスワード・
// 2要素のコードを入れる）→ 認可コード → /token でトークンを受け取り、/mcp に付けて呼ぶ。
//
// 決めごと：
//   ・登録できるリダイレクト先は claude.ai のコールバックだけ（他のサイトにトークンを渡さない）
//   ・ログインは画面と同じ照合（authService.verifyCredentials。ロックアウトも共通）
//   ・**2要素認証を有効にしていない利用者は通さない**（インターネットに出る入口のため）
//   ・トークン・認可コードはハッシュだけを保存する

const crypto = require('node:crypto');
const { getConnection } = require('../db/connection');
const authService = require('../services/authService');
const {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  InvalidTargetError,
} = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { renderLoginPage } = require('./loginPage');

const ACCESS_TOKEN_SECONDS = 60 * 60;            // 1時間
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60; // 30日（使うたびに新しくなる）
const CODE_SECONDS = 5 * 60;
const PENDING_SECONDS = 10 * 60;

const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

const TOTP_REQUIRED_MESSAGE =
  'このアカウントは2要素認証が有効になっていません。受注管理システムの設定画面で2要素認証を有効にしてから、もう一度接続してください。';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isoAfter(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isExpired(iso) {
  return new Date(iso) <= new Date();
}

/** 有効で、2要素認証を有効にしている利用者だけを返す */
function activeUserWithTotp(db, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!user || !user.totp_enabled) return null;
  return user;
}

/**
 * @param {object} opts
 * @param {URL} opts.resourceUrl - この MCP サーバーの URL（…/mcp）。トークンはここ宛てにだけ出す
 * @param {string[]} [opts.allowedRedirectUris]
 */
function createOAuthProvider({ resourceUrl, allowedRedirectUris = DEFAULT_REDIRECT_URIS }) {
  const allowed = new Set(allowedRedirectUris);

  const clientsStore = {
    getClient(clientId) {
      const row = getConnection().prepare('SELECT client_json FROM oauth_clients WHERE client_id = ?').get(clientId);
      return row ? JSON.parse(row.client_json) : undefined;
    },
    registerClient(client) {
      const uris = client.redirect_uris ?? [];
      const bad = uris.filter((u) => !allowed.has(String(u)));
      if (!uris.length || bad.length) {
        throw new InvalidClientMetadataError(`このリダイレクト先は登録できません: ${bad.join(', ') || '(なし)'}`);
      }
      getConnection()
        .prepare('INSERT INTO oauth_clients (client_id, client_json) VALUES (?, ?)')
        .run(client.client_id, JSON.stringify(client));
      return client;
    },
  };

  function assertResource(resource) {
    if (resource && resource.href.replace(/\/$/, '') !== resourceUrl.href.replace(/\/$/, '')) {
      throw new InvalidTargetError(`このサーバーが発行できるのは ${resourceUrl.href} 宛てのトークンだけです`);
    }
  }

  function issueTokens(db, { clientId, userId, scopes, resource }) {
    const access = randomToken();
    const refresh = randomToken();
    const insert = db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(sha256(access), 'access', clientId, userId, scopes ?? null, resource ?? null, isoAfter(ACCESS_TOKEN_SECONDS));
    insert.run(sha256(refresh), 'refresh', clientId, userId, scopes ?? null, resource ?? null, isoAfter(REFRESH_TOKEN_SECONDS));
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      ...(scopes ? { scope: scopes } : {}),
    };
  }

  return {
    clientsStore,

    /** ログイン画面を出す。ID・パスワードは completeLogin で受け取る */
    async authorize(client, params, res) {
      assertResource(params.resource);
      const id = randomToken();
      getConnection()
        .prepare(
          `INSERT INTO oauth_pending_authorizations
             (id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          client.client_id,
          params.redirectUri,
          params.codeChallenge,
          params.state ?? null,
          params.scopes?.length ? params.scopes.join(' ') : null,
          params.resource?.href ?? null,
          isoAfter(PENDING_SECONDS)
        );
      res.status(200).type('html').send(renderLoginPage({ pendingId: id, clientName: client.client_name }));
    },

    async challengeForAuthorizationCode(client, code) {
      const row = getConnection().prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(code));
      if (!row || row.client_id !== client.client_id || row.used_at || isExpired(row.expires_at)) {
        throw new InvalidGrantError('認可コードが無効です');
      }
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
      const db = getConnection();
      return db.transaction(() => {
        const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(code));
        if (!row || row.client_id !== client.client_id || row.used_at || isExpired(row.expires_at)) {
          throw new InvalidGrantError('認可コードが無効です');
        }
        if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri が一致しません');
        if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource が一致しません');
        db.prepare("UPDATE oauth_codes SET used_at = datetime('now') WHERE code_hash = ?").run(row.code_hash);
        if (!activeUserWithTotp(db, row.user_id)) throw new InvalidGrantError(TOTP_REQUIRED_MESSAGE);
        return issueTokens(db, { clientId: client.client_id, userId: row.user_id, scopes: row.scopes, resource: row.resource });
      })();
    },

    /** リフレッシュトークンは1回使ったら失効させ、新しい組を出す（盗まれても使い回せない） */
    async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
      const db = getConnection();
      return db.transaction(() => {
        const row = db
          .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
          .get(sha256(refreshToken));
        if (!row || row.client_id !== client.client_id || row.revoked_at || isExpired(row.expires_at)) {
          throw new InvalidGrantError('リフレッシュトークンが無効です');
        }
        if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource が一致しません');
        db.prepare("UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE id = ?").run(row.id);
        if (!activeUserWithTotp(db, row.user_id)) throw new InvalidGrantError(TOTP_REQUIRED_MESSAGE);
        return issueTokens(db, { clientId: client.client_id, userId: row.user_id, scopes: row.scopes, resource: row.resource });
      })();
    },

    async verifyAccessToken(token) {
      const db = getConnection();
      const row = db
        .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
        .get(sha256(token));
      // この文は WWW-Authenticate ヘッダに入る。ヘッダには日本語を入れられないので英語にする
      if (!row || row.revoked_at || isExpired(row.expires_at)) throw new InvalidTokenError('Token is invalid or expired');
      if (!activeUserWithTotp(db, row.user_id)) throw new InvalidTokenError('User is inactive or two-factor authentication is disabled');
      return {
        token,
        clientId: row.client_id,
        scopes: row.scopes ? row.scopes.split(' ') : [],
        expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
        extra: { userId: row.user_id },
      };
    },

    async revokeToken(client, request) {
      getConnection()
        .prepare("UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL")
        .run(sha256(request.token), client.client_id);
    },

    /**
     * ログイン画面から送られてきたID・パスワードを確かめ、認可コードを付けて claude.ai へ戻す。
     * 失敗したら同じ画面に理由を出す。
     */
    completeLogin(req, res) {
      const db = getConnection();
      const { pendingId, username, password, totpCode } = req.body ?? {};
      const pending = pendingId
        ? db.prepare('SELECT * FROM oauth_pending_authorizations WHERE id = ?').get(String(pendingId))
        : null;
      if (!pending || isExpired(pending.expires_at)) {
        res.status(400).type('html').send(
          renderLoginPage({ error: 'ログインの受付が期限切れです。claude.ai からもう一度接続し直してください。' })
        );
        return;
      }
      const client = clientsStore.getClient(pending.client_id);
      const again = (error) =>
        res.status(401).type('html').send(
          renderLoginPage({ pendingId: pending.id, clientName: client?.client_name, username, error })
        );

      let user;
      try {
        user = authService.verifyCredentials({
          username,
          password,
          totpCode: totpCode ? String(totpCode).trim() : undefined,
          ipAddress: req.ip,
        });
      } catch (err) {
        if (err.status && err.status < 500) return again(err.message);
        throw err;
      }
      if (!user.totp_enabled) return again(TOTP_REQUIRED_MESSAGE);

      const code = randomToken();
      db.transaction(() => {
        db.prepare('DELETE FROM oauth_pending_authorizations WHERE id = ?').run(pending.id);
        db.prepare(
          `INSERT INTO oauth_codes
             (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          sha256(code),
          pending.client_id,
          user.id,
          pending.redirect_uri,
          pending.code_challenge,
          pending.scopes,
          pending.resource,
          isoAfter(CODE_SECONDS)
        );
      })();

      const target = new URL(pending.redirect_uri);
      target.searchParams.set('code', code);
      if (pending.state) target.searchParams.set('state', pending.state);
      res.redirect(302, target.href);
    },
  };
}

/** トークンから利用者を引く（/mcp の各リクエストで使う） */
function userForAuth(auth) {
  const userId = auth?.extra?.userId;
  if (!userId) return null;
  const row = getConnection().prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
  return row ? authService.toPublicUser(row) : null;
}

/** 期限切れのログイン途中・認可コード・トークンを掃除する（起動時） */
function purgeExpiredOAuthRows() {
  const db = getConnection();
  const now = new Date().toISOString();
  let n = 0;
  n += db.prepare('DELETE FROM oauth_pending_authorizations WHERE expires_at <= ?').run(now).changes;
  n += db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now).changes;
  n += db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now).changes;
  return n;
}

module.exports = {
  createOAuthProvider,
  userForAuth,
  purgeExpiredOAuthRows,
  DEFAULT_REDIRECT_URIS,
  TOTP_REQUIRED_MESSAGE,
};
