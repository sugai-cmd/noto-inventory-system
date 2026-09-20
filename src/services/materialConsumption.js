// 資材を減らす共通の型。
//
// 瓶詰め・箱詰め（レシピに基づく消費）と、出荷（段ボールの消費）が使う。
// bottlingService の中にあった非公開関数をここへ出した。
//
// **どの資材消費も product_ledger_id で商品在庫変動履歴の行に紐付ける。**
// これが1本あるおかげで、
//   ledgerCancelService … 親を取り消すと資材も連動して取り消される（txn_type を見ていない）
//   bottlingService     … 本数を直すと資材も同じ割合で直る
// の2つが効く。紐付けを省くと、取り消しても資材が減ったままになる。
//
// txn_type は '消費' 固定。material_stock_ledger の CHECK は
// 入荷／消費／棚卸調整／欠損 の4値しか許さないので、出荷用の新しい区分は作れない。

const { nextMaterialHistoryCode } = require('../utils/codeGenerator');

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
 * 資材在庫変動履歴に消費行を入れる。**呼び出しは必ずトランザクション内で**
 * （履歴IDの採番と実INSERTの間に割り込まれないようにするため）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{materialId:number, materialName?:string, quantity:number}[]} items
 * @param {{txnDate:string, productLedgerId:number|bigint, note:string, createdBy?:number|null}} ctx
 * @returns {{materialId:number, materialName:string, quantity:number, ledgerId:number|bigint}[]}
 */
function consumeMaterials(db, items, { txnDate, productLedgerId, note, createdBy = null }) {
  const stmt = db.prepare(
    `INSERT INTO material_stock_ledger
       (history_code, txn_date, material_id, txn_type, quantity, product_ledger_id, data_kind,
        note, created_by)
     VALUES
       (@historyCode, @txnDate, @materialId, '消費', @quantity, @productLedgerId,
        '運用中（リアルタイム）', @note, @createdBy)`
  );

  return items.map((item) => {
    const result = stmt.run({
      historyCode: nextMaterialHistoryCode(db, txnDate),
      txnDate,
      materialId: item.materialId,
      quantity: item.quantity,
      productLedgerId,
      note,
      createdBy,
    });
    return {
      materialId: item.materialId,
      materialName: item.materialName ?? null,
      quantity: item.quantity,
      ledgerId: result.lastInsertRowid,
    };
  });
}

/**
 * レシピに基づいて資材消費行を資材在庫変動履歴へ追加する。
 * どの瓶詰め/箱詰め作業による消費かを product_ledger_id で紐付ける（4-17 H列相当）。
 */
function consumeRecipeMaterials(
  db,
  { productId, quantity, process, txnDate, productLedgerId, createdBy = null }
) {
  const items = getRecipe(db, productId, process).map((item) => ({
    materialId: item.material_id,
    materialName: item.material_name,
    quantity: item.qty_required * quantity,
  }));

  return consumeMaterials(db, items, {
    txnDate,
    productLedgerId,
    note: `${process}による自動消費`,
    createdBy,
  });
}

module.exports = { getRecipe, consumeMaterials, consumeRecipeMaterials };
