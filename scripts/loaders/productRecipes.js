// 製品レシピマスタ → product_recipes（フェーズ1、products・materialsのnameから解決）

const { loadCsvTable, resolveId } = require('../lib/loadHelper');

const INSERT_SQL = `
  INSERT INTO product_recipes (product_id, material_id, qty_required, process)
  VALUES (@productId, @materialId, @qtyRequired, @process)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '製品レシピマスタ',
    csvFile: 'product_recipes.csv',
    insertSql: INSERT_SQL,
    // (product_id, material_id, process) のUNIQUE制約と同じ基準で既存行を判定する
    findExistingId(row, context) {
      const productId = context.lookups.productIdByName.get(context.normalize(row['商品名称']));
      const materialId = context.lookups.materialIdByName.get(context.normalize(row['資材名']));
      if (productId == null || materialId == null) return null;
      const found = context.db
        .prepare(
          'SELECT id FROM product_recipes WHERE product_id = ? AND material_id = ? AND process IS ?'
        )
        .get(productId, materialId, row['ステータス'] || null);
      return found ? found.id : null;
    },
    mapRow(row, rowNumber, context) {
      const productId = resolveId(context, {
        sheet: '製品レシピマスタ',
        column: '商品名称',
        rawValue: row['商品名称'],
        idMap: context.lookups.productIdByName,
        required: true,
      });
      const materialId = resolveId(context, {
        sheet: '製品レシピマスタ',
        column: '資材名',
        rawValue: row['資材名'],
        idMap: context.lookups.materialIdByName,
        required: true,
      });

      return {
        productId,
        materialId,
        qtyRequired: Number(row['必要数量']),
        process: row['ステータス'] || null,
      };
    },
  });
}

module.exports = { load };
