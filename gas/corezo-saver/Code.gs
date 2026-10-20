/**
 * COREZO（金沢楽座）の注文メールを共有ドライブのCOREZOフォルダに保存する Apps Script。
 *
 * 1時間おきに動き、support@corezo.co.jp から届いたメールの本文を .txt で保存する。
 * 保存した本文は受注管理システムのMac（Googleドライブ パソコン版で同期）が読み取り、
 * 注文メールなら受注に登録する（scripts/corezo-inbox.js）。手順は docs/COREZO-ORDER-IMPORT.md。
 *
 * FAXのPDFと違い添付は無いので、**本文をそのままテキストで置く**。
 * 受信日時と件名は本文からは分からないので、先頭に X-COREZO-… の3行を足す
 * （受注日と、注文以外の連絡の見分けに使う）。
 *
 * 使い方
 *   1. このファイルを新しいApps Scriptプロジェクトに貼る
 *   2. COREZO_FOLDER_ID を、共有ドライブに作った「COREZO」フォルダのIDに書き換える
 *   3. 関数「setup」を1回だけ実行（権限の許可と、1時間おきの実行の登録）
 *   4. 以降は自動。すぐ試したいときは「saveCorezoMails」を実行
 */

/** 保存先: 共有ドライブ「NOTO Naorai」の COREZO フォルダ（作ってIDを入れる） */
const COREZO_FOLDER_ID = 'ここに共有ドライブのCOREZOフォルダのIDを入れる';

/** 保存済みのメールに付けるラベル（Gmailの画面で見分けるため） */
const SAVED_LABEL = 'COREZO保存済';

/**
 * 探すメール。注文確認だけでなく**COREZOからの連絡も保存する**
 * （配送先住所の変更など。人に知らせる必要があるため）。
 * スレッドにまとめられることがあるので、メール1通ずつ「保存済みか」を覚えておく。
 */
const SEARCH_QUERY = 'from:support@corezo.co.jp newer_than:14d';

/** 保存済みメールIDを覚えておく数（スクリプト プロパティの容量に収める） */
const MAX_REMEMBERED_IDS = 500;
const PROP_KEY = 'SAVED_MESSAGE_IDS';

function setup() {
  // 同じ関数のトリガーが二重に登録されないよう、いったん消してから作る
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'saveCorezoMails') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('saveCorezoMails').timeBased().everyHours(1).create();
  saveCorezoMails();
}

/** ファイル名に使えない文字を落とす */
function safeFileName(text) {
  return String(text).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function saveCorezoMails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // 前回の実行がまだ動いている

  try {
    const folder = DriveApp.getFolderById(COREZO_FOLDER_ID);
    const label = GmailApp.getUserLabelByName(SAVED_LABEL) || GmailApp.createLabel(SAVED_LABEL);
    const props = PropertiesService.getScriptProperties();
    const saved = JSON.parse(props.getProperty(PROP_KEY) || '[]');
    const savedSet = {};
    for (const id of saved) savedSet[id] = true;

    let count = 0;
    for (const thread of GmailApp.search(SEARCH_QUERY, 0, 100)) {
      for (const message of thread.getMessages()) {
        const id = message.getId();
        if (savedSet[id]) continue;

        const received = Utilities.formatDate(
          message.getDate(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"
        );
        const header =
          'X-COREZO-Received: ' + received + '\n' +
          'X-COREZO-MessageId: ' + id + '\n' +
          'X-COREZO-Subject: ' + message.getSubject() + '\n\n';

        // 日時をファイル名に入れておく（Mac側が取込済に置くときは注文番号で付け直す）
        const name = safeFileName(
          Utilities.formatDate(message.getDate(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss') + '_' + id
        ) + '.txt';
        folder.createFile(name, header + message.getPlainBody(), MimeType.PLAIN_TEXT);

        saved.push(id);
        savedSet[id] = true;
        count++;
      }
      thread.addLabel(label);
    }

    props.setProperty(PROP_KEY, JSON.stringify(saved.slice(-MAX_REMEMBERED_IDS)));
    console.log('COREZOのメールを ' + count + ' 件保存しました');
  } finally {
    lock.releaseLock();
  }
}
