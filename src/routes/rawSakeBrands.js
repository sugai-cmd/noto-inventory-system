// 原酒マスタ API（8-2参照：酒蔵マスタとの紐付けは緩やか。移行対象外のため
// このAPI経由での手動登録が主な入力経路になる）

const express = require('express');
const { z } = require('zod');
const rawSakeBrandModel = require('../models/rawSakeBrandModel');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const createSchema = z
  .object({
    name: z.string().min(1, '銘柄名は必須です'),
    abv: z.number().optional(),
    sakeMeterValue: z.number().optional(),
    breweryId: z.number().int().positive().optional(),
    breweryName: z.string().optional(), // 既存酒蔵名と不一致ならbrewery_name_rawに退避
    status: z.string().optional(),
    producedOn: z.string().optional(), // 和暦等の自由記述を許容するためCHECKなし（DDL通り）
    note: z.string().optional(),
    registeredOn: dateOnly.optional(),
    initialStock: z.number().nonnegative().optional(),
  })
  .refine((v) => !(v.breweryId && v.breweryName), {
    message: 'breweryIdとbreweryNameは同時に指定できません',
  });

// createSchemaは.refine()を通したZodEffectsで.partial()が使えないため、
// updateSchemaは同じ形を独立して定義する（同時指定不可のrefineも引き継ぐ）
const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    abv: z.number().optional(),
    sakeMeterValue: z.number().optional(),
    breweryId: z.number().int().positive().optional(),
    breweryName: z.string().optional(),
    status: z.string().optional(),
    producedOn: z.string().optional(),
    note: z.string().optional(),
    registeredOn: dateOnly.optional(),
  })
  .refine((v) => !(v.breweryId && v.breweryName), {
    message: 'breweryIdとbreweryNameは同時に指定できません',
  });

router.get('/', (req, res) => {
  res.json(rawSakeBrandModel.list());
});

router.get('/:id', (req, res) => {
  const brand = rawSakeBrandModel.findById(Number(req.params.id));
  if (!brand) return res.status(404).json({ error: 'not_found' });
  res.json(brand);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(rawSakeBrandModel.create(req.body));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const updated = rawSakeBrandModel.update(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const deleted = rawSakeBrandModel.remove(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
