const express = require('express');
const { z } = require('zod');
const stocktakingService = require('../services/stocktakingService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const productSchema = z
  .object({
    productId: z.number().int().positive(),
    actualProductStock: z.number().int().nonnegative().optional(),
    actualWipStock: z.number().int().nonnegative().optional(),
    txnDate: dateOnly.optional(),
    storagePlace: z.string().optional(),
    reason: z.string().optional(),
  })
  .refine((v) => v.actualProductStock != null || v.actualWipStock != null, {
    message: '商品または仕掛品の実測値を入力してください',
  });

const materialSchema = z.object({
  materialId: z.number().int().positive(),
  actualStock: z.number().nonnegative(),
  txnDate: dateOnly.optional(),
  reason: z.string().optional(),
});

const tankSchema = z.object({
  tankId: z.number().int().positive(),
  actualVolumeL: z.number().nonnegative(),
  abv: z.number().optional(),
  txnDate: dateOnly.optional(),
  reason: z.string().optional(),
});

router.post('/products', validateRequest(productSchema), (req, res, next) => {
  try {
    res.status(201).json(stocktakingService.submitProductStocktaking(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/materials', validateRequest(materialSchema), (req, res, next) => {
  try {
    res.status(201).json(stocktakingService.submitMaterialStocktaking(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

/**
 * 原酒タンクの棚卸。tankSchema を写しているが、**度数の欄は無い**。
 * raw_sake_ledger に abv 列が無く、原酒は銘柄とスペックで管理しているため。
 */
const rawSakeTankSchema = z
  .object({
    tankId: z.number().int().positive(),
    actualVolumeL: z.number().nonnegative(),
    txnDate: dateOnly.optional(),
    reason: z.string().optional(),
  })
  .strict(); // 度数を送られても黙って捨てない。この台帳は度数を持たない

router.post('/raw-sake-tanks', validateRequest(rawSakeTankSchema), (req, res, next) => {
  try {
    res.status(201).json(stocktakingService.submitRawSakeStocktaking(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/tanks', validateRequest(tankSchema), (req, res, next) => {
  try {
    res.status(201).json(stocktakingService.submitTankStocktaking(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
