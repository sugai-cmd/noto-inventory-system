// 酒蔵マスタ → breweries（フェーズ1）
//
// 8-2では移行対象外としていたが、原酒マスタと原料受払記録を銘柄で紐付けるには
// 酒蔵が要る（ロット追跡の「原酒タンクの中身」に酒蔵名を出すため）。

const { loadCsvTable, existingByCodeOrName } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO breweries (uid, code, name, address, phone, contact, started_on)
  VALUES (@uid, @code, @name, @address, @phone, @contact, @startedOn)
`;

// 既に同じ名前の行があるときは、シートの内容で更新する。
// 在庫計算の起点になる列（初期在庫など）は当てない（createOnlyKeys で外す）。
const UPDATE_SQL = `
  UPDATE breweries SET
       name = @name,
       code = COALESCE(@code, code), address = @address, phone = @phone,
       contact = @contact, started_on = @startedOn
  WHERE id = @id
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '酒蔵マスタ',
    csvFile: 'breweries.csv',
    insertSql: INSERT_SQL,
    updateSql: UPDATE_SQL,
    updateTable: 'breweries',
    createOnlyKeys: ['uid'],
    findExistingId: existingByCodeOrName('breweries', '酒蔵ID', '酒蔵名'),
    mapRow(row) {
      const name = (row['酒蔵名'] || '').trim();
      if (!name) throw new Error('酒蔵名が空です');

      return {
        uid: generateUid(ctx.db, 'breweries'),
        code: row['酒蔵ID'] || null,
        name,
        address: row['住所'] || null,
        phone: row['電話番号'] || null,
        contact: row['担当者名'] || null,
        startedOn: parseDateOnly(row['取引開始日']),
      };
    },
    afterInsert(row, id, context) {
      context.lookups.breweryIdByName.set(context.normalize(row['酒蔵名']), id);
    },
  });
}

module.exports = { load };
