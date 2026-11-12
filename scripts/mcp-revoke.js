#!/usr/bin/env node
//
// 音声入力のコネクタ（MCP）に渡したログインを取り消すCLI。
// スマホを落とした・claude.ai のアカウントを手放すなど、接続を止めたいときに使う。
//
//   node scripts/mcp-revoke.js          # 有効な接続の一覧だけ出す（何も変えない）
//   node scripts/mcp-revoke.js --all    # すべての接続を取り消す
//
// 取り消したあとは、claude.ai のコネクタ設定でもう一度「接続」すればログインし直せる。

const { getConnection } = require('../src/db/connection');

function main() {
  const db = getConnection();
  const active = db
    .prepare(
      `SELECT t.kind, t.client_id, t.expires_at, t.created_at, u.username
         FROM oauth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.revoked_at IS NULL AND t.expires_at > ?
        ORDER BY t.created_at`
    )
    .all(new Date().toISOString());

  console.log(`有効な接続のトークン: ${active.length}件`);
  for (const row of active) {
    console.log(`  ${row.created_at}  ${row.username}  ${row.kind}  期限 ${row.expires_at}  (client ${row.client_id})`);
  }

  if (!process.argv.includes('--all')) {
    if (active.length) console.log('\nすべて取り消すときは --all を付けて実行してください。');
    return;
  }

  const changed = db
    .prepare("UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE revoked_at IS NULL")
    .run().changes;
  console.log(`\n${changed}件を取り消しました。claude.ai からの登録は、ログインし直すまでできません。`);
}

main();
