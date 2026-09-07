// 原酒マスタ → raw_sake_brands（フェーズ1、酒蔵マスタの後）
//
// 原料受払記録の「原酒スペック」がこの銘柄名を指しているので、
// ここを入れておくと受払の行に銘柄と酒蔵が紐付き、
// ロット追跡の「原酒タンクの中身」で銘柄別に見られるようになる。

const { loadCsvTable, existingByName } = require('../lib/loadHelper');
const { parseNumber } = require('../lib/parseNumber');
const { parseDateOnly } = require('../lib/parseDate');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO raw_sake_brands
    (uid, name, abv, sake_meter_value, brewery_id, brewery_name_raw, status,
     produced_on, registered_on, initial_stock, current_stock, note)
  VALUES
    (@uid, @name, @abv, @sakeMeterValue, @breweryId, @breweryNameRaw, @status,
     @producedOn, @registeredOn, @initialStock, @currentStock, @note)
`;

// 既に同じ名前の行があるときは、シートの内容で更新する。
// 在庫計算の起点になる列（初期在庫など）は当てない（createOnlyKeys で外す）。
const UPDATE_SQL = `
  UPDATE raw_sake_brands SET
       abv = @abv, sake_meter_value = @sakeMeterValue, brewery_id = @breweryId,
       brewery_name_raw = @breweryNameRaw, status = @status, produced_on = @producedOn,
       registered_on = @registeredOn, note = @note
  WHERE id = @id
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '原酒マスタ',
    csvFile: 'raw_sake_brands.csv',
    insertSql: INSERT_SQL,
    updateSql: UPDATE_SQL,
    updateTable: 'raw_sake_brands',
    createOnlyKeys: ['uid', 'initialStock', 'currentStock'],
    findExistingId: existingByName('raw_sake_brands', '銘柄'),
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
    afterInsert(row, id, context) {
      context.lookups.rawSakeBrandIdByName.set(context.normalize(row['銘柄']), id);
    },
  });
}

module.exports = { load };
