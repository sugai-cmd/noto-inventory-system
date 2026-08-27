// 原酒入荷（原料受払記録の「受入」）と、原酒タンクの残量参照。

const express = require('express');
const { z } = require('zod');
const distillationService = require('../services/distillationService');
const { getConnection } = require('../db/connection');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const receiptSchema = z.object({
  txnDate: dateOnly.optional(),
  toTankId: z.number().int().positive(),
  quantity: z.number().positive('受入量は0より大きい値で入力してください'),
  rawSakeBrandId: z.number().int().positive().optional(),
  // 8-2の通り酒蔵マスタとの紐付けは緩やかなので、受入元は自由記述も許容する
  supplier: z.string().optional(),
  specNote: z.string().optional(),
  note: z.string().optional(),
});

/**
 * 原酒タンクの残量一覧。v_tank_monitor（浄酎タンク）とは別集計になる点に注意（8-8）。
 */
router.get('/tanks', (req, res) => {
  const db = getConnection();
  res.json(
    db
      .prepare(
        `SELECT v.*, t.container_type, t.status
         FROM v_raw_sake_tank_volume v
         JOIN tanks t ON t.id = v.tank_id
         WHERE v.current_volume_l > 0 OR t.container_type LIKE '%原酒%'
         ORDER BY t.code`
      )
      .all()
  );
});

router.get('/', (req, res) => {
  const db = getConnection();
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(
    db
      .prepare(
        `SELECT l.*, ft.name AS from_tank_name, tt.name AS to_tank_name,
                b.name AS brand_name, d.distillation_code
         FROM raw_sake_ledger l
         LEFT JOIN tanks ft ON ft.id = l.from_tank_id
         LEFT JOIN tanks tt ON tt.id = l.to_tank_id
         LEFT JOIN raw_sake_brands b ON b.id = l.raw_sake_brand_id
         LEFT JOIN distillations d ON d.id = l.distillation_id
         ORDER BY l.txn_date DESC, l.id DESC
         LIMIT ?`
      )
      .all(limit)
  );
});

router.post('/', validateRequest(receiptSchema), (req, res, next) => {
  try {
    res.status(201).json(distillationService.submitRawSakeReceipt(req.body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
