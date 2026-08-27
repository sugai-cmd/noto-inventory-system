const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('../config');

let db;

/**
 * DB接続を初期化する。初回はDBファイルを作成し、PRAGMAを設定する。
 * schema.sql自体はここでは適用しない（適用はsrc/db/migrate.jsの役割）。
 */
function getConnection() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);

  // 外部キー制約を有効化（SQLiteはデフォルトOFFのため必須）
  db.pragma('foreign_keys = ON');
  // ローカルサーバー用途での書き込み耐性・同時読み取り性向上
  db.pragma('journal_mode = WAL');

  return db;
}

module.exports = { getConnection };
