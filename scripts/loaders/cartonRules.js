// 段ボール対応表 → carton_rules（フェーズ1、商品マスタの後）
//
// この表はスプレッドシートには無く、GAS の OrderCode.gs に BOX_RULES という
// 定数として書かれていた（そのため送料計算のマスタを入れたときに投入できていなかった）。
// 商品名で紐付けるので、商品マスタを入れたあとに実行する。
//
// 出典: OrderCode.gs の BOX_RULES（商品名・本数・箱・サイズ）

const BOX_RULES = [
  { product: 'JOCHU White NOTO 35 300ml', qty: 1, box: '300ml一本用', size: 60 },
  { product: 'JOCHU White NOTO 35 300ml', qty: 2, box: '300ml2本用', size: 80 },
  { product: 'JOCHU White NOTO 35 300ml', qty: 6, box: '700ml6本用', size: 100 },
  { product: 'JOCHU White NOTO 35 300ml', qty: 12, box: '300ml12本用', size: 100 },
  { product: 'JOCHU White NOTO 35 180ml', qty: 1, box: '300ml一本用', size: 60 },
  { product: 'JOCHU White NOTO 35 180ml', qty: 2, box: '300ml一本用', size: 60 },
  { product: 'JOCHU White NOTO 35 180ml', qty: 3, box: '300ml一本用', size: 60 },
  { product: 'JOCHU White NOTO 35 700ml without box', qty: 6, box: '700ml6本用', size: 100 },
  { product: 'JOCHU White NOTO 41 710ml', qty: 1, box: '桐箱一本用', size: 80 },
  { product: 'JOCHU White NOTO 41 710ml', qty: 6, box: '710ml6本海外', size: 120 },
  { product: 'JOCHU White NOTO 41 710ml', qty: 12, box: '710ml12本海外', size: 160 },
];

const SHEET = '段ボール対応表';

function load(ctx) {
  const summary = ctx.report.touchSummary(SHEET);

  const insert = ctx.db.prepare(
    `INSERT INTO carton_rules (product_id, quantity, box_name, carton_size)
     VALUES (@productId, @quantity, @boxName, @cartonSize)`
  );
  const exists = ctx.db.prepare(
    'SELECT id FROM carton_rules WHERE product_id = ? AND quantity = ?'
  );

  BOX_RULES.forEach((rule, i) => {
    summary.read++;
    const productId = ctx.lookups.productIdByName.get(ctx.normalize(rule.product));
    if (productId == null) {
      ctx.report.recordUnmatched(SHEET, '商品名', rule.product, ctx.normalize(rule.product));
      summary.skipped++;
      return;
    }
    if (exists.get(productId, rule.qty)) {
      summary.existing++;
      return;
    }
    try {
      insert.run({
        productId,
        quantity: rule.qty,
        boxName: rule.box,
        cartonSize: String(rule.size),
      });
      summary.inserted++;
    } catch (e) {
      ctx.report.recordError(SHEET, i + 1, e.message);
      summary.skipped++;
    }
  });
}

module.exports = { load };
