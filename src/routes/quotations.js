// 見積管理（シート「見積済み」相当）。

const express = require('express');
const { z } = require('zod');
const quotationService = require('../services/quotationService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const createSchema = z.object({
  quotedOn: dateOnly,
  customerId: z.number().int().positive(),
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('個数は1以上で入力してください'),
  unitPrice: z.number().nonnegative().optional(),
  costPrice: z.number().nonnegative().optional(),
  markupRate: z.number().positive().optional(),
  // 確度は0〜1で持つ（シートは80%表記なので画面側で割る）
  probability: z.number().min(0).max(1).optional(),
  deliveryDueOn: dateOnly.optional(),
  status: z.enum(['見積中', '受注', '失注']).optional(),
  note: z.string().optional(),
});

const updateSchema = createSchema.partial().extend({ orderNo: z.string().optional() });

router.get('/summary', (req, res) => {
  res.json(quotationService.summary({ from: req.query.from, to: req.query.to }));
});

router.get('/', (req, res) => {
  res.json(
    quotationService.list({
      status: req.query.status,
      customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
      from: req.query.from,
      to: req.query.to,
    })
  );
});

router.get('/:id', (req, res) => {
  const row = quotationService.findById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(quotationService.create(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const updated = quotationService.update(Number(req.params.id), req.body, req.user);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const deleted = quotationService.remove(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
