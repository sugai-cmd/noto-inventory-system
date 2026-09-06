// 酒蔵マスタ → breweries（フェーズ1）
//
// 8-2では移行対象外としていたが、原酒マスタと原料受払記録を銘柄で紐付けるには
// 酒蔵が要る（ロット追跡の「原酒タンクの中身」に酒蔵名を出すため）。

const { loadCsvTable, existingByName } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO breweries (uid, code, name, address, phone, contact, started_on)
  VALUES (@uid, @code, @name, @address, @phone, @contact, @startedOn)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '酒蔵マスタ',
    csvFile: 'breweries.csv',
    insertSql: INSERT_SQL,
    findExistingId: existingByName('breweries', '酒蔵名'),
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
