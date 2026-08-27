// 棚卸（実地棚卸）の業務ロジック（旧GASの submitProductStocktaking / submitStocktaking 相当）。
//
// 考え方：台帳の「数量は常に正の数」という制約（DATA_STRUCTURE.md 4-2 D列）を守るため、
// 実測値と理論値（＝モニタービューの現在値）の差を求め、その符号によって受払区分を出し分ける。
//   実測 > 理論 → 増加側の区分（棚卸調整）
//   実測 < 理論 → 減少側の区分（欠損／欠減）
// 差が0なら台帳を汚さないよう、行を作らずスキップする。

const { getConnection } = require('../db/connection');
const { nextProductHistoryCode, nextMaterialHistoryCode } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');

/**
 * 商品・仕掛品の棚卸。
 *
 * @param {object} input
 * @param {number} input.productId
 * @param {number} [input.actualProductStock] - 完成品の実測本数（省略時は調整しない）
 * @param {number} [input.actualWipStock]     - 仕掛品の実測本数（省略時は調整しない）
 * @param {string} [input.txnDate]
 * @param {string} [input.reason] - 差異の理由（備考に残す）
 */
function submitProductStocktaking(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    const before = db
      .prepare('SELECT * FROM v_product_stock WHERE product_id = ?')
      .get(input.productId);

    const adjustments = [];
    const insert = db.prepare(
      `INSERT INTO product_stock_ledger
         (history_code, txn_date, product_id, txn_type, quantity, storage_place, data_kind, note)
       VALUES
         (@historyCode, @txnDate, @productId, @txnType, @quantity, @storagePlace,
          '運用中（リアルタイム）', @note)`
    );

    const targets = [
      {
        label: '商品',
        actual: input.actualProductStock,
        theoretical: before.product_stock,
        increaseType: '棚卸調整_商品',
        decreaseType: '欠損_商品',
      },
      {
        label: '仕掛品',
        actual: input.actualWipStock,
        theoretical: before.wip_stock,
        increaseType: '棚卸調整_仕掛品',
        decreaseType: '欠損_仕掛品',
      },
    ];

    for (const target of targets) {
      if (target.actual == null) continue;

      const diff = target.actual - target.theoretical;
      if (diff === 0) {
        adjustments.push({ ...summarize(target), diff: 0, ledgerId: null, skipped: true });
        continue;
      }

      const result = insert.run({
        historyCode: nextProductHistoryCode(db, txnDate),
        txnDate,
        productId: input.productId,
        txnType: diff > 0 ? target.increaseType : target.decreaseType,
        quantity: Math.abs(diff),
        storagePlace: input.storagePlace ?? '浄溜所',
        note: `棚卸: 理論${target.theoretical} → 実測${target.actual}` +
          (input.reason ? ` / ${input.reason}` : ''),
      });

      adjustments.push({
        ...summarize(target),
        diff,
        txnType: diff > 0 ? target.increaseType : target.decreaseType,
        ledgerId: result.lastInsertRowid,
        skipped: false,
      });
    }

    if (!adjustments.length) {
      throw new BusinessRuleError('実測値（商品または仕掛品）を1つ以上入力してください');
    }

    return {
      product: { id: product.id, name: product.name },
      before: { productStock: before.product_stock, wipStock: before.wip_stock },
      adjustments,
      after: db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(input.productId),
    };
  });

  return run();

  function summarize(t) {
    return { target: t.label, theoretical: t.theoretical, actual: t.actual };
  }
}

/**
 * 資材の棚卸。
 * 資材台帳は 0003 のマイグレーションで '棚卸調整' / '欠損' を扱えるようにしてある。
 */
function submitMaterialStocktaking(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(input.materialId);
    if (!material) throw new NotFoundError(`資材が見つかりません (id=${input.materialId})`);

    const before = db
      .prepare('SELECT * FROM v_material_stock WHERE material_id = ?')
      .get(input.materialId);

    const diff = input.actualStock - before.current_stock;
    if (diff === 0) {
      return {
        material: { id: material.id, name: material.name },
        theoretical: before.current_stock,
        actual: input.actualStock,
        diff: 0,
        ledgerId: null,
        skipped: true,
        after: before,
      };
    }

    const result = db
      .prepare(
        `INSERT INTO material_stock_ledger
           (history_code, txn_date, material_id, txn_type, quantity, data_kind, note)
         VALUES
           (@historyCode, @txnDate, @materialId, @txnType, @quantity,
            '運用中（リアルタイム）', @note)`
      )
      .run({
        historyCode: nextMaterialHistoryCode(db, txnDate),
        txnDate,
        materialId: input.materialId,
        txnType: diff > 0 ? '棚卸調整' : '欠損',
        quantity: Math.abs(diff),
        note: `棚卸: 理論${before.current_stock} → 実測${input.actualStock}` +
          (input.reason ? ` / ${input.reason}` : ''),
      });

    return {
      material: { id: material.id, name: material.name },
      theoretical: before.current_stock,
      actual: input.actualStock,
      diff,
      txnType: diff > 0 ? '棚卸調整' : '欠損',
      ledgerId: result.lastInsertRowid,
      skipped: false,
      after: db.prepare('SELECT * FROM v_material_stock WHERE material_id = ?').get(input.materialId),
    };
  });

  return run();
}

/**
 * タンク（浄酎）の棚卸。検尺による実測液量との差を欠減／棚卸調整として記録する。
 * tank_ledger は to_tank_id を加算・from_tank_id を減算として集計するため、
 * 増減方向によって埋める列を変える。
 */
function submitTankStocktaking(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(input.tankId);
    if (!tank) throw new NotFoundError(`タンクが見つかりません (id=${input.tankId})`);

    const before = db.prepare('SELECT * FROM v_tank_monitor WHERE tank_id = ?').get(input.tankId);
    const diff = Number((input.actualVolumeL - before.current_volume_l).toFixed(3));

    if (diff === 0) {
      return {
        tank: { id: tank.id, name: tank.name },
        theoretical: before.current_volume_l,
        actual: input.actualVolumeL,
        diff: 0,
        ledgerId: null,
        skipped: true,
        after: before,
      };
    }

    const isIncrease = diff > 0;
    const result = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            data_kind, note)
         VALUES
           (@txnDate, @fromTankId, @txnType, NULL, @toTankId, @quantityL, @abv,
            '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: isIncrease ? null : input.tankId,
        toTankId: isIncrease ? input.tankId : null,
        txnType: isIncrease ? '棚卸調整' : '欠減',
        quantityL: Math.abs(diff),
        abv: input.abv ?? null,
        note: `棚卸: 理論${before.current_volume_l}L → 実測${input.actualVolumeL}L` +
          (input.reason ? ` / ${input.reason}` : ''),
      });

    // 実測度数が入力されていればタンクマスタ側の理論度数も更新する
    if (input.abv != null) {
      db.prepare('UPDATE tanks SET current_abv = ? WHERE id = ?').run(input.abv, input.tankId);
    }

    return {
      tank: { id: tank.id, name: tank.name },
      theoretical: before.current_volume_l,
      actual: input.actualVolumeL,
      diff,
      txnType: isIncrease ? '棚卸調整' : '欠減',
      ledgerId: result.lastInsertRowid,
      skipped: false,
      after: db.prepare('SELECT * FROM v_tank_monitor WHERE tank_id = ?').get(input.tankId),
    };
  });

  return run();
}

module.exports = {
  submitProductStocktaking,
  submitMaterialStocktaking,
  submitTankStocktaking,
};
