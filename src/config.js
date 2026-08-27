const path = require('node:path');

/**
 * TLS_KEY_PATH と TLS_CERT_PATH の両方が設定されていればHTTPSで起動する。
 * 片方だけの指定は設定漏れとみなして起動時に落とす（平文で気づかず動くのを防ぐ）。
 */
function resolveTls() {
  const keyPath = process.env.TLS_KEY_PATH;
  const certPath = process.env.TLS_CERT_PATH;

  if (!keyPath && !certPath) return null;
  if (!keyPath || !certPath) {
    throw new Error(
      'TLS_KEY_PATH と TLS_CERT_PATH は両方セットで指定してください（片方だけでは起動できません）'
    );
  }
  return {
    keyPath: path.resolve(process.cwd(), keyPath),
    certPath: path.resolve(process.cwd(), certPath),
  };
}

const config = {
  port: Number(process.env.PORT) || 3000,
  // 既定は全インターフェースで待ち受ける（他の端末から使うため）。
  // その端末だけで使うなら HOST=127.0.0.1 にする。
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.resolve(__dirname, '..', 'db', 'database.sqlite'),
  tls: resolveTls(),
};

module.exports = config;
