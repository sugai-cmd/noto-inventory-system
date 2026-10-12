// 共有ドライブのFAXフォルダ（Macに同期されたもの）を見て、届いたPDFを取り込み・仕分けする。
//
//   FAX/            ← Apps Script（gas/fax-saver）が新しいPDFを置く
//     取込済/       ← 受注に登録できた（または登録済みだった）カナカンの発注書
//                     名前は「発注日_得意先_発注番号.pdf」に変える
//     要確認/       ← カナカンの発注書だが登録できなかったもの・読み取りに失敗したもの
//     未分類/       ← カナカンの発注書ではないFAX。人が中身を見て、要らなければ「不要」へ移す
//     不要/         ← 置かれてから30日たったら削除する（Googleドライブのゴミ箱へ）
//
// ファイルの移動・削除だけを受け持ち、読み取りと登録は faxOrderImportService に任せる。

const fs = require('node:fs');
const path = require('node:path');

const FOLDERS = {
  done: '取込済',
  review: '要確認',
  other: '未分類',
  trash: '不要',
};

const TRASH_KEEP_DAYS = 30;
const STATE_FILE = '.fax-inbox-state.json';

/** ファイル名に使えない文字を除く */
function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 60);
}

/** 同じ名前があれば _2, _3 … を付けて、上書きしない */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${base}_${n}${ext}`);
  }
  return candidate;
}

function moveFile(from, dir, fileName) {
  fs.mkdirSync(dir, { recursive: true });
  const to = uniquePath(dir, fileName);
  fs.renameSync(from, to);
  return to;
}

/** 取込済に置くときの名前（例: 20261010_カナカン酒類石川_73068150.pdf） */
function doneFileName(result) {
  const p = result.parsed;
  const date = (p.orderedOn ?? '').replace(/-/g, '') || '日付不明';
  const customer = result.plan?.customerName ?? p.warehouse ?? 'カナカン';
  return `${date}_${safeName(customer)}_${p.orderNumber}.pdf`;
}

function readState(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE), 'utf8'));
  } catch {
    return { trashSeen: {} };
  }
}

function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, STATE_FILE), JSON.stringify(state, null, 2));
}

/**
 * 「不要」フォルダの掃除。置かれた日はファイルの日付では分からない
 * （ドライブ上の移動では更新日時が変わらない）ため、初めて見つけた日を覚えておき、
 * そこから30日たったものを消す。
 */
function cleanTrash(inboxDir, state, now, dryRun) {
  const dir = path.join(inboxDir, FOLDERS.trash);
  const deleted = [];
  if (!fs.existsSync(dir)) {
    state.trashSeen = {};
    return deleted;
  }
  const present = new Set(fs.readdirSync(dir).filter((f) => !f.startsWith('.')));
  const seen = {};
  for (const name of present) {
    const firstSeen = state.trashSeen?.[name] ?? now.toISOString();
    const ageDays = (now - new Date(firstSeen)) / 86400000;
    if (ageDays >= TRASH_KEEP_DAYS) {
      if (!dryRun) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      deleted.push(name);
    } else {
      seen[name] = firstSeen;
    }
  }
  state.trashSeen = seen;
  return deleted;
}

/**
 * @param {object} opts
 * @param {string} opts.inboxDir - 同期されたFAXフォルダ
 * @param {string} opts.stateDir - 状態ファイルを置く場所（DBと同じ db/ を想定）
 * @param {(pdfPath: string, o: object) => Promise<object>} opts.importFn - faxOrderImportService.importFromPdf
 * @param {boolean} [opts.dryRun] - 登録・移動・削除をしない
 * @param {Date} [opts.now]
 * @returns {Promise<{items: object[], deleted: string[]}>}
 */
async function processInbox({ inboxDir, stateDir, importFn, dryRun = false, now = new Date() }) {
  if (!fs.existsSync(inboxDir)) {
    throw new Error(
      `FAXフォルダが見つかりません: ${inboxDir}\n` +
        'Googleドライブ（パソコン版）が起動しているか、.env の FAX_INBOX_DIR を確認してください'
    );
  }

  const pdfs = fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.pdf$/i.test(d.name))
    .map((d) => d.name)
    .sort();

  const items = [];
  for (const name of pdfs) {
    const src = path.join(inboxDir, name);
    let result;
    try {
      result = await importFn(src, { dryRun, sourceName: name });
    } catch (err) {
      result = { status: 'error', reasons: [err.message], warnings: [] };
    }

    let folder;
    let newName = name;
    if (result.status === 'registered' || result.status === 'duplicate' || result.status === 'dry_run') {
      folder = FOLDERS.done;
      newName = doneFileName(result);
    } else if (result.status === 'not_kanakan') {
      folder = FOLDERS.other;
    } else {
      folder = FOLDERS.review;
    }

    let movedTo = path.join(inboxDir, folder, newName);
    if (!dryRun) movedTo = moveFile(src, path.join(inboxDir, folder), newName);
    items.push({ name, status: result.status, folder, movedTo, result });
  }

  const state = readState(stateDir);
  const deleted = cleanTrash(inboxDir, state, now, dryRun);
  if (!dryRun) writeState(stateDir, state);

  return { items, deleted };
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

module.exports = { processInbox, buildSlackText, FOLDERS, TRASH_KEEP_DAYS };
