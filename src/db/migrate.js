const fs = require('node:fs');
const path = require('node:path');
const { getConnection } = require('./connection');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');

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
    const runMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });

    runMigration();
    console.log(`[migrate] applied: ${file}`);
  }

  console.log('[migrate] up to date');
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };
