// 同期されたフォルダに届いたファイルを取り込み、結果ごとに仕分ける。
//
//   <受信フォルダ>/
//     取込済/   ← 登録できた（または登録済みだった）もの。名前を分かりやすく付け替える
//     要確認/   ← 登録できなかったもの・読み取りに失敗したもの
//     未分類/   ← そもそも対象ではなかったもの（他社のFAX、注文以外のメールなど）
//     不要/     ← 置かれてから30日たったら削除する（ゴミ箱へ）
//
// **ファイルの移動・削除だけを受け持つ。** 読み取りと登録は呼び手が渡す importFn に任せる。
// カナカンのFAX（PDF）とCOREZOの注文メール（テキスト）の両方がここを通る。

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
 * @param {string} opts.inboxDir - 同期された受信フォルダ
 * @param {string} opts.stateDir - 状態ファイルを置く場所（DBと同じ db/ を想定）
 * @param {(filePath: string, o: object) => Promise<object>} opts.importFn - 1ファイルを取り込む
 * @param {boolean} [opts.dryRun] - 登録・移動・削除をしない
 * @param {Date} [opts.now]
 * @param {RegExp} [opts.fileFilter] - 取り込む拡張子（既定はPDF）
 * @param {(result: object, name: string) => string} [opts.doneName] - 取込済に置くときの名前
 * @param {string[]} [opts.otherStatuses] - 「未分類」に置く status
 * @param {string} [opts.missingDirLabel] - 受信フォルダの呼び名（エラー文に出る）
 * @param {string} [opts.missingDirHint] - 受信フォルダが無いときに添える一言
 * @returns {Promise<{items: object[], deleted: string[]}>}
 */
async function processInbox({
  inboxDir,
  stateDir,
  importFn,
  dryRun = false,
  now = new Date(),
  fileFilter = /\.pdf$/i,
  doneName = (result, name) => name,
  otherStatuses = ['not_kanakan'],
  missingDirLabel = '受信フォルダ',
  missingDirHint = 'Googleドライブ（パソコン版）が起動しているか、.env の FAX_INBOX_DIR を確認してください',
}) {
  if (!fs.existsSync(inboxDir)) {
    throw new Error(`${missingDirLabel}が見つかりません: ${inboxDir}\n${missingDirHint}`);
  }

  const files = fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter((d) => d.isFile() && fileFilter.test(d.name))
    .map((d) => d.name)
    .sort();

  const items = [];
  for (const name of files) {
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
      newName = doneName(result, name);
    } else if (otherStatuses.includes(result.status)) {
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

module.exports = { processInbox, safeName, moveFile, FOLDERS, TRASH_KEEP_DAYS };
