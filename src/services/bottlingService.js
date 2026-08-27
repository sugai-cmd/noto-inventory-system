// 瓶詰め・箱詰めの業務ロジック（旧GASの submitBottlingV2 / submitBoxing 相当）。
//
// この2機能は「1操作で複数台帳へ書き込む」典型例（DATA_STRUCTURE.md 5章）：
//   瓶詰め: 商品在庫変動履歴（瓶詰＝仕掛品+）／資材在庫変動履歴（レシピ消費）／浄酎容器変動履歴（タンク-）
//   箱詰め: 商品在庫変動履歴（箱詰＝仕掛品-・商品+）／資材在庫変動履歴（レシピ消費）
// GAS版はシートごとに順次appendRowしていたため途中で失敗すると不整合が残ったが、
// ここではSQLiteのトランザクションで全書き込みをまとめ、失敗時は全部ロールバックする。

const { getConnection } = require('../db/connection');
const { nextProductHistoryCode, nextMaterialHistoryCode } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');

/**
 * 指定商品・工程のレシピを取得する（旧 getRecipeForProduct_）
 */
function getRecipe(db, productId, process) {
  return db
    .prepare(
      `SELECT r.*, m.name AS material_name
       FROM product_recipes r
       JOIN materials m ON m.id = r.material_id
       WHERE r.product_id = ? AND r.process = ?`
    )
    .all(productId, process);
}

/**
 * レシピに基づいて資材消費行を資材在庫変動履歴へ追加する。
 * どの瓶詰め/箱詰め作業による消費かを product_ledger_id で紐付ける（4-17 H列相当）。
 */
function consumeRecipeMaterials(db, { productId, quantity, process, txnDate, productLedgerId }) {
  const recipe = getRecipe(db, productId, process);
  const consumed = [];

  const stmt = db.prepare(
    `INSERT INTO material_stock_ledger
       (history_code, txn_date, material_id, txn_type, quantity, product_ledger_id, data_kind, note)
     VALUES
       (@historyCode, @txnDate, @materialId, '消費', @quantity, @productLedgerId,
        '運用中（リアルタイム）', @note)`
  );

  for (const item of recipe) {
    const consumeQty = item.qty_required * quantity;
    const result = stmt.run({
      historyCode: nextMaterialHistoryCode(db, txnDate),
      txnDate,
      materialId: item.material_id,
      quantity: consumeQty,
      productLedgerId,
      note: `${process}による自動消費`,
    });
    consumed.push({
      materialId: item.material_id,
      materialName: item.material_name,
      quantity: consumeQty,
      ledgerId: result.lastInsertRowid,
    });
  }

  return consumed;
}

/**
 * 瓶詰め登録。タンクから液を抜いて仕掛品を作る。
 *
 * @param {object} input
 * @param {number} input.productId
 * @param {number} input.quantity   - 瓶詰めした本数
 * @param {number} input.tankId     - 払出元タンク
 * @param {number} input.volumeL    - タンクから減らす量(L)
 * @param {string} [input.txnDate]  - 作業日（YYYY-MM-DD、既定は今日）
 * @param {number} [input.abv]      - 度数
 */
function submitBottling(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(input.tankId);
    if (!tank) throw new NotFoundError(`タンクが見つかりません (id=${input.tankId})`);

    // 1) 商品在庫変動履歴（瓶詰＝仕掛品の増加）
    const historyCode = nextProductHistoryCode(db, txnDate);
    const productLedgerResult = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity, counterparty,
            storage_place, data_kind, note)
         VALUES
           (@historyCode, @txnDate, @productId, '瓶詰', @quantity, @counterparty,
            @storagePlace, '運用中（リアルタイム）', @note)`
      )
      .run({
        historyCode,
        txnDate,
        productId: input.productId,
        quantity: input.quantity,
        counterparty: tank.name,
        storagePlace: input.storagePlace ?? '浄溜所',
        note: input.note ?? null,
      });
    const productLedgerId = productLedgerResult.lastInsertRowid;

    // 2) 資材在庫変動履歴（レシピに基づく消費）
    const consumedMaterials = consumeRecipeMaterials(db, {
      productId: input.productId,
      quantity: input.quantity,
      process: '瓶詰',
      txnDate,
      productLedgerId,
    });

    // 3) 浄酎容器変動履歴（タンクからの払出）
    const tankLedgerResult = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            product_ledger_id, data_kind, note)
         VALUES
           (@txnDate, @fromTankId, '瓶詰', @productId, NULL, @quantityL, @abv,
            @productLedgerId, '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: input.tankId,
        productId: input.productId,
        quantityL: input.volumeL,
        abv: input.abv ?? tank.current_abv ?? null,
        productLedgerId,
        note: input.note ?? null,
      });

    return {
      productLedgerId,
      historyCode,
      tankLedgerId: tankLedgerResult.lastInsertRowid,
      consumedMaterials,
      stock: db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(input.productId),
    };
  });

  return run();
}

/**
 * 箱詰め登録。仕掛品を完成品に振り替える（在庫の増減方向はv_product_stockのCASE式が担う）。
 */
function submitBoxing(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    // 仕掛品が足りているかを事前に確認する（GAS版にはなかったガード）
    const stock = db
      .prepare('SELECT * FROM v_product_stock WHERE product_id = ?')
      .get(input.productId);
    if (stock && stock.wip_stock < input.quantity) {
      throw new BusinessRuleError(
        `仕掛品在庫が不足しています（${product.name}: 在庫${stock.wip_stock} < 箱詰${input.quantity}）`
      );
    }

    const historyCode = nextProductHistoryCode(db, txnDate);
    const productLedgerResult = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity,
            storage_place, data_kind, note)
         VALUES
           (@historyCode, @txnDate, @productId, '箱詰', @quantity,
            @storagePlace, '運用中（リアルタイム）', @note)`
      )
      .run({
        historyCode,
        txnDate,
        productId: input.productId,
        quantity: input.quantity,
        storagePlace: input.storagePlace ?? '浄溜所',
        note: input.note ?? null,
      });
    const productLedgerId = productLedgerResult.lastInsertRowid;

    const consumedMaterials = consumeRecipeMaterials(db, {
      productId: input.productId,
      quantity: input.quantity,
      process: '箱詰',
      txnDate,
      productLedgerId,
    });

    return {
      productLedgerId,
      historyCode,
      consumedMaterials,
      stock: db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(input.productId),
    };
  });

  return run();
}

module.exports = { submitBottling, submitBoxing, getRecipe };
