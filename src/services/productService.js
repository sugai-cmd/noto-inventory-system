// 商品まわりの業務ロジック（旧GASの registerProductWithRecipe 相当）。
//
// 商品の登録とレシピ（1本作るのに必要な資材）の登録を1トランザクションで行う。
// レシピが無いと瓶詰め・箱詰めで資材が消費されないため、同時に登録できることが重要。

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { BusinessRuleError, NotFoundError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

const PROCESSES = ['瓶詰', '箱詰'];

function registerProductWithRecipe(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const name = (input.name ?? '').trim();
    if (!name) throw new BusinessRuleError('商品名称を入力してください');
    if (db.prepare('SELECT id FROM products WHERE name = ?').get(name)) {
      throw new BusinessRuleError(`商品「${name}」は既に登録されています`);
    }

    const result = db
      .prepare(
        `INSERT INTO products
           (uid, code, name, volume_ml, abv, container_type, unit, list_price, jan_code,
            target_extract_spec, category, tax_per_unit,
            initial_product_stock, initial_wip_stock, note)
         VALUES
           (@uid, @code, @name, @volumeMl, @abv, @containerType, @unit, @listPrice, @janCode,
            @targetExtractSpec, @category, @taxPerUnit,
            @initialProductStock, @initialWipStock, @note)`
      )
      .run({
        uid: generateUid(db, 'products'),
        code: input.code ?? null,
        name,
        volumeMl: input.volumeMl ?? null,
        abv: input.abv ?? null,
        containerType: input.containerType ?? null,
        unit: input.unit ?? '本',
        listPrice: input.listPrice ?? null,
        janCode: input.janCode ?? null,
        targetExtractSpec: input.targetExtractSpec ?? null,
        category: input.category ?? null,
        taxPerUnit: input.taxPerUnit ?? null,
        initialProductStock: input.initialProductStock ?? 0,
        initialWipStock: input.initialWipStock ?? 0,
        note: input.note ?? null,
      });

    const productId = result.lastInsertRowid;
    const recipeItems = replaceRecipe(db, productId, input.recipe ?? []);

    operationLogService.record({
      user: actor,
      action: 'product.create',
      targetType: 'products',
      targetId: productId,
      summary: `商品「${name}」を登録（レシピ ${recipeItems.length}件）`,
    });

    return { ...findById(productId), recipe: getRecipe(productId) };
  });

  return run();
}

/**
 * レシピを丸ごと差し替える。
 * 既存を消してから入れ直すので、画面から編集した内容がそのまま反映される。
 */
function replaceRecipe(db, productId, items) {
  db.prepare('DELETE FROM product_recipes WHERE product_id = ?').run(productId);
  if (!items.length) return [];

  const insert = db.prepare(
    `INSERT INTO product_recipes (product_id, material_id, qty_required, process)
     VALUES (?, ?, ?, ?)`
  );

  const seen = new Set();
  for (const item of items) {
    if (!PROCESSES.includes(item.process)) {
      throw new BusinessRuleError(`工程は「瓶詰」「箱詰」のいずれかで指定してください: ${item.process}`);
    }
    const material = db.prepare('SELECT id, name FROM materials WHERE id = ?').get(item.materialId);
    if (!material) throw new NotFoundError(`資材が見つかりません (id=${item.materialId})`);

    // (商品, 資材, 工程) はUNIQUE制約があるので、事前に重複を弾いて分かりやすく伝える
    const key = `${item.materialId}:${item.process}`;
    if (seen.has(key)) {
      throw new BusinessRuleError(`${material.name}（${item.process}）が重複しています`);
    }
    seen.add(key);

    if (!(item.qtyRequired > 0)) {
      throw new BusinessRuleError(`${material.name} の必要数量は0より大きい値で指定してください`);
    }

    insert.run(productId, item.materialId, item.qtyRequired, item.process);
  }
  return items;
}

function updateProductRecipe(productId, items, actor = null) {
  const db = getConnection();
  const product = findById(productId);
  if (!product) throw new NotFoundError(`商品が見つかりません (id=${productId})`);

  const run = db.transaction(() => {
    replaceRecipe(db, productId, items ?? []);
    operationLogService.record({
      user: actor,
      action: 'product.recipe.update',
      targetType: 'products',
      targetId: productId,
      summary: `商品「${product.name}」のレシピを更新（${(items ?? []).length}件）`,
    });
    return getRecipe(productId);
  });

  return run();
}

function updateProduct(id, input, actor = null) {
  const db = getConnection();
  if (!findById(id)) return null;

  db.prepare(
    `UPDATE products SET
       code = COALESCE(@code, code),
       name = COALESCE(@name, name),
       volume_ml = COALESCE(@volumeMl, volume_ml),
       abv = COALESCE(@abv, abv),
       container_type = COALESCE(@containerType, container_type),
       unit = COALESCE(@unit, unit),
       list_price = COALESCE(@listPrice, list_price),
       jan_code = COALESCE(@janCode, jan_code),
       target_extract_spec = COALESCE(@targetExtractSpec, target_extract_spec),
       category = COALESCE(@category, category),
       tax_per_unit = COALESCE(@taxPerUnit, tax_per_unit),
       note = COALESCE(@note, note),
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    code: input.code ?? null,
    name: input.name ?? null,
    volumeMl: input.volumeMl ?? null,
    abv: input.abv ?? null,
    containerType: input.containerType ?? null,
    unit: input.unit ?? null,
    listPrice: input.listPrice ?? null,
    janCode: input.janCode ?? null,
    targetExtractSpec: input.targetExtractSpec ?? null,
    category: input.category ?? null,
    taxPerUnit: input.taxPerUnit ?? null,
    note: input.note ?? null,
  });

  operationLogService.record({
    user: actor,
    action: 'product.update',
    targetType: 'products',
    targetId: id,
    summary: `商品（id=${id}）を編集`,
  });

  return findById(id);
}

function getRecipe(productId) {
  const db = getConnection();
  return db
    .prepare(
      `SELECT r.*, m.name AS material_name, m.unit
       FROM product_recipes r
       JOIN materials m ON m.id = r.material_id
       WHERE r.product_id = ?
       ORDER BY r.process, m.name`
    )
    .all(productId);
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}


/**
 * 既存商品からの複製登録（GAS版 README 3章「商品は複製登録可」）。
 * 容量違い・ラベル違いの商品を作るときに、レシピごと引き継ぐ。
 * 名前とコードはUNIQUEなので必ず新しい値を指定してもらう。
 */
function duplicateProduct(sourceId, overrides = {}, actor = null) {
  const db = getConnection();
  const source = db.prepare('SELECT * FROM products WHERE id = ?').get(sourceId);
  if (!source) throw new NotFoundError(`複製元の商品が見つかりません (id=${sourceId})`);
  if (!overrides.name || !String(overrides.name).trim()) {
    throw new BusinessRuleError('複製後の商品名称を入力してください');
  }

  const recipe = db
    .prepare('SELECT material_id, qty_required, process FROM product_recipes WHERE product_id = ?')
    .all(sourceId)
    .map((r) => ({ materialId: r.material_id, qtyRequired: r.qty_required, process: r.process }));

  const input = {
    // コードはUNIQUEなので引き継がない（指定があればそれを使う）
    code: overrides.code ?? null,
    name: String(overrides.name).trim(),
    volumeMl: overrides.volumeMl ?? source.volume_ml ?? undefined,
    abv: overrides.abv ?? source.abv ?? undefined,
    containerType: overrides.containerType ?? source.container_type ?? undefined,
    unit: overrides.unit ?? source.unit ?? undefined,
    listPrice: overrides.listPrice ?? source.list_price ?? undefined,
    janCode: overrides.janCode ?? undefined, // JANは商品ごとに違うので引き継がない
    targetExtractSpec: overrides.targetExtractSpec ?? source.target_extract_spec ?? undefined,
    category: overrides.category ?? source.category ?? undefined,
    taxPerUnit: overrides.taxPerUnit ?? source.tax_per_unit ?? undefined,
    // 在庫の起点は引き継がない。複製した瞬間に在庫があることになってしまう。
    initialProductStock: 0,
    initialWipStock: 0,
    note: overrides.note ?? source.note ?? undefined,
    recipe: overrides.copyRecipe === false ? undefined : recipe,
  };
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null) delete input[key];
  }
  if (overrides.code) input.code = overrides.code;

  return registerProductWithRecipe(input, actor);
}


// --- 製品レシピ（行単位の操作） -------------------------------------------
//
// 商品ごとの一括差し替え（updateProductRecipe）とは別に、
// レシピ画面から1行ずつ足したり直したりできるようにする。

/** 全商品のレシピを名前つきで返す */
function listAllRecipes() {
  const db = getConnection();
  return db
    .prepare(
      `SELECT r.id, r.recipe_code, r.product_id, r.material_id, r.qty_required, r.process,
              p.name AS product_name, m.name AS material_name, m.unit AS material_unit
       FROM product_recipes r
       JOIN products  p ON p.id = r.product_id
       JOIN materials m ON m.id = r.material_id
       ORDER BY p.name, r.process DESC, m.name`
    )
    .all();
}

/** 1行の追加・更新。（商品×資材×工程）が既にあれば数量を書き換える */
function upsertRecipeRow(input, actor = null) {
  const db = getConnection();

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
  if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(input.materialId);
  if (!material) throw new NotFoundError(`資材が見つかりません (id=${input.materialId})`);
  if (!(input.qtyRequired > 0)) {
    throw new BusinessRuleError('必要数量は0より大きい数値で入力してください');
  }

  const existing = db
    .prepare(
      'SELECT id FROM product_recipes WHERE product_id = ? AND material_id = ? AND process = ?'
    )
    .get(input.productId, input.materialId, input.process);

  if (existing) {
    db.prepare(
      'UPDATE product_recipes SET qty_required = ?, recipe_code = COALESCE(?, recipe_code) WHERE id = ?'
    ).run(input.qtyRequired, input.recipeCode ?? null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO product_recipes (recipe_code, product_id, material_id, qty_required, process)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.recipeCode ?? null, input.productId, input.materialId, input.qtyRequired, input.process);
  }

  operationLogService.record({
    user: actor,
    action: 'recipe.upsert',
    targetType: 'product_recipes',
    targetId: existing?.id ?? null,
    summary:
      `レシピ ${product.name} / ${material.name}（${input.process}）を` +
      `${existing ? '更新' : '登録'}（1本あたり${input.qtyRequired}）`,
  });

  return db
    .prepare(
      `SELECT r.*, p.name AS product_name, m.name AS material_name
       FROM product_recipes r
       JOIN products p ON p.id = r.product_id
       JOIN materials m ON m.id = r.material_id
       WHERE r.product_id = ? AND r.material_id = ? AND r.process = ?`
    )
    .get(input.productId, input.materialId, input.process);
}

function deleteRecipeRow(id, actor = null) {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT r.id, p.name AS product_name, m.name AS material_name, r.process
       FROM product_recipes r
       JOIN products p ON p.id = r.product_id
       JOIN materials m ON m.id = r.material_id
       WHERE r.id = ?`
    )
    .get(id);
  if (!row) return false;

  db.prepare('DELETE FROM product_recipes WHERE id = ?').run(id);
  operationLogService.record({
    user: actor,
    action: 'recipe.delete',
    targetType: 'product_recipes',
    targetId: id,
    summary: `レシピ ${row.product_name} / ${row.material_name}（${row.process}）を削除`,
  });
  return true;
}

module.exports = {
  listAllRecipes,
  upsertRecipeRow,
  deleteRecipeRow,
  duplicateProduct, registerProductWithRecipe, updateProduct, updateProductRecipe, getRecipe };
