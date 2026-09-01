// 資材まわりの業務ロジック（旧GASの submitMaterialReceipt / getMaterialDefaultPrice 相当）。
//
// これまで資材は瓶詰め・箱詰めによる「消費」しか記録されず、入荷で増やす手段がなかった。
// 資材マスタの登録・編集もここで扱う。

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { nextMaterialHistoryCode } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

/**
 * 資材入荷。仕入れた資材を在庫に加える。
 *
 * 資材マスタに「ロット数」が設定されている場合、その倍数でのみ受け入れる
 * （DATA_STRUCTURE.md 4-18 F列「この数の倍数でのみ入荷登録できる」）。
 */
function submitMaterialReceipt(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(input.materialId);
    if (!material) throw new NotFoundError(`資材が見つかりません (id=${input.materialId})`);

    if (material.lot_size && input.quantity % material.lot_size !== 0) {
      throw new BusinessRuleError(
        `${material.name} は${material.lot_size}${material.unit ?? ''}単位でのみ入荷できます（指定: ${input.quantity}）`
      );
    }

    // 単価の指定がなければ資材マスタの基準単価を使う
    const unitPrice = input.unitPrice ?? material.unit_price ?? null;
    const totalPrice =
      input.totalPrice ?? (unitPrice != null ? unitPrice * input.quantity : null);

    const result = db
      .prepare(
        `INSERT INTO material_stock_ledger
           (history_code, txn_date, material_id, txn_type, quantity, counterparty,
            unit_price, total_price, data_kind, note, created_by)
         VALUES
           (@historyCode, @txnDate, @materialId, '入荷', @quantity, @counterparty,
            @unitPrice, @totalPrice, '運用中（リアルタイム）', @note, @createdBy)`
      )
      .run({
        historyCode: nextMaterialHistoryCode(db, txnDate),
        txnDate,
        materialId: input.materialId,
        quantity: input.quantity,
        counterparty: input.supplier ?? material.supplier_name ?? null,
        unitPrice,
        totalPrice,
        note: input.note ?? null,
        createdBy: actor?.id ?? null,
      });

    const after = db
      .prepare('SELECT * FROM v_material_stock WHERE material_id = ?')
      .get(input.materialId);

    operationLogService.record({
      user: actor,
      action: 'material.receipt',
      targetType: 'material_stock_ledger',
      targetId: result.lastInsertRowid,
      summary: `${material.name} を ${input.quantity}${material.unit ?? ''} 入荷（在庫 ${after.current_stock}）`,
    });

    return { ledgerId: result.lastInsertRowid, material: pick(material), after };
  });

  return run();
}

/** 入荷画面で単価・ロット数を自動表示するための情報（旧 getMaterialDefaultPrice） */
function getReceiptDefaults(materialId) {
  const db = getConnection();
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
  if (!material) throw new NotFoundError(`資材が見つかりません (id=${materialId})`);

  const stock = db.prepare('SELECT * FROM v_material_stock WHERE material_id = ?').get(materialId);

  return {
    material: pick(material),
    unitPrice: material.unit_price,
    lotSize: material.lot_size,
    unit: material.unit,
    supplierName: material.supplier_name,
    leadTimeDays: material.lead_time_days,
    currentStock: stock?.current_stock ?? 0,
    properStockQty: material.proper_stock_qty,
  };
}

function createMaterial(input, actor = null) {
  const db = getConnection();

  const name = (input.name ?? '').trim();
  if (!name) throw new BusinessRuleError('資材名を入力してください');
  if (db.prepare('SELECT id FROM materials WHERE name = ?').get(name)) {
    throw new BusinessRuleError(`資材「${name}」は既に登録されています`);
  }

  const result = db
    .prepare(
      `INSERT INTO materials
         (uid, code, name, category, unit, unit_price, lot_size, proper_stock_qty,
          initial_stock, supplier_name, supplier_address, supplier_contact, lead_time_days, note)
       VALUES
         (@uid, @code, @name, @category, @unit, @unitPrice, @lotSize, @properStockQty,
          @initialStock, @supplierName, @supplierAddress, @supplierContact, @leadTimeDays, @note)`
    )
    .run({
      uid: generateUid(db, 'materials'),
      code: input.code ?? null,
      name,
      category: input.category ?? null,
      unit: input.unit ?? null,
      unitPrice: input.unitPrice ?? null,
      lotSize: input.lotSize ?? null,
      properStockQty: input.properStockQty ?? null,
      initialStock: input.initialStock ?? 0,
      supplierName: input.supplierName ?? null,
      supplierAddress: input.supplierAddress ?? null,
      supplierContact: input.supplierContact ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      note: input.note ?? null,
    });

  operationLogService.record({
    user: actor,
    action: 'material.create',
    targetType: 'materials',
    targetId: result.lastInsertRowid,
    summary: `資材「${name}」を登録`,
  });

  return findById(result.lastInsertRowid);
}

function updateMaterial(id, input, actor = null) {
  const db = getConnection();
  if (!findById(id)) return null;

  db.prepare(
    `UPDATE materials SET
       code = COALESCE(@code, code),
       name = COALESCE(@name, name),
       category = COALESCE(@category, category),
       unit = COALESCE(@unit, unit),
       unit_price = COALESCE(@unitPrice, unit_price),
       lot_size = COALESCE(@lotSize, lot_size),
       proper_stock_qty = COALESCE(@properStockQty, proper_stock_qty),
       supplier_name = COALESCE(@supplierName, supplier_name),
       supplier_address = COALESCE(@supplierAddress, supplier_address),
       supplier_contact = COALESCE(@supplierContact, supplier_contact),
       lead_time_days = COALESCE(@leadTimeDays, lead_time_days),
       note = COALESCE(@note, note),
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    code: input.code ?? null,
    name: input.name ?? null,
    category: input.category ?? null,
    unit: input.unit ?? null,
    unitPrice: input.unitPrice ?? null,
    lotSize: input.lotSize ?? null,
    properStockQty: input.properStockQty ?? null,
    supplierName: input.supplierName ?? null,
    supplierAddress: input.supplierAddress ?? null,
    supplierContact: input.supplierContact ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    note: input.note ?? null,
  });

  operationLogService.record({
    user: actor,
    action: 'material.update',
    targetType: 'materials',
    targetId: id,
    summary: `資材（id=${id}）を編集`,
  });

  return findById(id);
}

/** 資材の入出庫履歴 */
function listLedger({ materialId, limit = 200 } = {}) {
  const db = getConnection();
  const where = materialId ? 'WHERE l.material_id = @materialId' : '';
  return db
    .prepare(
      `SELECT l.*, m.name AS material_name, m.unit
       FROM material_stock_ledger l
       JOIN materials m ON m.id = l.material_id
       ${where}
       ORDER BY l.txn_date DESC, l.id DESC
       LIMIT @limit`
    )
    .all({ materialId, limit });
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
}

function pick(material) {
  return { id: material.id, name: material.name, unit: material.unit };
}

module.exports = {
  submitMaterialReceipt,
  getReceiptDefaults,
  createMaterial,
  updateMaterial,
  listLedger,
  findById,
};
