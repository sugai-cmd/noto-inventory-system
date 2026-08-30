const express = require('express');
const { z } = require('zod');
const orderModel = require('../models/orderModel');
const orderService = require('../services/orderService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const createSchema = z.object({
  orderedOn: dateOnly,
  customerId: z.number().int().positive(),
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('本数は1以上で入力してください'),
  unitPrice: z.number().nonnegative().optional(),
  markupRate: z.number().positive().optional(),
  salesAmount: z.number().nonnegative().optional(),
  shippingFee: z.number().nonnegative().optional(),
  totalAmount: z.number().nonnegative().optional(),
  requestedDeliveryOn: dateOnly.optional(),
  invoicedOn: dateOnly.optional(),
  paymentDueOn: dateOnly.optional(),
  salesMethod: z.string().optional(),
  deliveryMethod: z.string().optional(),
  status: z.string().optional(),
  deliveryAddress: z.string().optional(),
  note: z.string().optional(),
});

const shipSchema = z.object({
  deliveredOn: dateOnly.optional(),
  note: z.string().optional(),
});

/**
 * 受注登録画面の初期値（2.3）。
 * 得意先・商品・本数を選んだ時点で、売価と入金予定日を先に返す。
 */
router.get('/defaults', (req, res) => {
  res.json(
    orderService.getOrderDefaults({
      customerId: req.query.customerId ? Number(req.query.customerId) : null,
      productId: req.query.productId ? Number(req.query.productId) : null,
      quantity: req.query.quantity,
      deliveredOn: req.query.deliveredOn,
    })
  );
});

router.get('/', (req, res) => {
  res.json(
    orderModel.list({
      status: req.query.status,
      customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
      from: req.query.from,
      to: req.query.to,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    })
  );
});

// 請求対象の候補（納品済みかつ未請求）
router.get('/pending-invoices', (req, res) => {
  res.json(orderService.listPendingInvoices({ to: req.query.to }));
});

router.get('/:id', (req, res) => {
  const order = orderModel.findById(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'not_found' });
  res.json(order);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(orderService.submitOrder(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

// 「発送済にする」。受注更新＋商品在庫変動履歴への出荷行追加を1トランザクションで行う。
router.post('/:id/ship', validateRequest(shipSchema), (req, res, next) => {
  try {
    res.json(orderService.markOrderAsShipped(Number(req.params.id), req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/invoice',
  validateRequest(z.object({ invoicedOn: dateOnly.optional() })),
  (req, res, next) => {
    try {
      res.json(orderService.markInvoiceSent(Number(req.params.id), req.body));
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/payment',
  validateRequest(z.object({ paidOn: dateOnly.optional() })),
  (req, res, next) => {
    try {
      res.json(orderService.markPaid(Number(req.params.id), req.body));
    } catch (err) {
      next(err);
    }
  }
);

// 請求日の一括記録（旧 markInvoicesSent）
router.post(
  '/invoices/bulk',
  validateRequest(
    z.object({
      orderIds: z.array(z.number().int().positive()).min(1, '対象の受注を選んでください'),
      invoicedOn: dateOnly.optional(),
    })
  ),
  (req, res, next) => {
    try {
      res.json(orderService.markInvoicesSent(req.body.orderIds, req.body, req.user));
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
