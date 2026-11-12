// 音声入力のコネクタ（MCP）用の、インターネットに出す小さなアプリ。
//
// **サイト本体とは別のポートで待ち受け、ここに載せるものだけを公開する。**
// Tailscale Funnel でこのポートだけを公開し、画面・/api はこれまでどおり tailnet の中に置く。
// 載せるのは次だけ：
//   /mcp                                     … ツール（Bearerトークン必須）
//   /authorize /token /register /revoke      … OAuth（claude.ai がログインに使う）
//   /oauth/login                             … ログイン画面の送信先
//   /.well-known/oauth-*                     … 上の場所の案内
// それ以外は 404。

const express = require('express');
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createOAuthProvider, userForAuth } = require('./oauthProvider');
const { buildMcpServer } = require('./mcpServer');

/**
 * @param {object} opts
 * @param {string} opts.publicUrl - 外から見たこのアプリのURL（例 https://xxx.ts.net:8443）
 * @param {string[]} [opts.allowedRedirectUris]
 * @param {boolean} [opts.rateLimit] - テストでは false にする
 */
function createMcpApp({ publicUrl, allowedRedirectUris, rateLimit = true }) {
  const issuerUrl = new URL(publicUrl);
  const resourceUrl = new URL('/mcp', issuerUrl);
  const provider = createOAuthProvider({ resourceUrl, allowedRedirectUris });

  const app = express();
  // Tailscale（同じMac上）を経由して届くので、送り元のIPは X-Forwarded-For を信じる。
  // ログインのロックアウト記録と、回数制限に使う
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  // ログイン画面を他のサイトの枠に埋め込ませない（ボタンを押させる詐欺の対策）
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });

  const limits = rateLimit ? {} : { rateLimit: false };
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: resourceUrl,
      resourceName: 'NOTO Naorai 蒸留記録',
      authorizationOptions: limits,
      tokenOptions: limits,
      revocationOptions: limits,
      // claude.ai に渡したクライアントの秘密は期限切れにしない（切れると黙って接続が切れる）
      clientRegistrationOptions: { ...limits, clientSecretExpirySeconds: 0 },
    })
  );

  app.post('/oauth/login', express.urlencoded({ extended: false, limit: '10kb' }), (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      provider.completeLogin(req, res);
    } catch (err) {
      next(err);
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const actor = userForAuth(req.auth);
    if (!actor) {
      res.status(401).json({ error: 'invalid_token', error_description: 'このアカウントでは使えません' });
      return;
    }
    const client = provider.clientsStore.getClient(req.auth.clientId);

    // セッションを持たない作り（リクエストごとに組み立てて捨てる）。登録者はトークンから決まる
    const server = buildMcpServer({ actor, clientName: client?.client_name });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] リクエストの処理に失敗しました:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // セッションを持たないので、GET（通知の受け口）と DELETE（セッション終了）は使わない
  app.all('/mcp', (req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[mcp] エラー:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createMcpApp };
