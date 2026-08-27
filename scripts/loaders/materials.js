// 資材マスタ → materials（フェーズ1）

const { loadCsvTable, existingByName } = require('../lib/loadHelper');
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

      return {
        uid: generateUid(ctx.db, 'materials'),
        code: row['資材ID'] || null,
        name,
        category: row['資材種別'] || null,
        unit: row['単位'] || null,
        unitPrice: row['単価(円)'] ? Number(row['単価(円)']) : null,
        lotSize: row['ロット数'] ? Number(row['ロット数']) : null,
        properStockQty: row['適正在庫数'] ? Number(row['適正在庫数']) : null,
        initialStock: row['初期在庫数'] ? Number(row['初期在庫数']) : 0,
        supplierName: row['発注先会社名'] || null,
        supplierAddress: row['発注先住所'] || null,
        supplierContact: row['発注先担当者名'] || null,
        leadTimeDays: row['リードタイム'] ? Number(row['リードタイム']) : null,
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.materialIdByName.set(context.normalize(row['資材名']), id);
    },
  });
}

module.exports = { load };
