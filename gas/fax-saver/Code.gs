/**
 * FAX（ブラザー複合機 → Gmail）のPDFを共有ドライブのFAXフォルダに保存する Apps Script。
 *
 * 4時間おきに動き、From_BrotherFAX のメールに付いたPDFを保存する。
 * 保存したPDFは受注管理システムのMac（Googleドライブ パソコン版で同期）が読み取り、
 * カナカンの発注書なら受注に登録する（scripts/fax-inbox.js）。手順は docs/FAX-AUTO-IMPORT.md。
 *
 * 使い方
 *   1. このファイルを新しいApps Scriptプロジェクトに貼る
 *   2. 関数「setup」を1回だけ実行（権限の許可と、4時間おきの実行の登録）
 *   3. 以降は自動。すぐ試したいときは「saveFaxAttachments」を実行
 */

/** 保存先: 共有ドライブ「NOTO Naorai」の FAX フォルダ */
const FAX_FOLDER_ID = '1sTvrhV2B4lKKy2TMKdWXvfqfr1NIjE0_';

/** 保存済みのスレッドに付けるラベル（Gmailの画面で見分けるため） */
const SAVED_LABEL = 'FAX保存済';

/**
 * 探すメール。件名が同じなので、Gmailは複数のFAXを1つのスレッドにまとめることがある。
 * そのためスレッドのラベルでは判定せず、メール1通ずつ「保存済みか」を覚えておく。
 */
const SEARCH_QUERY = 'from:FromBrotherDevice@brother.com has:attachment newer_than:14d';

/** 保存済みメールIDを覚えておく数（スクリプト プロパティの容量に収める） */
const MAX_REMEMBERED_IDS = 300;
const PROP_KEY = 'SAVED_MESSAGE_IDS';

function setup() {
  // 同じ関数のトリガーが二重に登録されないよう、いったん消してから作る
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'saveFaxAttachments') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('saveFaxAttachments').timeBased().everyHours(4).create();
  saveFaxAttachments();
}

function saveFaxAttachments() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // 前回の実行がまだ動いている

  try {
    const folder = DriveApp.getFolderById(FAX_FOLDER_ID);
    const label = GmailApp.getUserLabelByName(SAVED_LABEL) || GmailApp.createLabel(SAVED_LABEL);
    const props = PropertiesService.getScriptProperties();
    const saved = JSON.parse(props.getProperty(PROP_KEY) || '[]');
    const savedSet = new Set(saved);

    let count = 0;
    for (const thread of GmailApp.search(SEARCH_QUERY, 0, 100)) {
      for (const message of thread.getMessages()) {
        const id = message.getId();
        if (savedSet.has(id)) continue;

        for (const att of message.getAttachments({ includeInlineImages: false })) {
          const isPdf =
            att.getContentType() === 'application/pdf' || /\.pdf$/i.test(att.getName());
          if (!isPdf) continue;
          // 複合機のファイル名は「機番+受信日時_連番.pdf」で、FAXごとに違う
          folder.createFile(att.copyBlob()).setName(att.getName());
          count++;
        }
        saved.push(id);
        savedSet.add(id);
      }
      thread.addLabel(label);
    }

    props.setProperty(PROP_KEY, JSON.stringify(saved.slice(-MAX_REMEMBERED_IDS)));
    console.log(`FAXのPDFを ${count} 件保存しました`);
  } finally {
    lock.releaseLock();
  }
}
