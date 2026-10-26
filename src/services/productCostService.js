// 商品1本あたりの原価（ざっくり）。
//
//   商品原価 ＝ 中身の原価 ＋ 資材の原価
//   中身の原価 ＝ 容量(L) × 倍率 × 原酒の仕入単価(円/L)
//   倍率       ＝ 投入した原酒(L) ÷ 採れた浄酎(L)   … raw_sake_yield_rates を度数で引く
//   資材の原価 ＝ Σ レシピの必要数量 × 資材の単価   … 瓶詰と箱詰の両方の工程を足す
//
// 原酒の単価は「原価に使う」に印を付けた1件（raw_sake_brands.used_for_cost）を使う。
// 瓶詰めごとにロットを辿ってはいない。上司向けの経営数値シートで「おおよその粗利」を
// 見るためのもので、正確さより分かりやすさを取った（0032 の説明を参照）。
//
// **読むだけ。** 足りない値（単価・倍率・容量）があっても0円にせず、理由を返す。

const { getConnection } = require('../db/connection');

/** 円。REALの掛け算で出る小数のごみを落とす */
function yen(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

/** 原価に使う原酒（印が無ければ null） */
function currentRawSake(db) {
  return (
    db
      .prepare(
        `SELECT id, code, name, produced_on, unit_price_per_l
           FROM raw_sake_brands WHERE used_for_cost = 1 ORDER BY id LIMIT 1`
      )
      .get() ?? null
  );
}

/** 度数ごとの倍率（原酒L ÷ 浄酎L） */
function yieldRates(db) {
  return db
    .prepare('SELECT abv, raw_l, distillate_l, note FROM raw_sake_yield_rates ORDER BY abv')
    .all()
    .map((r) => ({ ...r, ratio: r.raw_l / r.distillate_l }));
}

/**
 * 中身の原価（1本）。
 * @returns {{amount:number|null, ratio:number|null, reason:string|null}}
 */
function liquidCost(product, rawSake, rates) {
  if (!rawSake) return { amount: null, ratio: null, reason: '原価に使う原酒が選ばれていません' };
  if (rawSake.unit_price_per_l == null) {
    return { amount: null, ratio: null, reason: `原酒「${rawSake.code ?? rawSake.name}」の単価が未設定です` };
  }
  if (product.volume_ml == null) return { amount: null, ratio: null, reason: '容量(ml)が未設定です' };
  if (product.abv == null) return { amount: null, ratio: null, reason: '規定度数が未設定です' };

  const rate = rates.find((r) => Math.abs(r.abv - product.abv) < 0.0001);
  if (!rate) return { amount: null, ratio: null, reason: `${product.abv}度の倍率が登録されていません` };

  return {
    amount: yen((product.volume_ml / 1000) * rate.ratio * rawSake.unit_price_per_l),
    ratio: rate.ratio,
    reason: null,
  };
}

/** 資材の原価（1本）と内訳。単価が空の資材は0円で足し、名前を返す */
function materialCost(db, productId) {
  const rows = db
    .prepare(
      `SELECT r.process, r.qty_required, m.name, m.unit_price
         FROM product_recipes r JOIN materials m ON m.id = r.material_id
        WHERE r.product_id = ?
        ORDER BY r.process, m.name`
    )
    .all(productId);

  const items = rows.map((r) => ({
    process: r.process,
    material: r.name,
    qty: r.qty_required,
    unitPrice: r.unit_price,
    amount: r.unit_price == null ? null : yen(r.qty_required * r.unit_price),
  }));
  return {
    amount: yen(items.reduce((t, i) => t + (i.amount ?? 0), 0)),
    items,
    missingPrices: items.filter((i) => i.unitPrice == null).map((i) => i.material),
    hasRecipe: items.length > 0,
  };
}

/**
 * 全商品の1本あたり原価。
 * @returns {{rawSake:object|null, rates:object[], products:object[]}}
 */
function listProductCosts() {
  const db = getConnection();
  const rawSake = currentRawSake(db);
  const rates = yieldRates(db);

  const products = db
    .prepare('SELECT id, code, name, volume_ml, abv, list_price, tax_category FROM products ORDER BY name')
    .all()
    .map((p) => {
      const liquid = liquidCost(p, rawSake, rates);
      const material = materialCost(db, p.id);
      const reasons = [];
      if (liquid.reason) reasons.push(liquid.reason);
      if (!material.hasRecipe) reasons.push('レシピが未登録です');
      if (material.missingPrices.length) reasons.push(`単価が未設定の資材: ${material.missingPrices.join('、')}`);
      return {
        ...p,
        liquidCost: liquid.amount,
        ratio: liquid.ratio,
        materialCost: material.amount,
        materials: material.items,
        // 中身が出せないときは合計も出さない（資材だけの額を原価と読まれないように）
        totalCost: liquid.amount == null ? null : yen(liquid.amount + material.amount),
        reasons,
      };
    });

  return { rawSake, rates, products };
}

module.exports = { listProductCosts, liquidCost, currentRawSake, yieldRates };
