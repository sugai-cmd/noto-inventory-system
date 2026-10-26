/**
 * 経営数値シートの受け口（上司向け・閲覧専用のGoogleスプレッドシートに貼るApps Script）。
 *
 * 受注管理システム（scripts/export-management-sheet.js）から送られた表を、
 * このスプレッドシートに貼る。手順と数字の定義は docs/MANAGEMENT-SHEET.md。
 *
 * 数え方はすべて送る側（src/services/managementSheetService.js）にある。
 * ここでするのは貼ることと見た目だけ：
 *   - 毎回シートを空にして書き直す（同じ名前のシートを使い回す）
 *   - 日別のシートは、月ごとに日付の列をまとめて畳めるようにする（当月以外は畳む）
 *   - 赤い行（要発注の資材）、数値の書式、フィルタ、見出しの固定
 *   - シートの保護（オーナー以外は編集できない）
 *
 * 合言葉は「プロジェクトの設定 → スクリプト プロパティ」の MANAGEMENT_SECRET に置く。
 * コードには書かない。
 */

const HIGHLIGHT = '#f4cccc';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('MANAGEMENT_SECRET');
    if (!secret || payload.secret !== secret) {
      return json({ ok: false, error: '合言葉が一致しません' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      writeSheets(payload.report);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true, message: payload.report.asOf + ' の集計を書き込みました' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function writeSheets(report) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  report.sheets.forEach(function (spec, i) {
    const sh = ss.getSheetByName(spec.name) || ss.insertSheet(spec.name);
    writeSheet(sh, spec);
    protect(sh);
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
  ss.setActiveSheet(ss.getSheets()[0]);

  // 作ったときからある空のシートは消す（中身のあるシートは消さない）
  ['シート1', 'Sheet1'].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

function writeSheet(sh, spec) {
  const rows = spec.rows;
  const width = Math.max.apply(null, rows.map(function (r) { return Math.max(r.length, 1); }));
  const padded = rows.map(function (r) { return r.concat(new Array(width - r.length).fill('')); });

  if (sh.getFilter()) sh.getFilter().remove();
  removeColumnGroups(sh);
  sh.clear();
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);

  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  if (sh.getMaxRows() < padded.length) sh.insertRowsAfter(sh.getMaxRows(), padded.length - sh.getMaxRows());

  const range = sh.getRange(1, 1, padded.length, width);
  // 書式を値より先に決める。文字は「書式なしテキスト」にしておかないと、
  // 2026-10-01 のような日付や 0001 のような番号をシートが勝手に読み替える
  range.setNumberFormats(padded.map(function (r) { return r.map(formatOf); }));
  range.setValues(padded);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');

  if (spec.frozenRows) sh.setFrozenRows(spec.frozenRows);
  if (spec.frozenColumns) sh.setFrozenColumns(spec.frozenColumns);
  if (spec.filter && padded.length > 1) range.createFilter();
  if (spec.note) sh.getRange(1, 1).setNote(spec.note);

  (spec.highlightRows || []).forEach(function (row) {
    sh.getRange(row, 1, 1, width).setBackground(HIGHLIGHT);
  });

  if (spec.columnGroups && spec.columnGroups.length) {
    // 畳むボタンを月の合計の列（グループの左隣）に出す
    sh.setColumnGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.BEFORE);
    spec.columnGroups.forEach(function (g) {
      sh.getRange(1, g.start, 1, g.count).shiftColumnGroupDepth(1);
      if (g.collapsed) sh.getColumnGroup(g.start, 1).collapse();
    });
  }
}

/** 整数は桁区切り、小数は2桁まで、文字は書式なしテキスト */
function formatOf(v) {
  if (typeof v !== 'number') return '@';
  return Number.isInteger(v) ? '#,##0' : '#,##0.0#';
}

/** 前回作った列のまとまりを外す（毎回作り直すので、残すと二重になる） */
function removeColumnGroups(sh) {
  const all = sh.getRange(1, 1, 1, sh.getMaxColumns());
  for (let i = 0; i < 8; i++) {
    try {
      all.expandGroups();
      all.shiftColumnGroupDepth(-1);
    } catch (err) {
      return; // まとまりが無くなった
    }
  }
}

/** シートを保護し、オーナー（このスクリプトを動かす人）だけが編集できるようにする */
function protect(sh) {
  if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
  const p = sh.protect().setDescription('受注管理システムから毎朝自動で書き直します（編集しないでください）');
  const me = Session.getEffectiveUser();
  p.addEditor(me);
  p.removeEditors(p.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
  if (p.canDomainEdit()) p.setDomainEdit(false);
}
