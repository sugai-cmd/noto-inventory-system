const express = require('express');
const { z } = require('zod');
const salesTargetService = require('../services/salesTargetService');
const { validateRequest } = require('../middlewares/validateRequest');
const { currentMonth } = require('../utils/dateUtil');

const router = express.Router();

const setSchema = z.object({
  targetMonth: z.string().regex(/^\d{4}-\d{2}$/, '対象月はYYYY-MM形式で入力してください'),
  targetAmount: z.number().nonnegative(),
  note: z.string().optional(),
});

/**
 * 当月（または指定月）の売上目標に対する進捗。
 *
 * basis で実績を数える日付を選べる（delivered / ordered / payment_due）。
 * 知らない値が来ても落とさず、既定の納品日で返す（サービス側の許可リストで弾く）。
 */
router.get('/progress', (req, res, next) => {
  try {
    // toISOString() はUTC。日本時間の1日 朝9時前に開くと**前月**を出していた
    const month = req.query.month || currentMonth();
    res.json(salesTargetService.getMonthlyProgress(month, { basis: req.query.basis }));
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res) => {
  res.json(salesTargetService.list({ limit: Math.min(Number(req.query.limit) || 24, 120) }));
});

router.post('/', validateRequest(setSchema), (req, res, next) => {
  try {
    res.status(201).json(salesTargetService.setSalesTarget(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
