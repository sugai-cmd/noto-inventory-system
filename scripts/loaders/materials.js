// 資材マスタ → materials（フェーズ1）

const { loadCsvTable, existingByName } = require('../lib/loadHelper');
const { parseNumber, parseNumberLoose } = require('../lib/parseNumber');
const { parseLeadTimeDays } = require('../../src/utils/leadTime');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO materials
    (uid, code, name, category, unit, unit_price, lot_size, proper_stock_qty,
     initial_stock, supplier_name, supplier_address, supplier_contact, lead_time_days, note)
  VALUES
    (@uid, @code, @name, @category, @unit, @unitPrice, @lotSize, @properStockQty,
     @initialStock, @supplierName, @supplierAddress, @supplierContact, @leadTimeDays, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '資材マスタ',
    csvFile: 'materials.csv',
    insertSql: INSERT_SQL,
    findExistingId: existingByName('materials', '資材名'),
    mapRow(row) {
      // 資材マスタは「資材名」、資材在庫変動履歴は「資材名称」と表記が異なる（6-1）。
      // ここでは資材マスタ側の表記に従う。
      const name = (row['資材名'] || '').trim();
      if (!name) throw new Error('資材名が空です');

      // 数量欄に「500（3000）」のように注記が書き足されている行がある。
      // 行ごと落とすと、その資材を使うレシピまで芋づるで落ちるので、
      // 数値だけ取り出し、元の書き方は備考へ残す。
      const notes = [];
      const loose = (value, label) => {
        const { value: num, salvaged } = parseNumberLoose(value, label);
        if (salvaged) notes.push(`${label}の元の記載: ${salvaged}`);
        return num;
      };

      const lotSize = loose(row['ロット数'], 'ロット数');
      const properStockQty = loose(row['適正在庫数'], '適正在庫数');
      const initialStock = loose(row['初期在庫数'], '初期在庫数') ?? 0;

      return {
        uid: generateUid(ctx.db, 'materials'),
        code: row['資材ID'] || null,
        name,
        category: row['資材種別'] || null,
        unit: row['単位'] || null,
        unitPrice: parseNumber(row['単価(円)'], '単価(円)'),
        lotSize: lotSize == null ? null : Math.trunc(lotSize),
        properStockQty: properStockQty == null ? null : Math.trunc(properStockQty),
        initialStock,
        supplierName: row['発注先会社名'] || null,
        supplierAddress: row['発注先住所'] || null,
        supplierContact: row['発注先担当者名'] || null,
        // リードタイムは「1日」「3週間」「1.5ヶ月」のような書き方。
        // 数値として読もうとすると落ちるので、画面の取り込みと同じ変換を通す。
        leadTimeDays: (() => {
          const { days, ok } = parseLeadTimeDays(row['リードタイム']);
          if (!ok) throw new Error(`リードタイムを読み取れませんでした: "${row['リードタイム']}"`);
          return days;
        })(),
        note: [row['備考'] || null, ...notes].filter(Boolean).join(' / ') || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.materialIdByName.set(context.normalize(row['資材名']), id);
    },
  });
}

module.exports = { load };
