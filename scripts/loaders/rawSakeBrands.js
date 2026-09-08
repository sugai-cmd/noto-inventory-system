// 原酒マスタ → raw_sake_brands（フェーズ1、酒蔵マスタの後）
//
// 原料受払記録の「原酒スペック」がこの銘柄名を指しているので、
// ここを入れておくと受払の行に銘柄と酒蔵が紐付き、
// ロット追跡の「原酒タンクの中身」で銘柄別に見られるようになる。
//
// 行の同一性は**銘柄名ではなく原酒ID**で見る（0015）。
// 同じ銘柄の別ロットは度数が違うので、名前で一意にすると片方しか入らない。

const path = require('node:path');
const { loadCsvTable, existingByCodeOrName } = require('../lib/loadHelper');
const { readCsv } = require('../lib/csvReader');
const { aliasesForSheet, aliasRow } = require('../lib/columnAliases');
const { parseNumber } = require('../lib/parseNumber');
const { parseDateOnly } = require('../lib/parseDate');
const { generateUid } = require('../../src/utils/uid');

const SHEET = '原酒マスタ';

const INSERT_SQL = `
  INSERT INTO raw_sake_brands
    (uid, code, name, abv, sake_meter_value, brewery_id, brewery_name_raw, status,
     produced_on, registered_on, initial_stock, current_stock, note)
  VALUES
    (@uid, @code, @name, @abv, @sakeMeterValue, @breweryId, @breweryNameRaw, @status,
     @producedOn, @registeredOn, @initialStock, @currentStock, @note)
`;

// 既に同じ原酒IDの行があるときは、シートの内容で更新する。
// 在庫計算の起点になる列（初期在庫など）は当てない（createOnlyKeys で外す）。
const UPDATE_SQL = `
  UPDATE raw_sake_brands SET
       code = COALESCE(@code, code), name = @name,
       abv = @abv, sake_meter_value = @sakeMeterValue, brewery_id = @breweryId,
       brewery_name_raw = @breweryNameRaw, status = @status, produced_on = @producedOn,
       registered_on = @registeredOn, note = @note
  WHERE id = @id
`;

/**
 * 同じ原酒IDが複数行に書かれているとき、全部に `-L1` `-L2` … を付けて分ける。
 *
 * 実データでは `unzan-BYR6` が2行あり、度数が 18.4 と 18.8 で違う。
 * IDが同じままだと片方しか入らないので、シートで既に使われている
 * `toriya-BYR6-L1` の書き方にそろえてロット番号を振る。
 * 1件目も素のままにせず全部に振るのは、どちらがどのロットか分かるようにするため。
 *
 * @returns {{codeByRow: Map<number, string>, renumbered: Array}}
 */
function assignLotCodes(rows) {
  const codeByRow = new Map(); // CSV上の行番号 → 付け直したID
  const renumbered = [];

  const groups = new Map(); // 元のID → その行番号の一覧
  const used = new Set();   // ファイル内で既に使われているID
  rows.forEach((row, i) => {
    const code = (row['ID'] || '').trim();
    if (!code) return;
    used.add(code);
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(i + 2); // ヘッダを1行目とした行番号
  });

  for (const [code, rowNumbers] of groups) {
    if (rowNumbers.length < 2) {
      codeByRow.set(rowNumbers[0], code);
      continue;
    }
    let lot = 0;
    for (const rowNumber of rowNumbers) {
      // 既に `-L1` を使っている行が別にあるなら、その次の空き番号にする
      let candidate;
      do {
        lot++;
        candidate = `${code}-L${lot}`;
      } while (used.has(candidate));
      used.add(candidate);
      codeByRow.set(rowNumber, candidate);
      renumbered.push({ rowNumber, from: code, to: candidate });
    }
  }

  return { codeByRow, renumbered };
}

function load(ctx) {
  const rawRows = readCsv(path.join(ctx.dataDir, 'raw_sake_brands.csv')) ?? [];
  const aliases = aliasesForSheet(SHEET);
  const rows = rawRows.map((r) => aliasRow(r, aliases));
  const { codeByRow, renumbered } = assignLotCodes(rows);

  for (const r of renumbered) {
    ctx.report.recordNotice(
      SHEET,
      r.rowNumber,
      `原酒ID「${r.from}」が複数行にあるため ${r.to} として取り込みました（別ロットとして分けています）`
    );
  }

  // findExistingId も mapRow も、付け直した後のIDで動かす
  const codeOf = (rowNumber) => codeByRow.get(rowNumber) ?? null;
  const findByCodeOrName = existingByCodeOrName('raw_sake_brands', 'ID', '銘柄');

  loadCsvTable(ctx, {
    sheetName: SHEET,
    csvFile: 'raw_sake_brands.csv',
    rows, // 下読みで採番した行をそのまま使う（読み直すと行番号が合わせられない）
    insertSql: INSERT_SQL,
    updateSql: UPDATE_SQL,
    updateTable: 'raw_sake_brands',
    createOnlyKeys: ['uid', 'initialStock', 'currentStock'],
    findExistingId: (row, context, rowNumber) => {
      const code = codeOf(rowNumber);
      return findByCodeOrName(code ? { ...row, ID: code } : row, context);
    },
    mapRow(row, rowNumber, context) {
      const name = (row['銘柄'] || '').trim();
      if (!name) throw new Error('銘柄が空です');

      // 原酒マスタの酒蔵は「よしのや」、酒蔵マスタは「株式会社よしのや」のように
      // 略して書かれていることがある。引けなければ書かれたままを残す
      // （勝手に酒蔵マスタを増やすと、表記ゆれの分だけ酒蔵が増えてしまう）。
      const breweryRaw = (row['酒蔵'] || '').trim();
      const breweryId = breweryRaw
        ? (context.lookups.breweryIdByName.get(context.normalize(breweryRaw)) ?? null)
        : null;

      return {
        uid: generateUid(ctx.db, 'raw_sake_brands'),
        code: codeOf(rowNumber),
        name,
        abv: parseNumber(row['アルコール度数'], 'アルコール度数'),
        sakeMeterValue: parseNumber(row['日本酒度'], '日本酒度'),
        breweryId,
        breweryNameRaw: breweryId == null ? breweryRaw || null : null,
        status: row['ステータス'] || null,
        // 「2025年」「2025-02」など書き方が揃っていないので、そのまま持つ
        producedOn: row['製造年(月)'] || null,
        registeredOn: parseDateOnly(row['移入日']),
        initialStock: parseNumber(row['初期在庫量'], '初期在庫量'),
        currentStock: parseNumber(row['現在在庫量'], '現在在庫量'),
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context, rowNumber) {
      const code = codeOf(rowNumber);
      if (code) context.lookups.rawSakeBrandIdByCode.set(context.normalize(code), id);
      registerName(context, row['銘柄'], id);
    },
  });
}

/**
 * 銘柄名から引けるようにする。ただし同じ名前が2行以上あるときは**引けなくする**。
 *
 * 名前が一意でなくなったので、黙ってどちらかを選ぶと度数の違うロットを取り違える。
 * 引けなかったぶんは不一致として報告され、原酒IDで書き直してもらえばよい。
 */
function registerName(ctx, rawName, id) {
  const key = ctx.normalize(rawName);
  const byName = ctx.lookups.rawSakeBrandIdByName;
  const ambiguous = ctx.lookups.rawSakeBrandAmbiguousNames;

  if (ambiguous.has(key)) return;
  if (byName.has(key)) {
    ambiguous.add(key);
    byName.delete(key);
    return;
  }
  byName.set(key, id);
}

module.exports = { load, assignLotCodes };
