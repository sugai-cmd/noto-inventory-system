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

// 絞り込みのプルダウンに出す値（実データにあるものだけ）。
// `/ledger/:何か` より先に置かないと、`/ledger` のあとに付く語として拾われる
router.get('/ledger/options', (req, res) => {
  res.json(tankService.listLedgerFilterOptions());
});

/** 浄酎容器変動履歴の一覧。`{rows, total}` を返す（total は同じ絞り込みでの全件数） */
router.get('/ledger', (req, res) => {
  const q = req.query;
  res.json(
    tankService.listLedger({
      tankId: q.tankId ? Number(q.tankId) : undefined,
      txnType: q.txnType || undefined,
      // '' は「指定なし」。'0' を false と読み違えないよう三値で扱う
      cancelled: q.cancelled === '' || q.cancelled === undefined ? null : q.cancelled === '1',
      from: q.from || undefined,
      to: q.to || undefined,
      limit: Math.min(Number(q.limit) || 200, 1000),
      offset: Math.max(Number(q.offset) || 0, 0),
      sort: q.sort || undefined,
      order: q.order || undefined,
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
