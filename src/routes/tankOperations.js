// 容器移動・未納税移出（浄酎容器変動履歴への記録）

const express = require('express');
const { z } = require('zod');
const tankService = require('../services/tankService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const transferSchema = z.object({
  fromTankId: z.number().int().positive(),
  toTankId: z.number().int().positive(),
  quantityL: z.number().positive('移動量は0より大きい値で入力してください'),
  abv: z.number().optional(),
  txnDate: dateOnly.optional(),
  note: z.string().optional(),
});

const taxFreeSchema = z.object({
  fromTankId: z.number().int().positive(),
  quantityL: z.number().positive('移出量は0より大きい値で入力してください'),
  destination: z.string().min(1, '搬出先を入力してください'),
  abv: z.number().optional(),
  txnDate: dateOnly.optional(),
  note: z.string().optional(),
});

// 浄酎容器変動履歴の一覧（tankId指定でそのタンクの入出庫だけに絞れる）
router.get('/ledger', (req, res) => {
  res.json(
    tankService.listLedger({
      tankId: req.query.tankId ? Number(req.query.tankId) : undefined,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    })
  );
});

router.post('/transfer', validateRequest(transferSchema), (req, res, next) => {
  try {
    res.status(201).json(tankService.submitTankTransfer(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/tax-free-transfer', validateRequest(taxFreeSchema), (req, res, next) => {
  try {
    res.status(201).json(tankService.submitTaxFreeTransfer(req.body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
