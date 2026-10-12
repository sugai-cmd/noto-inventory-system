#!/usr/bin/env node
// カナカンの発注書FAX（PDF）を読み取って受注に登録する。
//
//   node scripts/import-fax-order.js <PDF> [<PDF> ...]            登録する
//   node scripts/import-fax-order.js --dry-run <PDF> [<PDF> ...]  登録せず、何が入るかだけ見る
//
// 準備と使い方は docs/FAX-ORDER-IMPORT.md。
// 終了コード: 0=全件 登録/登録済み/カナカン以外, 1=要確認あり, 2=実行できない

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('使い方: node scripts/import-fax-order.js [--dry-run] <PDF> [<PDF> ...]');
    process.exit(2);
  }

  const { checkOcrTools } = require('../src/services/faxOrder/ocr');
  const problems = await checkOcrTools();
  if (problems.length) {
    console.error('OCRの準備ができていません:\n  - ' + problems.join('\n  - '));
    process.exit(2);
  }

  const { migrate } = require('../src/db/migrate');
  migrate();
  const { importFromPdf } = require('../src/services/faxOrderImportService');
  const path = require('node:path');

  let needsReview = 0;
  for (const file of files) {
    const name = path.basename(file);
    let result;
    try {
      result = await importFromPdf(file, { dryRun, sourceName: name });
    } catch (err) {
      needsReview++;
      console.log(`✖ ${name}: 読み取りに失敗しました（${err.message}）`);
      continue;
    }
    print(name, result);
    if (result.status === 'needs_review') needsReview++;
  }
  process.exit(needsReview ? 1 : 0);
}

function print(name, r) {
  const p = r.parsed;
  const summary = p.orderNumber
    ? `発注番号 ${p.orderNumber} / 入庫日 ${p.deliveryOn ?? '?'} / ${p.warehouse ?? '?'} / ` +
      `JAN ${p.jan ?? '?'} / ${p.cases ?? '?'}C×${p.perCase ?? '?'}本`
    : '';
  switch (r.status) {
    case 'registered':
      console.log(`✔ ${name}: 受注 ${r.order.order_no} を登録（${r.plan.customerName} / ` +
        `${r.plan.productName} ${r.plan.quantity}本 / 納品希望日 ${r.plan.requestedDeliveryOn}）`);
      break;
    case 'dry_run':
      console.log(`○ ${name}: 登録予定（--dry-run）`);
      console.log(`    得意先 ${r.plan.customerName} / 商品 ${r.plan.productName} / ` +
        `${r.plan.quantity}本 / 受注日 ${r.plan.orderedOn} / 納品希望日 ${r.plan.requestedDeliveryOn}`);
      console.log(`    note: ${r.plan.note.replace(/\n/g, ' | ')}`);
      break;
    case 'duplicate':
      console.log(`- ${name}: スキップ（${r.reasons.join(' / ')}）`);
      break;
    case 'not_kanakan':
      console.log(`- ${name}: カナカンの発注書ではないためスキップ`);
      break;
    case 'needs_review':
      console.log(`⚠ ${name}: 要確認（登録していません） ${summary}`);
      for (const reason of r.reasons) console.log(`    - ${reason}`);
      for (const [k, v] of Object.entries(r.candidates ?? {})) {
        console.log(`    候補（${k === 'customer' ? '得意先' : '商品'}）: ${v.join(' / ')}`);
      }
      break;
  }
  for (const w of r.warnings ?? []) console.log(`    注意: ${w}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
