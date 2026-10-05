#!/usr/bin/env node
// 週次報告の集計をGoogleスプレッドシートへ送る。
//
//   node scripts/export-weekly-report.js              # 集計して送る
//   node scripts/export-weekly-report.js --dry-run    # 送らずに中身を表示するだけ
//   node scripts/export-weekly-report.js --date 2026-10-05
//
// 送り先はスプレッドシートに置いたApps Script（gas/weekly-report/Code.gs）。
// .env の REPORT_WEBHOOK_URL と REPORT_WEBHOOK_SECRET を使う。手順は docs/WEEKLY-REPORT.md。
//
// DBは読むだけ。送るのは集計した数字だけで、得意先の住所や連絡先は送らない。

const path = require('node:path');
const fs = require('node:fs');

/** .env を読む（依存を増やさないための最小限の読み込み。既にある環境変数は上書きしない） */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, date: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--date') args.date = argv[++i];
    else throw new Error(`知らないオプションです: ${argv[i]}`);
  }
  return args;
}

async function send(report, { url, secret }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, report }),
    redirect: 'follow', // Apps Scriptは応答を別のURLへ転送して返す
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`送り先の応答が読めませんでした (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !body.ok) {
    throw new Error(`送り先がエラーを返しました: ${body.error ?? `HTTP ${res.status}`}`);
  }
  return body;
}

async function main() {
  loadDotEnv(path.resolve(__dirname, '..', '.env'));
  const args = parseArgs(process.argv.slice(2));

  // config.js が読込時に DB_PATH を見るので、.env を読んでから require する
  const { buildReport } = require('../src/services/weeklyReportService');
  const report = buildReport({ asOf: args.date });

  if (args.dryRun) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const url = process.env.REPORT_WEBHOOK_URL;
  const secret = process.env.REPORT_WEBHOOK_SECRET;
  if (!url || !secret) {
    throw new Error('.env に REPORT_WEBHOOK_URL と REPORT_WEBHOOK_SECRET を設定してください（docs/WEEKLY-REPORT.md）');
  }

  const result = await send(report, { url, secret });
  console.log(
    `${new Date().toISOString()} 週次報告を送りました（集計日 ${report.asOf}、当月売上 ${report.current.ordered.salesExclTax.toLocaleString('ja-JP')}円）: ${result.message ?? ''}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${new Date().toISOString()} 週次報告の送信に失敗しました: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { send, parseArgs, loadDotEnv };
