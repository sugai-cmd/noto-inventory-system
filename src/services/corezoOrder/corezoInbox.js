// 共有ドライブのCOREZOフォルダ（Macに同期されたもの）を見て、届いた注文メールを取り込む。
//
//   COREZO/         ← Apps Script（gas/corezo-saver）が新しいメール本文（.txt）を置く
//     取込済/       ← 受注に登録できた（または登録済みだった）注文メール
//                     名前は「注文日_注文番号.txt」に変える
//     要確認/       ← 登録できなかった注文メールと、COREZOからの連絡メール
//                     （配送先住所の変更など。**自動では直さない**）
//     未分類/       ← COREZOと関係のないメール
//     不要/         ← 置かれてから30日たったら削除する
//
// 仕分けそのもの（移動・掃除）は inbox/fileInbox.js が持つ。

const fileInbox = require('../inbox/fileInbox');

const { FOLDERS, TRASH_KEEP_DAYS, safeName } = fileInbox;

/** 取込済に置くときの名前（例: 20261019_141709.txt） */
function doneFileName(result, originalName) {
  const p = result.parsed ?? {};
  const date = (p.orderedOn ?? '').replace(/-/g, '') || '日付不明';
  if (!p.orderNumber) return originalName;
  return `${date}_${safeName(p.orderNumber)}.txt`;
}

/** COREZOフォルダを1回ぶん処理する（importFn は corezoOrderImportService.importFromFile） */
function processInbox(opts) {
  return fileInbox.processInbox({
    ...opts,
    fileFilter: /\.txt$/i,
    doneName: doneFileName,
    otherStatuses: ['not_corezo'],
    missingDirLabel: 'COREZOフォルダ',
    missingDirHint:
      'Googleドライブ（パソコン版）が起動しているか、.env の COREZO_INBOX_DIR を確認してください',
  });
}

/** Slackに送る文面。知らせることが無ければ null */
function buildSlackText({ items, deleted }) {
  const lines = [];
  for (const it of items) {
    const r = it.result;
    const p = r.parsed ?? {};
    if (it.status === 'registered' || it.status === 'dry_run') {
      const summary = r.plan.items.map((i) => `${i.productName} ${i.quantity}本`).join(' / ');
      // --dry-run のときは何が登録されるはずだったかを出す（受注番号はまだ無い）
      const head =
        it.status === 'registered'
          ? `:white_check_mark: 受注 ${r.order.order_no} を登録しました`
          : ':mag: 登録予定（--dry-run）';
      lines.push(
        `${head}（${r.plan.customerName} / ${summary} / お届け先 ${p.delivery?.name ?? '?'} / ` +
          `納品希望日 ${r.plan.requestedDeliveryOn ?? '指定なし'} / 注文番号 ${p.orderNumber}）`
      );
      for (const w of r.warnings ?? []) lines.push(`　　注意: ${w}`);
    } else if (it.status === 'notice') {
      lines.push(`:bell: ${r.reasons[0]}（自動では直していません）`);
      lines.push('　　→ COREZO/要確認 のメールを見て、受注画面から直してください');
    } else if (it.status === 'needs_review' || it.status === 'error') {
      lines.push(
        `:warning: 要確認（登録していません）: ${it.name}` +
          (p.orderNumber ? `（注文番号 ${p.orderNumber}）` : '')
      );
      for (const reason of r.reasons ?? []) lines.push(`　　- ${reason}`);
      for (const [k, v] of Object.entries(r.candidates ?? {})) {
        lines.push(`　　候補（${k === 'customer' ? '得意先' : '商品'}）: ${v.join(' / ')}`);
      }
      lines.push('　　→ COREZO/要確認 のメールを見て、受注画面から手で登録してください');
    } else if (it.status === 'not_corezo') {
      lines.push(`:page_facing_up: COREZO以外のメールを「未分類」に置きました: ${it.name}`);
    }
  }
  if (deleted.length) lines.push(`:wastebasket: 「不要」から30日たったメールを${deleted.length}件削除しました`);
  if (!lines.length) return null;
  return ['*COREZO注文メールの自動取込*', ...lines].join('\n');
}

module.exports = { processInbox, buildSlackText, doneFileName, FOLDERS, TRASH_KEEP_DAYS };
