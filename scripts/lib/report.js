const fs = require('node:fs');
const path = require('node:path');

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

/**
 * 移行実行1回分の結果（8-5「べき等性・dry-run・エラーレポート」参照）を集約するクラス。
 */
class MigrationReport {
  constructor(outDir) {
    this.outDir = outDir;
    this.unmatchedNames = []; // 名寄せ不一致（8-3）
    this.errors = []; // 行単位のエラー・警告（8-5）
    this.summary = {}; // シートごとの読込/投入/スキップ件数
  }

  recordUnmatched(sheet, column, rawValue, normalizedValue) {
    this.unmatchedNames.push({ sheet, column, rawValue, normalizedValue });
  }

  recordError(sheet, rowNumber, message) {
    this.errors.push({ sheet, rowNumber, message });
  }

  touchSummary(sheet) {
    if (!this.summary[sheet]) {
      this.summary[sheet] = { read: 0, inserted: 0, existing: 0, skipped: 0 };
    }
    return this.summary[sheet];
  }

  hasUnmatched() {
    return this.unmatchedNames.length > 0;
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  write() {
    fs.mkdirSync(this.outDir, { recursive: true });
    writeCsv(
      path.join(this.outDir, 'unmatched-names.csv'),
      ['sheet', 'column', 'rawValue', 'normalizedValue'],
      this.unmatchedNames
    );
    writeCsv(path.join(this.outDir, 'errors.csv'), ['sheet', 'rowNumber', 'message'], this.errors);
    fs.writeFileSync(
      path.join(this.outDir, 'summary.json'),
      JSON.stringify(this.summary, null, 2),
      'utf8'
    );
  }

  printSummary() {
    console.log('\n=== 移行サマリー ===');
    for (const [sheet, counts] of Object.entries(this.summary)) {
      const existing = counts.existing ? ` / 既存${counts.existing}` : '';
      console.log(
        `  ${sheet}: 読込${counts.read} / 投入${counts.inserted}${existing} / スキップ${counts.skipped}`
      );
    }
    if (this.errors.length) {
      console.log(`\nエラー・警告: ${this.errors.length}件 → ${path.join(this.outDir, 'errors.csv')}`);
    }
    if (this.unmatchedNames.length) {
      console.log(
        `名寄せ不一致: ${this.unmatchedNames.length}件 → ${path.join(this.outDir, 'unmatched-names.csv')}`
      );
    }
  }
}

module.exports = { MigrationReport };
