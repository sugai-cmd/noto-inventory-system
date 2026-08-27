// 商品マスタ → products（フェーズ1）

const { loadCsvTable, existingByName } = require('../lib/loadHelper');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO products
    (uid, code, name, volume_ml, abv, container_type, unit, list_price, jan_code,
     target_extract_spec, category, tax_per_unit, initial_product_stock, initial_wip_stock, note)
  VALUES
    (@uid, @code, @name, @volumeMl, @abv, @containerType, @unit, @listPrice, @janCode,
     @targetExtractSpec, @category, @taxPerUnit, @initialProductStock, @initialWipStock, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '商品マスタ',
    csvFile: 'products.csv',
    insertSql: INSERT_SQL,
    findExistingId: existingByName('products', '商品名称'),
    mapRow(row) {
      const name = (row['商品名称'] || '').trim();
      if (!name) throw new Error('商品名称が空です');

      return {
        uid: generateUid(ctx.db, 'products'),
        code: row['商品ID'] || null,
        name,
        volumeMl: row['容量(ml)'] ? Number(row['容量(ml)']) : null,
        abv: row['規定度数'] ? Number(row['規定度数']) : null,
        containerType: row['容器タイプ'] || null,
        unit: row['単位'] || '本',
        listPrice: row['上代'] ? Number(row['上代']) : null,
        janCode: row['JAN'] || null,
        targetExtractSpec: row['目標エキス分基準'] || null,
        category: row['商品カテゴリ'] || null,
        taxPerUnit: row['課税額'] ? Number(row['課税額']) : null,
        initialProductStock: row['初期商品在庫数'] ? Number(row['初期商品在庫数']) : 0,
        initialWipStock: row['初期仕掛品在庫数'] ? Number(row['初期仕掛品在庫数']) : 0,
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.productIdByName.set(context.normalize(row['商品名称']), id);
    },
  });
}

module.exports = { load };
