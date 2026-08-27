// 在庫監査レポート（旧GASの在庫監査レポート機能 相当）。
//
// 現行システムでは「在庫監査レポート」シートを新規作成して差分一覧を出力する
// 一度きりの調査用機能だった（DATA_STRUCTURE.md 5章）。ここではいつでも実行できる
// 読み取り専用のAPIとして実装し、データを書き換えずに問題箇所だけを列挙する。
//
// 監査項目（①②③④は旧実装の番号に対応）：
//   ① 重複検出          : 同じ内容の在庫変動が二重に登録されていないか
//   ② 在庫のマイナス検出 : 集計結果が負になっている商品・資材・タンク
//   ③ 受注リスト突合    : 発送済の受注に対応する出荷行があるか（逆も）
//   ④ 資材消費監査      : 瓶詰め/箱詰めがレシピ通りに資材を消費しているか
//   ⑤ 孤立した参照      : FKで拾えない紐付け漏れ

const { getConnection } = require('../db/connection');

/**
 * ① 重複検出
 * 同一日・同一商品・同一受払・同一数量の行が複数ある場合、二重登録の疑いがある。
 * 意図的に同じ作業を2回行う運用もあり得るため「疑い」として出す。
 */
function findDuplicateProductLedger(db) {
  return db
    .prepare(
      `SELECT l.txn_date, p.name AS product_name, l.txn_type, l.quantity,
              COUNT(*) AS count,
              GROUP_CONCAT(l.history_code) AS history_codes
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       WHERE l.is_cancelled = 0
       GROUP BY l.txn_date, l.product_id, l.txn_type, l.quantity
       HAVING COUNT(*) > 1
       ORDER BY l.txn_date DESC`
    )
    .all();
}

/**
 * ② 在庫のマイナス検出
 * 台帳の積み上げ結果が負になっているものは、記録漏れか順序の誤りを示す。
 */
function findNegativeStock(db) {
  const products = db
    .prepare(
      `SELECT name, product_stock, wip_stock FROM v_product_stock
       WHERE product_stock < 0 OR wip_stock < 0`
    )
    .all();

  const materials = db
    .prepare('SELECT name, current_stock FROM v_material_stock WHERE current_stock < 0')
    .all();

  const tanks = db
    .prepare(
      `SELECT t.code, v.name, v.current_volume_l
       FROM v_tank_monitor v JOIN tanks t ON t.id = v.tank_id
       WHERE v.current_volume_l < 0`
    )
    .all();

  const rawSakeTanks = db
    .prepare('SELECT code, name, current_volume_l FROM v_raw_sake_tank_volume WHERE current_volume_l < 0')
    .all();

  return { products, materials, tanks, rawSakeTanks };
}

/**
 * ③ 受注リスト突合
 * 新スキーマでは出荷行に order_id が入るので、旧実装の「日付×商品名」の集計比較
 * （6-3で移行期の妥協とされていた方法）ではなく厳密に突合できる。
 * ただし移行した過去データは order_id が NULL のことがあるため、それは別枠で報告する。
 */
function auditOrderShipments(db) {
  // 発送済なのに出荷行がない受注
  const shippedWithoutLedger = db
    .prepare(
      `SELECT o.order_no, o.delivered_on, c.name AS customer_name, p.name AS product_name, o.quantity
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN products p ON p.id = o.product_id
       WHERE o.status = '発送済'
         AND NOT EXISTS (
           SELECT 1 FROM product_stock_ledger l
           WHERE l.order_id = o.id AND l.txn_type = '出荷' AND l.is_cancelled = 0
         )
       ORDER BY o.delivered_on DESC`
    )
    .all();

  // 出荷行はあるのに受注が発送済になっていない
  const ledgerWithoutShippedStatus = db
    .prepare(
      `SELECT l.history_code, l.txn_date, o.order_no, o.status, p.name AS product_name, l.quantity
       FROM product_stock_ledger l
       JOIN orders o ON o.id = l.order_id
       JOIN products p ON p.id = l.product_id
       WHERE l.txn_type = '出荷' AND l.is_cancelled = 0 AND o.status <> '発送済'
       ORDER BY l.txn_date DESC`
    )
    .all();

  // 受注と出荷で本数が食い違う
  const quantityMismatch = db
    .prepare(
      `SELECT o.order_no, p.name AS product_name, o.quantity AS order_quantity,
              SUM(l.quantity) AS shipped_quantity
       FROM orders o
       JOIN product_stock_ledger l ON l.order_id = o.id
       JOIN products p ON p.id = o.product_id
       WHERE l.txn_type = '出荷' AND l.is_cancelled = 0
       GROUP BY o.id
       HAVING SUM(l.quantity) <> o.quantity`
    )
    .all();

  // 受注にもサンプルにも紐付いていない出荷（移行した過去データを含む）
  const unlinkedShipments = db
    .prepare(
      `SELECT l.history_code, l.txn_date, p.name AS product_name, l.quantity, l.counterparty
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       WHERE l.txn_type = '出荷' AND l.is_cancelled = 0
         AND l.order_id IS NULL AND l.sample_shipment_id IS NULL
       ORDER BY l.txn_date DESC`
    )
    .all();

  return {
    shippedWithoutLedger,
    ledgerWithoutShippedStatus,
    quantityMismatch,
    unlinkedShipments,
  };
}

/**
 * ④ 資材消費監査
 * 瓶詰め／箱詰めの各作業について、レシピから算出した理論消費量と
 * 実際に資材在庫変動履歴へ記録された消費量を突合する（旧 auditMaterialConsumption_）。
 */
function auditMaterialConsumption(db) {
  const works = db
    .prepare(
      `SELECT l.id, l.history_code, l.txn_date, l.txn_type, l.quantity, l.product_id,
              p.name AS product_name
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       WHERE l.txn_type IN ('瓶詰', '箱詰') AND l.is_cancelled = 0
       ORDER BY l.txn_date DESC`
    )
    .all();

  const recipeStmt = db.prepare(
    `SELECT r.material_id, r.qty_required, m.name AS material_name
     FROM product_recipes r
     JOIN materials m ON m.id = r.material_id
     WHERE r.product_id = ? AND r.process = ?`
  );
  const consumedStmt = db.prepare(
    `SELECT material_id, SUM(quantity) AS consumed
     FROM material_stock_ledger
     WHERE product_ledger_id = ? AND txn_type = '消費' AND is_cancelled = 0
     GROUP BY material_id`
  );

  const issues = [];

  for (const work of works) {
    const recipe = recipeStmt.all(work.product_id, work.txn_type);
    if (!recipe.length) continue; // レシピ未登録の商品は監査対象外

    const consumedRows = consumedStmt.all(work.id);
    const consumedByMaterial = new Map(consumedRows.map((r) => [r.material_id, r.consumed]));

    for (const item of recipe) {
      const expected = item.qty_required * work.quantity;
      const actual = consumedByMaterial.get(item.material_id) ?? 0;
      // 小数計算の誤差を拾わないよう、ごく小さな差は無視する
      if (Math.abs(expected - actual) < 1e-6) continue;

      issues.push({
        historyCode: work.history_code,
        txnDate: work.txn_date,
        txnType: work.txn_type,
        productName: work.product_name,
        quantity: work.quantity,
        materialName: item.material_name,
        expected,
        actual,
        diff: Math.round((actual - expected) * 1000) / 1000,
      });
    }

    // レシピにない資材が消費されている場合も報告する
    const recipeMaterialIds = new Set(recipe.map((r) => r.material_id));
    for (const row of consumedRows) {
      if (recipeMaterialIds.has(row.material_id)) continue;
      const material = db.prepare('SELECT name FROM materials WHERE id = ?').get(row.material_id);
      issues.push({
        historyCode: work.history_code,
        txnDate: work.txn_date,
        txnType: work.txn_type,
        productName: work.product_name,
        quantity: work.quantity,
        materialName: material?.name ?? `(id=${row.material_id})`,
        expected: 0,
        actual: row.consumed,
        diff: row.consumed,
        note: 'レシピに登録されていない資材が消費されています',
      });
    }
  }

  return issues;
}

/**
 * ⑤ 孤立した参照・紐付け漏れ
 */
function findOrphans(db) {
  // 瓶詰めなのにタンクからの払出が記録されていない
  const bottlingWithoutTankLedger = db
    .prepare(
      `SELECT l.history_code, l.txn_date, p.name AS product_name, l.quantity
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       WHERE l.txn_type = '瓶詰' AND l.is_cancelled = 0
         AND NOT EXISTS (
           SELECT 1 FROM tank_ledger t WHERE t.product_ledger_id = l.id AND t.is_cancelled = 0
         )
       ORDER BY l.txn_date DESC`
    )
    .all();

  // 完了した蒸留なのに浄酎タンクへの継足が記録されていない
  const completedDistillationWithoutFill = db
    .prepare(
      `SELECT d.distillation_code, d.started_on, d.output_l
       FROM distillations d
       WHERE d.status = '完了'
         AND NOT EXISTS (
           SELECT 1 FROM tank_ledger t
           WHERE t.distillation_id = d.id AND t.txn_type = '継足' AND t.is_cancelled = 0
         )
       ORDER BY d.started_on DESC`
    )
    .all();

  // FK制約では拾えない、参照先が消えた行（通常は0件のはず）
  const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();

  return { bottlingWithoutTankLedger, completedDistillationWithoutFill, foreignKeyIssues };
}

/**
 * 監査レポート全体を組み立てる。データは一切書き換えない。
 */
function runAudit() {
  const db = getConnection();

  const duplicates = findDuplicateProductLedger(db);
  const negativeStock = findNegativeStock(db);
  const orderShipments = auditOrderShipments(db);
  const materialConsumption = auditMaterialConsumption(db);
  const orphans = findOrphans(db);

  const negativeCount =
    negativeStock.products.length +
    negativeStock.materials.length +
    negativeStock.tanks.length +
    negativeStock.rawSakeTanks.length;

  const sections = [
    { key: 'duplicates', label: '① 重複の疑いがある在庫変動', count: duplicates.length },
    { key: 'negativeStock', label: '② 在庫がマイナスになっているもの', count: negativeCount },
    {
      key: 'orderShipments',
      label: '③ 受注と出荷履歴の不整合',
      count:
        orderShipments.shippedWithoutLedger.length +
        orderShipments.ledgerWithoutShippedStatus.length +
        orderShipments.quantityMismatch.length,
    },
    {
      key: 'materialConsumption',
      label: '④ レシピと資材消費の差異',
      count: materialConsumption.length,
    },
    {
      key: 'orphans',
      label: '⑤ 紐付け漏れ',
      count:
        orphans.bottlingWithoutTankLedger.length +
        orphans.completedDistillationWithoutFill.length +
        orphans.foreignKeyIssues.length,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    totalIssues: sections.reduce((sum, s) => sum + s.count, 0),
    sections,
    duplicates,
    negativeStock,
    orderShipments,
    materialConsumption,
    orphans,
    // 参考情報：受注にもサンプルにも紐付かない出荷は、移行した過去データでは
    // 珍しくない（6-3）。不整合とは別枠で件数だけ示す。
    unlinkedShipmentCount: orderShipments.unlinkedShipments.length,
  };
}

module.exports = { runAudit };
