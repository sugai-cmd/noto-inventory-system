#!/usr/bin/env node
// 経営数値シート（上司向け・閲覧専用）をGoogleスプレッドシートへ送る。
//
//   node scripts/export-management-sheet.js              # 集計して送る
//   node scripts/export-management-sheet.js --dry-run    # 送らずに中身を表示するだけ
//   node scripts/export-management-sheet.js --date 2026-10-26
//
// 送り先はスプレッドシートに置いたApps Script（gas/management-sheet/Code.gs）。
// .env の MANAGEMENT_WEBHOOK_URL と MANAGEMENT_WEBHOOK_SECRET を使う。手順は docs/MANAGEMENT-SHEET.md。
//
// DBは読むだけ。週次報告と違い、得意先の住所・連絡先も送る（得意先マスタのシート）。
// そのため送り先のスプレッドシートは、上司だけに閲覧者として共有する。

const path = require('node:path');
const { send, parseArgs, loadDotEnv } = require('./export-weekly-report');

async function main() {
  loadDotEnv(path.resolve(__dirname, '..', '.env'));
  const args = parseArgs(process.argv.slice(2));

  // config.js が読込時に DB_PATH を見るので、.env を読んでから require する
  const { buildManagementSheets } = require('../src/services/managementSheetService');
  const report = buildManagementSheets({ asOf: args.date });

  if (args.dryRun) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const url = process.env.MANAGEMENT_WEBHOOK_URL;
  const secret = process.env.MANAGEMENT_WEBHOOK_SECRET;
  if (!url || !secret) {
    throw new Error('.env に MANAGEMENT_WEBHOOK_URL と MANAGEMENT_WEBHOOK_SECRET を設定してください（docs/MANAGEMENT-SHEET.md）');
  }

  const result = await send(report, { url, secret });
  console.log(
    `${new Date().toISOString()} 経営数値シートを送りました（集計日 ${report.asOf}、${report.sheets.length}シート）: ${result.message ?? ''}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${new Date().toISOString()} 経営数値シートの送信に失敗しました: ${err.message}`);
    process.exit(1);
  });
}
