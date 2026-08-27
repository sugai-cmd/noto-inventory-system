// マスタ系テーブルの `uid` カラム用：8桁ランダム小文字英数字キーの生成
// （DB_SCHEMA_DESIGN.md 1章「uidカラムについて」参照）

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LENGTH = 8;
const MAX_ATTEMPTS = 10;

function randomUid() {
  let out = '';
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/**
 * 指定テーブルのuid列に対して衝突しない値を生成する。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table - uid列を持つテーブル名
 * @returns {string}
 */
function generateUid(db, table) {
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE uid = ?`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = randomUid();
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error(`uidの生成に${MAX_ATTEMPTS}回失敗しました（table=${table}）`);
}

module.exports = { generateUid, randomUid };
