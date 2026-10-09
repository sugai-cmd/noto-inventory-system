const fs = require('node:fs');
const path = require('node:path');
const { getConnection } = require('./connection');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');

// このコメントで始まるマイグレーションは、ランナー側でトランザクションに包まない。
const NO_TRANSACTION_MARKER = '-- migrate:no-transaction';

/**
 * db/migrations/*.sql をファイル名の昇順に適用する軽量マイグレーションランナー。
 * 適用済みのファイル名は schema_migrations テーブルに記録し、二重適用を防ぐ。
 */
function migrate() {
  const db = getConnection();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    if (sql.startsWith(NO_TRANSACTION_MARKER)) {
      // テーブル再作成のように外部キーを一時的に切る必要があるものは、
      // ファイル側でBEGIN/COMMITとPRAGMAを面倒みる（PRAGMAはトランザクション内では効かない）。
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    } else {
      const runMigration = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
      });
      runMigration();
    }

    console.log(`[migrate] applied: ${file}`);
  }

  console.log('[migrate] up to date');
  return { ok: true, failed: null };
}

/**
 * 落ちないマイグレーション。**サーバー起動用。**
 *
 * 移行SQLが1つ落ちただけでサーバーごと起動しなくなると、画面が一切出ないため
 * 利用者からは「急に全部繋がらない」としか見えない（実際に業務が止まった。
 * 0027 の報告番号の採番が既存番号と衝突した件。DB_SCHEMA_DESIGN.md 35章）。
 *
 * 失敗しても**サーバーは起動させる**。何が起きたかを画面と記録に残し、
 * 中途半端なスキーマのまま業務を進めさせないよう、更新系は止める
 * （止めるのは middlewares/readOnlyWhenMigrationFailed の仕事）。
 */
function migrateOrReport() {
  try {
    return migrate();
  } catch (err) {
    // どのファイルで落ちたかを必ず出す。ここが分からないと原因に辿り着けない
    const failed = failedFileName();
    console.error(
      `\n[migrate] 失敗しました: ${failed ?? '（ファイル不明）'}\n` +
        `          ${err.message}\n` +
        '          データは書き換わっていません（トランザクションで巻き戻ります）。\n' +
        '          サーバーは起動しますが、記録の追加・変更はできません。\n'
    );
    return { ok: false, failed, message: err.message };
  }
}

/** 適用済みの次に来るファイル＝落ちたファイル */
function failedFileName() {
  try {
    const db = getConnection();
    const applied = new Set(
      db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
    );
    return (
      fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .find((f) => !applied.has(f)) ?? null
    );
  } catch {
    return null;
  }
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate, migrateOrReport };
