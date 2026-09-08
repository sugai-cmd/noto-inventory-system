#!/usr/bin/env node
// db/schema.sql を、migrations を当てた結果から書き出す。
//
// schema.sql は適用されない（適用は src/db/migrate.js の役割）ドキュメントだが、
// 一番それらしく見えるので、実装や調査のときに最初に読まれる。
// これが古いと、**間違った式を読んで間違った結論を出す**。
//
// 実際に起きた: v_product_stock の仕掛品の式に 0013 で「未納税移出」が
// 足されていたのに schema.sql は 0001 のままで、在庫の差の原因を読み違えた。
// 67個中39個がずれていた。
//
// 使い方:
//   node scripts/dump-schema.js          # db/schema.sql を更新する
//   node scripts/dump-schema.js --check  # ずれていたら終了コード1（試験が使う）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');

const HEADER = `-- このファイルは自動生成です。手で編集しないでください。
--
-- db/migrations/*.sql を順に当てた結果を書き出したものです。
-- 更新するには:  node scripts/dump-schema.js
--
-- 適用されるのは migrations のほうです（src/db/migrate.js）。
-- ここは「いまのスキーマ」を1か所で読むためのものです。
`;

/** migrations を当てた一時DBから、DDLを並べ直して返す */
function buildSchema() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
  const dbPath = path.join(dir, 'schema.sqlite');
  try {
    // DB_PATH は設定の読み込み時に確定するので、別プロセスで当てる。
    // 同じプロセスで require のキャッシュを消して回すより確実
    const r = spawnSync('node', ['-e', 'require("./src/db/migrate").migrate()'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`migrations を当てられませんでした:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    }

    const db = require('better-sqlite3')(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`
      )
      .all();
    db.close();

    const sections = { table: '-- テーブル', index: '-- 索引', view: '-- ビュー', trigger: '-- トリガ' };
    const out = [HEADER];
    let current = null;
    for (const row of rows) {
      if (row.type !== current) {
        current = row.type;
        out.push(`\n${'-'.repeat(70)}\n${sections[current] ?? `-- ${current}`}\n${'-'.repeat(70)}`);
      }
      out.push(`\n${row.sql.trim()};\n`);
    }
    return out.join('');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const check = process.argv.includes('--check');
  const built = buildSchema();
  const current = fs.existsSync(SCHEMA_PATH) ? fs.readFileSync(SCHEMA_PATH, 'utf8') : '';

  if (built === current) {
    console.log('db/schema.sql は migrations と一致しています');
    return;
  }
  if (check) {
    console.error('db/schema.sql が migrations とずれています。');
    console.error('  node scripts/dump-schema.js を実行して更新してください。');
    process.exit(1);
  }
  fs.writeFileSync(SCHEMA_PATH, built, 'utf8');
  console.log(`db/schema.sql を更新しました（${SCHEMA_PATH}）`);
}

if (require.main === module) main();

module.exports = { buildSchema, SCHEMA_PATH };
