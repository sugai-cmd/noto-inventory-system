#!/usr/bin/env node
// 共有ドライブのFAXフォルダを確認し、カナカンの発注書を受注に登録して、PDFを仕分ける。
// launchdで定期的に動かす（docs/FAX-AUTO-IMPORT.md）。
//
//   node scripts/fax-inbox.js             # 取込・仕分け・Slack通知
//   node scripts/fax-inbox.js --dry-run   # 登録・移動・削除・通知をせず、結果だけ表示
//
// .env
//   FAX_INBOX_DIR    同期されたFAXフォルダの場所（必須）
//   SLACK_BOT_TOKEN / SLACK_CHANNEL  または  SLACK_WEBHOOK_URL（通知。無ければ通知しない）
//   TESSERACT_BIN / PDFTOPPM_BIN     launchdからコマンドが見つからない場合だけ

const fs = require('node:fs');
const path = require('node:path');

/** .env を読む（scripts/export-weekly-report.js と同じ最小限の読み込み） */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function stamp() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function main() {
  const root = path.resolve(__dirname, '..');
  loadDotEnv(path.join(root, '.env'));
  const dryRun = process.argv.includes('--dry-run');

  const inboxDir = process.env.FAX_INBOX_DIR;
  if (!inboxDir) throw new Error('.env に FAX_INBOX_DIR（同期されたFAXフォルダの場所）を設定してください');

  const { notifySlack } = require('../src/services/faxOrder/slackNotify');
  const { checkOcrTools } = require('../src/services/faxOrder/ocr');
  const problems = await checkOcrTools();
  if (problems.length) {
    const text = `*FAX発注書の自動取込* :x: OCRの準備ができていません\n- ${problems.join('\n- ')}`;
    if (!dryRun) await notifySlack(text).catch(() => {});
    throw new Error(problems.join(' / '));
  }

  const { migrate } = require('../src/db/migrate');
  migrate();
  const config = require('../src/config');
  const { importFromPdf } = require('../src/services/faxOrderImportService');
  const { processInbox, buildSlackText } = require('../src/services/faxOrder/faxInbox');

  const summary = await processInbox({
    inboxDir,
    stateDir: path.dirname(config.dbPath),
    importFn: importFromPdf,
    dryRun,
  });

  console.log(`[${stamp()}] FAX ${summary.items.length}件を確認${dryRun ? '（--dry-run）' : ''}`);
  for (const it of summary.items) {
    console.log(`  ${it.status.padEnd(12)} ${it.name} → ${path.relative(inboxDir, it.movedTo)}`);
  }
  for (const name of summary.deleted) console.log(`  deleted      不要/${name}`);

  const text = buildSlackText(summary);
  if (dryRun) {
    if (text) console.log('\n--- Slackに送る文面 ---\n' + text);
    return;
  }
  const sent = await notifySlack(text);
  if (sent.reason === 'not_configured' && text) console.log('  （Slackが未設定のため通知していません）');
}

main().catch(async (err) => {
  console.error(`[${stamp()}] 失敗: ${err.message}`);
  // 止まったことに気づけるよう、失敗もSlackで知らせる（OCR未準備はmain内で通知済み）
  if (!process.argv.includes('--dry-run') && !/OCR|tesseract|pdftoppm/i.test(err.message)) {
    const { notifySlack } = require('../src/services/faxOrder/slackNotify');
    await notifySlack(`*FAX発注書の自動取込* :x: 実行に失敗しました\n${err.message}`).catch(() => {});
  }
  process.exit(1);
});
