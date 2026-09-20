const express = require('express');
const { z } = require('zod');
const orderModel = require('../models/orderModel');
const orderService = require('../services/orderService');
const shippingFeeService = require('../services/shippingFeeService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

// 1受注で複数商品を頼まれた場合は items に明細を並べる（同じ受注番号で複数行になる）。
// 単品のときは従来どおり productId / quantity を直接渡せる。
const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('本数は1以上で入力してください'),
  unitPrice: z.number().nonnegative().optional(),
  salesAmount: z.number().nonnegative().optional(),
});

const createSchema = z
  .object({
  orderedOn: dateOnly,
  customerId: z.number().int().positive(),
  productId: z.number().int().positive().optional(),
  quantity: z.number().int().positive('本数は1以上で入力してください').optional(),
  items: z.array(itemSchema).min(1).optional(),
  shippingZone: z.string().optional(),
  cartonSize: z.string().optional(),
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
  })
  .refine((v) => (v.items && v.items.length) || (v.productId && v.quantity), {
    message: '商品と本数、または明細（items）を指定してください',
  });

// 出荷に使った段ボール。画面で選ぶので任意。
// 空で来たら減らさない（対応表に無い／複数明細／委託生産料のような物でない商品）。
const cartonSchema = z.object({
  materialId: z.number().int().positive(),
  quantity: z.number().int().positive('箱数は1以上で入力してください'),
});

const shipSchema = z.object({
  deliveredOn: dateOnly.optional(),
  note: z.string().optional(),
  cartons: z.array(cartonSchema).optional(),
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

/** 受注の一覧。`{rows, total}` を返す（total は同じ絞り込みでの全件数） */
router.get('/', (req, res) => {
  const q = req.query;
  res.json(
    orderModel.list({
      status: q.status,
      customerId: q.customerId ? Number(q.customerId) : undefined,
      productId: q.productId ? Number(q.productId) : undefined,
      from: q.from,
      to: q.to,
      dateField: q.dateField || undefined,
      limit: Math.min(Number(q.limit) || 200, 1000),
      offset: Math.max(Number(q.offset) || 0, 0),
      sort: q.sort || undefined,
      order: q.order || undefined,
    })
  );
});

// 請求対象の候補（納品済みかつ未請求）
router.get('/pending-invoices', (req, res) => {
  res.json(orderService.listPendingInvoices({ to: req.query.to }));
});

/**
 * 発送画面に出す段ボールの推奨と選択肢。
 * 推奨はあくまで推奨で、実際に使うものは画面で選ぶ。
 */
router.get('/:id/carton-suggestion', (req, res, next) => {
  try {
    const order = orderModel.findById(Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'not_found' });
    const { suggestion, reason } = shippingFeeService.suggestCartons({
      productId: order.product_id,
      quantity: order.quantity,
      orderId: order.id,
    });
    res.json({ suggestion, reason, options: shippingFeeService.listCartonMaterials() });
  } catch (err) {
    next(err);
  }
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

// 受注の訂正（受注一覧の「編集」）。
// 日付は空文字を「消す」意味として受け取る（間違えて入れた日付を消せないと直せないため）。
const editableDate = z.union([dateOnly, z.literal('')]);

const updateSchema = z.object({
  orderedOn: dateOnly.optional(),
  requestedDeliveryOn: editableDate.optional(),
  deliveredOn: editableDate.optional(),
  invoicedOn: editableDate.optional(),
  paymentDueOn: editableDate.optional(),
  paidOn: editableDate.optional(),
  quantity: z.number().int().positive('本数は1以上で入力してください').optional(),
  unitPrice: z.number().nonnegative().optional(),
  markupRate: z.number().positive().optional(),
  shippingFee: z.number().nonnegative().optional(),
  status: z.string().optional(),
  salesMethod: z.string().optional(),
  deliveryMethod: z.string().optional(),
  deliveryAddress: z.string().optional(),
  note: z.string().optional(),
});

router.patch('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    res.json(orderService.updateOrder(Number(req.params.id), req.body, req.user));
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
