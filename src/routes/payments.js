// 入金の消し込み（通帳の入金 → 請求への割り当て）。

const express = require('express');
const { z } = require('zod');
const paymentService = require('../services/paymentService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const createSchema = z.object({
  paidOn: dateOnly.optional(),
  customerId: z.number().int().positive().optional(),
  amount: z.number().positive('入金額は0より大きい金額で入力してください'),
  payerName: z.string().optional(),
  note: z.string().optional(),
});

// 割り当ては丸ごと入れ直す（製品レシピの差し替えと同じ作法）
const allocateSchema = z.object({
  items: z.array(
    z.object({
      orderNo: z.string().optional(),
      consignmentReportId: z.number().int().positive().optional(),
      amount: z.number().positive(),
      kind: z.enum(['入金', '端数']).optional(),
      note: z.string().optional(),
    })
  ),
});

const settleSchema = z.object({
  orderNo: z.string().optional(),
  consignmentReportId: z.number().int().positive().optional(),
  note: z.string().trim().min(1, '端数の理由は必須です'),
});

/** 消し込みの候補（残額が残っている請求）。'/:id' より前に置く */
router.get('/open-invoices', (req, res, next) => {
  try {
    res.json(
      paymentService.listOpenInvoices({
        customerId: req.query.customerId ? Number(req.query.customerId) : null,
        includeUnbilled: req.query.includeUnbilled === '1',
        limit: Math.min(Number(req.query.limit) || 200, 1000),
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res) => {
  const q = req.query;
  res.json(
    paymentService.listPayments({
      limit: Math.min(Number(q.limit) || 100, 1000),
      offset: Math.max(Number(q.offset) || 0, 0),
      sort: q.sort || undefined,
      order: q.order || undefined,
      customerId: q.customerId ? Number(q.customerId) : null,
      from: q.from || null,
      to: q.to || null,
      includeCancelled: q.includeCancelled === '1',
      unallocatedOnly: q.unallocatedOnly === '1',
    })
  );
});

router.get('/:id', (req, res) => {
  const payment = paymentService.findById(Number(req.params.id));
  if (!payment) return res.status(404).json({ error: 'not_found' });
  res.json(payment);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(paymentService.recordPayment(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

/** 消し込みの内容を差し替える */
router.put('/:id/allocations', validateRequest(allocateSchema), (req, res, next) => {
  try {
    res.json(paymentService.allocate(Number(req.params.id), req.body.items, req.user));
  } catch (err) {
    next(err);
  }
});

/** 残額を端数（振込手数料・値引きなど）として締める */
router.post('/:id/settle', validateRequest(settleSchema), (req, res, next) => {
  try {
    res.json(paymentService.settleRemainder(Number(req.params.id), req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/cancel',
  validateRequest(z.object({ reason: z.string().trim().min(1, '取消理由は必須です') })),
  (req, res, next) => {
    try {
      res.json(paymentService.cancelPayment(Number(req.params.id), req.body, req.user));
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
