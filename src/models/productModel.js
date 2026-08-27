// 商品マスタ（products）

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { normalizeName } = require('../utils/normalizeName');

function list() {
  const db = getConnection();
  return db.prepare('SELECT * FROM products ORDER BY name').all();
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

/**
 * 受注登録・瓶詰め画面のインクリメンタル検索用（DB_SCHEMA_DESIGN.md 2.2）。
 * 在庫僅少アラート（DATA_STRUCTURE.md 4-3）に使えるよう、現在庫も一緒に返す。
 */
function search(query, limit = 20) {
  const db = getConnection();
  const q = normalizeName(query);

  const baseSql = `
    SELECT p.*, s.product_stock, s.wip_stock
    FROM products p
    LEFT JOIN v_product_stock s ON s.product_id = p.id
  `;

  if (!q) {
    return db.prepare(`${baseSql} ORDER BY p.name LIMIT ?`).all(limit);
  }

  const like = `%${q}%`;
  return db
    .prepare(
      `${baseSql}
       WHERE p.name LIKE ? OR p.code LIKE ? OR p.category LIKE ? OR p.jan_code LIKE ?
       ORDER BY
         CASE WHEN p.name LIKE ? THEN 0 ELSE 1 END,
         p.name
       LIMIT ?`
    )
    .all(like, like, like, like, `${q}%`, limit);
}

function create(input) {
  const db = getConnection();
  const uid = generateUid(db, 'products');
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
      uid,
      code: input.code ?? null,
      name: input.name,
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
  return findById(result.lastInsertRowid);
}

/** 商品在庫モニター相当（v_product_stock、DB_SCHEMA_DESIGN.md 3章） */
function stockAll() {
  const db = getConnection();
  return db.prepare('SELECT * FROM v_product_stock ORDER BY name').all();
}

function stockByProductId(productId) {
  const db = getConnection();
  return db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(productId);
}

module.exports = { list, findById, search, create, stockAll, stockByProductId };
