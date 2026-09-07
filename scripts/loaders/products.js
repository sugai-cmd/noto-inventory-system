// 商品マスタ → products（フェーズ1）

const { loadCsvTable, existingByCodeOrName } = require('../lib/loadHelper');
const { parseInteger, parseNumber } = require('../lib/parseNumber');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO products
    (uid, code, name, volume_ml, abv, container_type, unit, list_price, jan_code,
     target_extract_spec, category, tax_per_unit, initial_product_stock, initial_wip_stock, note)
  VALUES
    (@uid, @code, @name, @volumeMl, @abv, @containerType, @unit, @listPrice, @janCode,
     @targetExtractSpec, @category, @taxPerUnit, @initialProductStock, @initialWipStock, @note)
`;

// 既に同じ名前の行があるときは、シートの内容で更新する。
// 在庫計算の起点になる列（初期在庫など）は当てない（createOnlyKeys で外す）。
const UPDATE_SQL = `
  UPDATE products SET
       name = @name,
       code = COALESCE(@code, code), volume_ml = @volumeMl, abv = @abv,
       container_type = @containerType, unit = @unit, list_price = @listPrice,
       jan_code = @janCode, target_extract_spec = @targetExtractSpec,
       category = @category, tax_per_unit = @taxPerUnit, note = @note
  WHERE id = @id
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '商品マスタ',
    csvFile: 'products.csv',
    insertSql: INSERT_SQL,
    updateSql: UPDATE_SQL,
    updateTable: 'products',
    createOnlyKeys: ['uid', 'initialProductStock', 'initialWipStock'],
    findExistingId: existingByCodeOrName('products', '商品ID', '商品名称'),
    mapRow(row) {
      const name = (row['商品名称'] || '').trim();
      if (!name) throw new Error('商品名称が空です');

      return {
        uid: generateUid(ctx.db, 'products'),
        code: row['商品ID'] || null,
        name,
        volumeMl: parseInteger(row['容量(ml)'], '容量(ml)'),
        abv: parseNumber(row['規定度数'], '規定度数'),
        containerType: row['容器タイプ'] || null,
        unit: row['単位'] || '本',
        listPrice: parseNumber(row['上代'], '上代'),
        janCode: row['JAN'] || null,
        targetExtractSpec: row['目標エキス分基準'] || null,
        category: row['商品カテゴリ'] || null,
        taxPerUnit: parseNumber(row['課税額'], '課税額'),
        initialProductStock: (parseInteger(row['初期商品在庫数'], '初期商品在庫数') ?? 0),
        initialWipStock: (parseInteger(row['初期仕掛品在庫数'], '初期仕掛品在庫数') ?? 0),
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.productIdByName.set(context.normalize(row['商品名称']), id);
    },
  });
}

module.exports = { load };
