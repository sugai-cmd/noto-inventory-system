// 酒税（酒税申告用の月次算出）と、その税率マスタ。

const express = require('express');
const { z } = require('zod');
const liquorTaxService = require('../services/liquorTaxService');
const { validateRequest } = require('../middlewares/validateRequest');
const { currentMonth } = require('../utils/dateUtil');

const router = express.Router();

const rateSchema = z.object({
  category: z.string().min(1, '酒類区分を入力してください'),
  baseAbv: z.number().nonnegative('基準度数は0以上で入力してください'),
  baseYenPerKl: z.number().nonnegative('1klあたりの税額は0以上で入力してください'),
  stepYenPerKl: z.number().nonnegative().optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '適用開始日はYYYY-MM-DD形式で入力してください')
    .optional()
    .or(z.literal('')),
  note: z.string().optional(),
});

// --- 税率マスタ -----------------------------------------------------------

router.get('/rates', (req, res) => {
  res.json(liquorTaxService.listRates());
});

/** 商品マスタの「酒類区分」のプルダウン用 */
router.get('/categories', (req, res) => {
  res.json(liquorTaxService.listCategories());
});

router.post('/rates', validateRequest(rateSchema), (req, res, next) => {
  try {
    res.status(201).json(liquorTaxService.saveRate(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.delete('/rates/:id', (req, res, next) => {
  try {
    res.json(liquorTaxService.deleteRate(Number(req.params.id), req.user));
  } catch (err) {
    next(err);
  }
});

// --- 月次の酒税 -----------------------------------------------------------

/**
 * 対象月の酒税。
 *
 * 月の指定が無ければ**前月**。酒税の作業は月初に前月分を出すものなので、
 * 当月を既定にすると毎回選び直すことになる。
 */
router.get('/monthly', (req, res, next) => {
  try {
    const month = req.query.month || liquorTaxService.previousMonth(currentMonth());
    res.json(liquorTaxService.monthlyReport(String(month)));
  } catch (err) {
    next(err);
  }
});

// --- 過去分の課税額の入れ直し ---------------------------------------------

/**
 * 台帳の課税額を、いまの計算で入れ直す。
 * apply が無ければ**何件どう変わるかを返すだけ**（画面で見せてから確定させる）。
 */
router.post('/backfill', (req, res, next) => {
  try {
    res.json(liquorTaxService.backfillTaxAmounts({ apply: req.body?.apply === true }, req.user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
