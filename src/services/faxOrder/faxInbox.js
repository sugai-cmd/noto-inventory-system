// 共有ドライブのFAXフォルダ（Macに同期されたもの）を見て、届いたPDFを取り込み・仕分けする。
//
//   FAX/            ← Apps Script（gas/fax-saver）が新しいPDFを置く
//     取込済/       ← 受注に登録できた（または登録済みだった）カナカンの発注書
//                     名前は「発注日_得意先_発注番号.pdf」に変える
//     要確認/       ← カナカンの発注書だが登録できなかったもの・読み取りに失敗したもの
//     未分類/       ← カナカンの発注書ではないFAX。人が中身を見て、要らなければ「不要」へ
//     不要/         ← 置かれてから30日たったら削除する（Googleドライブのゴミ箱へ）
//
// 仕分けそのもの（移動・掃除）は inbox/fileInbox.js が持つ。COREZOの注文メールの取込も
// 同じ仕組みを通るため、**ここにはカナカン固有のことだけ**を置く。

const fileInbox = require('../inbox/fileInbox');

const { FOLDERS, TRASH_KEEP_DAYS, safeName } = fileInbox;

/** 取込済に置くときの名前（例: 20261010_カナカン酒類石川_73068150.pdf） */
function doneFileName(result) {
  const p = result.parsed;
  const date = (p.orderedOn ?? '').replace(/-/g, '') || '日付不明';
  const customer = result.plan?.customerName ?? p.warehouse ?? 'カナカン';
  return `${date}_${safeName(customer)}_${p.orderNumber}.pdf`;
}

/**
 * FAXフォルダを1回ぶん処理する。引数は fileInbox.processInbox と同じ
 * （importFn は faxOrderImportService.importFromPdf）。
 */
function processInbox(opts) {
  return fileInbox.processInbox({
    ...opts,
    fileFilter: /\.pdf$/i,
    doneName: doneFileName,
    otherStatuses: ['not_kanakan'],
    missingDirLabel: 'FAXフォルダ',
    missingDirHint:
      'Googleドライブ（パソコン版）が起動しているか、.env の FAX_INBOX_DIR を確認してください',
  });
}

/** Slackに送る文面。知らせることが無ければ null */
function buildSlackText({ items, deleted }) {
  const lines = [];
  for (const it of items) {
    const r = it.result;
    const p = r.parsed ?? {};
    if (it.status === 'registered') {
      lines.push(
        `:white_check_mark: 受注 ${r.order.order_no} を登録しました（${r.plan.customerName} / ` +
          `${r.plan.productName} ${r.plan.quantity}本 / 納品希望日 ${r.plan.requestedDeliveryOn} / ` +
          `発注番号 ${p.orderNumber}）`
      );
      for (const w of r.warnings ?? []) lines.push(`　　注意: ${w}`);
    } else if (it.status === 'needs_review' || it.status === 'error') {
      lines.push(`:warning: 要確認（登録していません）: ${it.name}${p.orderNumber ? `（発注番号 ${p.orderNumber}）` : ''}`);
      for (const reason of r.reasons ?? []) lines.push(`　　- ${reason}`);
      for (const [k, v] of Object.entries(r.candidates ?? {})) {
        lines.push(`　　候補（${k === 'customer' ? '得意先' : '商品'}）: ${v.join(' / ')}`);
      }
      lines.push('　　→ FAX/要確認 のPDFを見て、受注画面から手で登録してください');
    } else if (it.status === 'not_kanakan') {
      lines.push(`:page_facing_up: カナカン以外のFAXを「未分類」に置きました: ${it.name}（中身を確認し、要らなければ「不要」へ）`);
    }
  }
  if (deleted.length) lines.push(`:wastebasket: 「不要」から30日たったFAXを${deleted.length}件削除しました`);
  if (!lines.length) return null;
  return ['*FAX発注書の自動取込*', ...lines].join('\n');
}

module.exports = { processInbox, buildSlackText, doneFileName, FOLDERS, TRASH_KEEP_DAYS };
