const fs = require('node:fs');
const { parse } = require('csv-parse/sync');

/**
 * CSVファイルをオブジェクトの配列として読み込む。
 * ファイルが存在しない場合はnullを返す（呼び出し元でスキップ可否を判断する）。
 * @param {string} filePath
 * @returns {object[]|null}
 */
function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  const content = raw.replace(/^﻿/, ''); // BOM除去（Excel/Sheetsエクスポート対策）

  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

module.exports = { readCsv };
