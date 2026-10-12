#!/usr/bin/env node
// 未出荷のカナカン・COREZOの受注を、Webゆうパックプリント（送り状）と
// マネーフォワード（納品書）に登録する。印刷・送付はしない。手順は docs/SHIP-DOCS-UPLOAD.md。
//
//   node scripts/ship-docs.js                 # 登録する（毎朝8時にlaunchdから）
//   node scripts/ship-docs.js --dry-run       # CSVを作るだけ。対象と中身を確認する
//   node scripts/ship-docs.js --headed        # Chromeの画面を出して動かす（初回の確認・調整）
//   node scripts/ship-docs.js --only yupack   # 片方だけ（yupack / moneyforward）
//   node scripts/ship-docs.js --manual        # 手動実行として通知する（受注画面のボタンが付ける）
//   node scripts/ship-docs.js --login         # 専用のChromeを開いて、両方のサイトに手でログインする（最初に1回）

const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/**
 * 自動操作で使う専用のChromeを開き、人が手でログインする。
 * ログイン状態は専用プロファイル（.browser-profile/）に残るので、以後の自動実行はログイン済みで始まる。
 * アカウント選択・二段階認証・利用規約の同意など、初回だけ出る画面をここで済ませておく。
 */
async function loginMode(root) {
  const readline = require('node:readline');
  const { openBrowser } = require('../src/services/shipDocs/browser');
  const context = await openBrowser({ profileDir: path.join(root, '.browser-profile'), headed: true });
  const yupack = context.pages()[0] ?? (await context.newPage());
  await yupack.goto(process.env.WEBYUPACK_URL || 'https://www.post.japanpost.jp/web-yu-packprint/');
  const mf = await context.newPage();
  await mf.goto('https://invoice.moneyforward.com/');

  console.log('\nChromeが開きました。2つのタブで、それぞれ手でログインしてください。');
  console.log('  1. Webゆうパックプリント … ゆうIDでログインし、メインメニューが出るところまで');
  console.log('  2. マネーフォワード      … アカウントを選び、請求書の画面が出るところまで（二段階認証もここで）');
  console.log('終わったら、このターミナルで Enter を押してください（Chromeが閉じます）。\n');
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
  await context.close();
  console.log('ログイン状態を保存しました。次は npm run ship-docs -- --headed で確認してください。');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  loadDotEnv(path.join(root, '.env'));
  const args = process.argv.slice(2);
  if (args.includes('--login')) return loginMode(root);
  const dryRun = args.includes('--dry-run');
  const headed = args.includes('--headed');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? [args[onlyIdx + 1]] : undefined;
  const trigger = args.includes('--manual') ? '手動' : '自動';

  const { migrate } = require('../src/db/migrate');
  migrate();
  const { runShipDocs, buildSlackText } = require('../src/services/shipDocs/runner');
  const { notifySlack } = require('../src/services/faxOrder/slackNotify');

  const summary = await runShipDocs({
    logsDir: path.join(root, 'logs', 'ship-docs'),
    dryRun,
    headed,
    ...(only ? { only } : {}),
  });

  const stamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  if (summary.skipped) {
    console.log(`[${stamp}] スキップ: ${summary.reason}`);
    return;
  }
  console.log(`[${stamp}] 対象の得意先: ${summary.customers.map((c) => c.name).join(' / ') || '（なし）'}`);
  for (const r of summary.results) {
    const files = r.file ? ` CSV: ${path.relative(root, r.file)}` : '';
    console.log(`  ${r.label}: ${r.status} ${r.orderNos.join(', ')}${files}${r.error ? ` — ${r.error}` : ''}`);
    for (const p of r.problems) console.log(`    要確認 ${p.orderNo}: ${p.reason}`);
  }

  const text = buildSlackText(summary, { trigger });
  if (dryRun) {
    if (text) console.log('\n--- Slackに送る文面 ---\n' + text);
    return;
  }
  await notifySlack(text).catch((err) => console.error(`  Slack通知に失敗: ${err.message}`));
  if (summary.results.some((r) => r.status === 'failed')) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  if (!process.argv.includes('--dry-run')) {
    const { notifySlack } = require('../src/services/faxOrder/slackNotify');
    await notifySlack(`*送り状・納品書の登録* :x: 実行に失敗しました\n${err.message}`).catch(() => {});
  }
  process.exit(1);
});
