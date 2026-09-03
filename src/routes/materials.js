const express = require('express');
const { z } = require('zod');
const materialService = require('../services/materialService');
const { getConnection } = require('../db/connection');
const { validateRequest } = require('../middlewares/validateRequest');
const { nextMasterCode } = require('../utils/masterCode');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const receiptSchema = z.object({
  materialId: z.number().int().positive(),
  quantity: z.number().positive('入荷数は0より大きい値で入力してください'),
  unitPrice: z.number().nonnegative().optional(),
  totalPrice: z.number().nonnegative().optional(),
  supplier: z.string().optional(),
  txnDate: dateOnly.optional(),
  note: z.string().optional(),
});

const createSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, '資材名は必須です'),
  category: z.string().optional(),
  unit: z.string().optional(),
  unitPrice: z.number().nonnegative().optional(),
  lotSize: z.number().int().positive().optional(),
  properStockQty: z.number().nonnegative().optional(),
  initialStock: z.number().nonnegative().optional(),
  supplierName: z.string().optional(),
  supplierAddress: z.string().optional(),
  supplierContact: z.string().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});

const updateSchema = createSchema.partial();

/**
 * 資材在庫モニター（DB_SCHEMA_DESIGN.md 7-1で新設した v_material_stock）。
 * 現行スプレッドシートには存在しなかった「資材の現在庫数」がここで一覧できる。
 */
/**
 * 新規登録の初期値になるコード（既存データの採番の続き）。
 * '/:id' より前に置く（後ろだと id として拾われてしまう）。
 */
router.get('/next-code', (req, res) => {
  res.json(nextMasterCode(getConnection(), { table: 'materials', defaultPrefix: 'M' }));
});

router.get('/stock', (req, res) => {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT s.material_id, s.name, s.current_stock,
              m.unit, m.proper_stock_qty, m.lot_size, m.supplier_name, m.lead_time_days
       FROM v_material_stock s
       JOIN materials m ON m.id = s.material_id
       ORDER BY s.name`
    )
    .all();

  res.json(
    rows.map((r) => ({
      ...r,
      shortage: r.proper_stock_qty != null && r.current_stock < r.proper_stock_qty,
    }))
  );
});

/** 入荷画面で単価・ロット数を自動表示するための情報（旧 getMaterialDefaultPrice） */
router.get('/:id/receipt-defaults', (req, res, next) => {
  try {
    res.json(materialService.getReceiptDefaults(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/** 資材の入出庫履歴 */
router.get('/ledger', (req, res) => {
  res.json(
    materialService.listLedger({
      materialId: req.query.materialId ? Number(req.query.materialId) : undefined,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    })
  );
});

router.get('/', (req, res) => {
  const db = getConnection();
  res.json(db.prepare('SELECT * FROM materials ORDER BY name').all());
});

router.get('/:id', (req, res) => {
  const material = materialService.findById(Number(req.params.id));
  if (!material) return res.status(404).json({ error: 'not_found' });
  res.json(material);
});

// 資材入荷。これまで消費しか記録できず在庫を増やせなかった分を補う。
router.post('/receipts', validateRequest(receiptSchema), (req, res, next) => {
  try {
    res.status(201).json(materialService.submitMaterialReceipt(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(materialService.createMaterial(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const updated = materialService.updateMaterial(Number(req.params.id), req.body, req.user);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
