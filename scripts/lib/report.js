const fs = require('node:fs');
const path = require('node:path');
const { suggest, confidentSuggestion } = require('./similarName');

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
    this.masterUpdates = []; // 既存のマスタ行を書き換えた内容（黙って上書きしないため）
    // 取り込まずに飛ばした行。件数だけ数えて中身を残さないと、
    // 「スキップ47」と出ているのにどの47行か調べようがなくなる
    this.skipped = [];
    // シートのどの行にも対応しなくなったマスタ行（DB側から見た取り残し）
    this.orphans = [];
    // 列名 → その列が引きにいく先の名前の一覧。候補を出すのに使う
    this.namePools = {};
  }

  recordMasterUpdate(sheet, name, column, before, after) {
    this.masterUpdates.push({ sheet, name, column, before, after });
  }

  /**
   * 取り込まずに飛ばした行を残す。
   * @param {string} hint その行を見分けられる値（得意先名など）。行番号だけでは
   *                      シートから探せないので、必ず何か入れる
   */
  recordSkip(sheet, rowNumber, reason, hint) {
    this.skipped.push({ sheet, rowNumber, reason, hint: hint ?? '' });
  }

  recordOrphan(table, code, name, reason) {
    this.orphans.push({ table, code: code ?? '', name, reason });
  }

  recordUnmatched(sheet, column, rawValue, normalizedValue) {
    this.unmatchedNames.push({ sheet, column, rawValue, normalizedValue });
  }

  recordError(sheet, rowNumber, message) {
    this.errors.push({ sheet, rowNumber, message });
  }

  touchSummary(sheet) {
    if (!this.summary[sheet]) {
      this.summary[sheet] = { read: 0, inserted: 0, existing: 0, updated: 0, skipped: 0 };
    }
    return this.summary[sheet];
  }

  hasUnmatched() {
    return this.unmatchedNames.length > 0;
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  /**
   * 不一致の1件ごとに、マスタから似ている名前の候補を付ける。
   * 156件の一覧から目で探す作業を、こちらで肩代わりするため。
   */
  withCandidates() {
    return this.unmatchedNames.map((u) => {
      const pool = this.namePools[u.column] ?? [];
      const found = suggest(u.rawValue, pool);
      return {
        ...u,
        候補1: found[0]?.name ?? '',
        候補2: found[1]?.name ?? '',
        候補3: found[2]?.name ?? '',
      };
    });
  }

  /**
   * 候補が1つに絞れたものだけを集めた、そのまま使える aliases.json の雛形。
   * 絞れないもの（カナカンのように支店が並ぶ場合）は入れず、人に決めてもらう。
   */
  suggestedAliases() {
    const out = {};
    const seen = new Set();
    for (const u of this.unmatchedNames) {
      const key = `${u.column}\u0000${u.rawValue}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const pool = this.namePools[u.column] ?? [];
      const best = confidentSuggestion(u.rawValue, pool);
      if (!best || best === u.rawValue) continue;
      (out[u.column] ??= {})[u.rawValue] = best;
    }
    return out;
  }

  write() {
    fs.mkdirSync(this.outDir, { recursive: true });
    writeCsv(
      path.join(this.outDir, 'unmatched-names.csv'),
      ['sheet', 'column', 'rawValue', 'normalizedValue', '候補1', '候補2', '候補3'],
      this.withCandidates()
    );
    writeCsv(path.join(this.outDir, 'errors.csv'), ['sheet', 'rowNumber', 'message'], this.errors);
    writeCsv(
      path.join(this.outDir, 'master-updates.csv'),
      ['sheet', 'name', 'column', 'before', 'after'],
      this.masterUpdates
    );
    writeCsv(
      path.join(this.outDir, 'skipped-rows.csv'),
      ['sheet', 'rowNumber', 'reason', 'hint'],
      this.skipped
    );
    writeCsv(
      path.join(this.outDir, 'orphan-masters.csv'),
      ['table', 'code', 'name', 'reason'],
      this.orphans
    );
    fs.writeFileSync(
      path.join(this.outDir, 'summary.json'),
      JSON.stringify(this.summary, null, 2),
      'utf8'
    );

    const suggested = this.suggestedAliases();
    this.suggestedCount = Object.values(suggested).reduce((n, o) => n + Object.keys(o).length, 0);
    // これは機械が名前の似かたから当てた案なので、必ず人が確かめる。
    // アンダースコアで始まるキーは名寄せに使われないので、注意書きをここに置ける。
    const withNote = {
      _注意: [
        'これは名前の似かたから機械が当てた案です。そのまま使わず、必ず中身を確かめてください。',
        '正しければ scripts/data/aliases.json にコピーしてください。',
        '違っていれば行を消すか、正しい名前に直してください。',
        '候補が複数あって決められなかったものはここに入っていません。',
        'unmatched-names.csv の「候補1〜3」の列を見て決めてください。',
      ],
      ...suggested,
    };
    fs.writeFileSync(
      path.join(this.outDir, 'aliases-suggested.json'),
      JSON.stringify(withNote, null, 2) + '\n',
      'utf8'
    );
  }

  printSummary() {
    console.log('\n=== 移行サマリー ===');
    for (const [sheet, counts] of Object.entries(this.summary)) {
      const existing = counts.existing ? ` / 既存${counts.existing}` : '';
      const updated = counts.updated ? ` / 更新${counts.updated}` : '';
      // 意図して飛ばした行（aliases.json の __ignore__）は、直すべきスキップと分けて出す
      const ignored = counts.ignored ? ` / 対象外${counts.ignored}` : '';
      console.log(
        `  ${sheet}: 読込${counts.read} / 投入${counts.inserted}${updated}${existing}${ignored} / スキップ${counts.skipped}`
      );
    }
    if (this.errors.length) {
      console.log(`\nエラー・警告: ${this.errors.length}件 → ${path.join(this.outDir, 'errors.csv')}`);
    }
    if (this.masterUpdates.length) {
      console.log(
        `マスタの更新: ${this.masterUpdates.length}件 → ${path.join(this.outDir, 'master-updates.csv')}`
      );
    }
    if (this.skipped.length) {
      console.log(
        `取り込まなかった行: ${this.skipped.length}件 → ${path.join(this.outDir, 'skipped-rows.csv')}`
      );
      console.log('  飛ばした理由を1行ずつ書いています（エラーとは分けています）。');
    }
    if (this.orphans.length) {
      console.log(
        `シートに対応が無いマスタ行: ${this.orphans.length}件 → ${path.join(this.outDir, 'orphan-masters.csv')}`
      );
      console.log('  シートから消した行か、IDと名前の両方を変えた行です。');
      console.log('  そのままでも移行はできますが、選択肢に残り続けるので確かめてください。');
    }
    if (this.unmatchedNames.length) {
      console.log(
        `名寄せ不一致: ${this.unmatchedNames.length}件 → ${path.join(this.outDir, 'unmatched-names.csv')}`
      );
      console.log('  似ている名前の候補を「候補1〜3」の列に出しています。');
      if (this.suggestedCount) {
        console.log(
          `  うち${this.suggestedCount}件は候補が1つに絞れたので、そのまま使える形にしてあります:`
        );
        console.log(`    ${path.join(this.outDir, 'aliases-suggested.json')}`);
        console.log('  中身を確かめてから scripts/data/aliases.json にコピーしてください。');
      }
    }
  }
}

module.exports = { MigrationReport };
