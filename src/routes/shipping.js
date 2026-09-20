// 送料計算とそのマスタ（地帯／段ボール対応表／料金表）。

const express = require('express');
const { z } = require('zod');
const shippingFeeService = require('../services/shippingFeeService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const quoteSchema = z.object({
  address: z.string().optional(),
  prefecture: z.string().optional(),
  cartonSize: z.string().optional(),
  items: z
    .array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().positive() }))
    .default([]),
});

const cartonRuleSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive(),
  cartonSize: z.string().min(1, '段ボールを指定してください'),
  // 呼び名（300ml12本用 等）と、実際に減らす段ボールの資材。
  // 資材が入っていないと、出荷のときに推奨が出ない（手で選べば減算はできる）
  boxName: z.string().optional(),
  materialId: z.number().int().positive().nullable().optional(),
  note: z.string().optional(),
});

const rateSchema = z.object({
  zone: z.string().min(1),
  cartonSize: z.string().min(1),
  fee: z.number().nonnegative(),
});

const zonesSchema = z.object({
  zones: z.array(z.object({ prefecture: z.string(), zone: z.string().nullable().optional() })),
});

router.post('/quote', validateRequest(quoteSchema), (req, res, next) => {
  try {
    res.json(shippingFeeService.quote(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/zones', (req, res) => res.json(shippingFeeService.listZones()));

router.put('/zones', validateRequest(zonesSchema), (req, res, next) => {
  try {
    res.json(shippingFeeService.setZones(req.body.zones));
  } catch (err) {
    next(err);
  }
});

router.get('/carton-rules', (req, res) => res.json(shippingFeeService.listCartonRules()));

// 対応表と発送画面で選べる段ボール（資材の分類が「外箱」のものだけ）
router.get('/carton-materials', (req, res) =>
  res.json(shippingFeeService.listCartonMaterials()));

router.post('/carton-rules', validateRequest(cartonRuleSchema), (req, res, next) => {
  try {
    res.status(201).json(shippingFeeService.upsertCartonRule(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.delete('/carton-rules/:id', (req, res) => {
  const deleted = shippingFeeService.deleteCartonRule(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

router.get('/rates', (req, res) => res.json(shippingFeeService.listRates()));

router.post('/rates', validateRequest(rateSchema), (req, res, next) => {
  try {
    res.status(201).json(shippingFeeService.upsertRate(req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/rates/:id', (req, res) => {
  const deleted = shippingFeeService.deleteRate(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
