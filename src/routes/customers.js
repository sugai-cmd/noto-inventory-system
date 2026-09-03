const express = require('express');
const { z } = require('zod');
const customerModel = require('../models/customerModel');
const customerNoteService = require('../services/customerNoteService');
const { validateRequest } = require('../middlewares/validateRequest');
const { getConnection } = require('../db/connection');
const { nextMasterCode } = require('../utils/masterCode');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');
const monthOnly = z.string().regex(/^\d{4}-\d{2}$/, '月はYYYY-MM形式で入力してください');

const createSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, '得意先名は必須です'),
  segment: z.string().optional(),
  businessType: z.string().optional(),
  markupRate: z.number().positive().optional(),
  address: z.string().optional(),
  paymentTermMonths: z.number().int().min(0).optional(),
  paymentTermDay: z.string().optional(),
  invoiceDueNote: z.string().optional(),
  salesRep: z.string().optional(),
  salesSubRep: z.string().optional(),
  salesChannel: z.string().optional(),
  lastVisitedOn: dateOnly.optional(),
  onboardedMonth: monthOnly.optional(),
  note: z.string().optional(),
});

const updateSchema = createSchema.partial();

// 受注登録画面のインクリメンタル検索（2.2）
router.get('/search', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json(customerModel.search(String(req.query.q ?? ''), limit));
});

/**
 * 新規登録の初期値になるコード（GAS版の「IDはすべて自動採番」に相当）。
 * プレフィックスと桁数は既存データから読み取るので、移行した過去データの
 * 採番の続きになる（例: C0035 まであれば C0036）。
 */
router.get('/next-code', (req, res) => {
  res.json(nextMasterCode(getConnection(), { table: 'customers', defaultPrefix: 'C' }));
});

router.get('/', (req, res) => {
  res.json(customerModel.list());
});

router.get('/:id', (req, res) => {
  const customer = customerModel.findById(Number(req.params.id));
  if (!customer) return res.status(404).json({ error: 'not_found' });
  res.json(customer);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(customerModel.create(req.body));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const updated = customerModel.update(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// 営業メモ（得意先ごとの追記ログ）
const noteSchema = z.object({
  notedOn: dateOnly.optional(),
  category: z.string().optional(),
  body: z.string().min(1, 'メモの内容を入力してください'),
});

router.get('/:id/notes', (req, res) => {
  res.json(customerNoteService.list(Number(req.params.id)));
});

router.post('/:id/notes', validateRequest(noteSchema), (req, res, next) => {
  try {
    res.status(201).json(
      customerNoteService.add({ customerId: Number(req.params.id), ...req.body }, req.user)
    );
  } catch (err) {
    next(err);
  }
});

router.delete('/notes/:noteId', (req, res) => {
  const deleted = customerNoteService.remove(Number(req.params.noteId));
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
