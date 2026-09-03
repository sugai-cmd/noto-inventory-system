// 酒蔵マスタ API（8-2参照：移行対象外のため、このAPI経由での手動登録が主な入力経路になる）

const express = require('express');
const { z } = require('zod');
const breweryModel = require('../models/breweryModel');
const { validateRequest } = require('../middlewares/validateRequest');
const { getConnection } = require('../db/connection');
const { nextMasterCode } = require('../utils/masterCode');

const router = express.Router();

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const createSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, '酒蔵名は必須です'),
  address: z.string().optional(),
  phone: z.string().optional(),
  contact: z.string().optional(),
  startedOn: dateOnly.optional(),
});

const updateSchema = createSchema.partial();

/** 新規登録の初期値になるコード（既存データの採番の続き） */
router.get('/next-code', (req, res) => {
  res.json(nextMasterCode(getConnection(), { table: 'breweries', defaultPrefix: 'B' }));
});

router.get('/', (req, res) => {
  res.json(breweryModel.list());
});

router.get('/:id', (req, res) => {
  const brewery = breweryModel.findById(Number(req.params.id));
  if (!brewery) return res.status(404).json({ error: 'not_found' });
  res.json(brewery);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(breweryModel.create(req.body));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const updated = breweryModel.update(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const deleted = breweryModel.remove(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
