const fs = require('node:fs');
const https = require('node:https');
const config = require('./config');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');
const authService = require('./services/authService');

// 起動時にマイグレーションを適用してからサーバーを立ち上げる
migrate();

// 期限切れセッションを掃除する
const purged = authService.purgeExpiredSessions();
if (purged) console.log(`[auth] 期限切れセッションを${purged}件削除しました`);

// ユーザーが1人もいないと誰もログインできないので、起動時に気づけるようにする
if (authService.countUsers() === 0) {
  console.warn(
    '\n[!] ログインユーザーが登録されていません。\n' +
    '    次のコマンドで最初の管理者を作成してください:\n' +
    '        npm run create-user\n'
  );
}

const app = createApp();

if (config.tls) {
  // HTTPS。証明書のパスが設定されているときだけ有効になる
  https
    .createServer(
      { key: fs.readFileSync(config.tls.keyPath), cert: fs.readFileSync(config.tls.certPath) },
      app
    )
    .listen(config.port, config.host, () => {
      console.log(`NOTO inventory server (HTTPS) listening on https://${displayHost()}:${config.port}`);
    });
} else {
  app.listen(config.port, config.host, () => {
    console.log(`NOTO inventory server listening on http://${displayHost()}:${config.port}`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.log(
        '  ※ 他の端末からも接続できる状態です。社外から使う場合はTLSまたはVPN経由にしてください。'
      );
    }
  });
}

function displayHost() {
  return config.host === '0.0.0.0' ? 'localhost' : config.host;
}
