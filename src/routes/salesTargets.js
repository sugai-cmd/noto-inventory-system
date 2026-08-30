const express = require('express');
const { z } = require('zod');
const salesTargetService = require('../services/salesTargetService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const setSchema = z.object({
  targetMonth: z.string().regex(/^\d{4}-\d{2}$/, '対象月はYYYY-MM形式で入力してください'),
  targetAmount: z.number().nonnegative(),
  note: z.string().optional(),
});

/** 当月（または指定月）の売上目標に対する進捗 */
router.get('/progress', (req, res, next) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    res.json(salesTargetService.getMonthlyProgress(month));
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
