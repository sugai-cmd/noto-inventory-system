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
    res.status(201).json(stocktakingService.submitProductStocktaking(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/materials', validateRequest(materialSchema), (req, res, next) => {
  try {
    res.status(201).json(stocktakingService.submitMaterialStocktaking(req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/tanks', validateRequest(tankSchema), (req, res, next) => {
  try {
    res.status(201).json(stocktakingService.submitTankStocktaking(req.body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
