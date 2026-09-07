const fs = require('node:fs');
const { parse } = require('csv-parse/sync');
const { decodeUpload, detectDelimiter } = require('../../src/services/masterImportService');
const { detectNotPlainText, notPlainTextMessage } = require('../../src/utils/fileFormat');

/**
 * CSVファイルをオブジェクトの配列として読み込む。
 * ファイルが存在しない場合はnullを返す（呼び出し元でスキップ可否を判断する）。
 *
 * 文字コードと区切り文字の判定は、マスタ画面のCSV取り込みと同じ仕組みを使う。
 * 画面では読めるのに移行では読めない、という食い違いを作らないため。
 * スプレッドシートのエクスポートはUTF-8だが、それをExcelで開いて保存し直すと
 * Shift_JISになる。取り違えると日本語が全部化けたまま取り込まれてしまう。
 *
 * @param {string} filePath
 * @returns {object[]|null}
 */
function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const buffer = fs.readFileSync(filePath);

  // テキストでないファイルは、ここで**ファイル名を添えて**止める。
  // csv-parse はリッチテキストでもエラーを出さず、見出しが「{\rtf1...」の
  // 1列だけの表として読めてしまう。そうなると項目が全部空になり、
  // 「得意先名が空です」が何百件も並ぶだけで原因にたどり着けない。
  // 21ファイルのうちどれかが分からないと直せないので、パスを必ず出す。
  const format = detectNotPlainText(buffer);
  if (format) throw new Error(notPlainTextMessage(filePath, format, 'CSV'));

  const { text } = decodeUpload(buffer);

  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter: detectDelimiter(text),
    // 列数が見出しと合わない行があっても、そこで全部を止めない。
    // 実データには末尾に空セルが余分に付いた行が混ざる。
    relax_column_count: true,
  });
}

module.exports = { readCsv };
