// 返品・サンプル送付・委託販売実績報告

const express = require('express');
const { z } = require('zod');
const shipmentService = require('../services/shipmentService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');
const monthOnly = z.string().regex(/^\d{4}-\d{2}$/, '対象月はYYYY-MM形式で入力してください');

const returnSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('返品数は1以上で入力してください'),
  orderId: z.number().int().positive().optional(),
  customerId: z.number().int().positive().optional(),
  counterparty: z.string().optional(),
  reason: z.string().optional(),
  txnDate: dateOnly.optional(),
  storagePlace: z.string().optional(),
  note: z.string().optional(),
});

const sampleSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('本数は1以上で入力してください'),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().optional(),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  shippedOn: dateOnly.optional(),
  followupOn: dateOnly.optional(),
  // 区分の一覧は shipmentService が持つ。ここで書き写さない
  purpose: z.string().optional(),
  note: z.string().optional(),
});

/** 区分だけを直す。数量・商品・日付は送れない（在庫と酒税が動くため） */
const purposeSchema = z
  .object({ purpose: z.string().min(1, '区分は必須です') })
  .strict();

const consignmentSchema = z.object({
  orderId: z.number().int().positive(),
  reportMonth: monthOnly,
  quantity: z.number().int().positive('実売本数は1以上で入力してください'),
  unitPrice: z.number().nonnegative().optional(),
  markupRate: z.number().positive().optional(),
  salesAmount: z.number().nonnegative().optional(),
  shippingFee: z.number().nonnegative().optional(),
  invoicedOn: dateOnly.optional(),
  note: z.string().optional(),
});

// --- 返品 ---
router.post('/returns', validateRequest(returnSchema), (req, res, next) => {
  try {
    res.status(201).json(shipmentService.submitProductReturn(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

// --- 無償出荷（サンプル・再発送・販促） ---

/** 選べる区分の一覧（画面のプルダウン用） */
router.get('/samples/purposes', (req, res) => {
  res.json({
    purposes: shipmentService.SHIPMENT_PURPOSES,
    default: shipmentService.DEFAULT_SHIPMENT_PURPOSE,
  });
});

/** 無償出荷の一覧。`{rows, total}` を返す（total は同じ絞り込みでの全件数） */
router.get('/samples', (req, res) => {
  const q = req.query;
  res.json(
    shipmentService.listSampleShipments({
      customer: q.customer || undefined,
      contact: q.contact || undefined,
      purpose: q.purpose || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: Math.min(Number(q.limit) || 200, 1000),
      offset: Math.max(Number(q.offset) || 0, 0),
      sort: q.sort || undefined,
      order: q.order || undefined,
    })
  );
});

router.post('/samples', validateRequest(sampleSchema), (req, res, next) => {
  try {
    res.status(201).json(shipmentService.submitSampleShipment(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

/** 区分をあとから直す */
router.patch('/samples/:id', validateRequest(purposeSchema), (req, res, next) => {
  try {
    res.json(
      shipmentService.updateSampleShipmentPurpose(
        Number(req.params.id),
        req.body.purpose,
        req.user
      )
    );
  } catch (err) {
    next(err);
  }
});

// --- 委託販売実績報告 ---

/** まだ報告しきっていない委託受注（画面のプルダウン用） */
router.get('/consignment/pending', (req, res) => {
  res.json(shipmentService.listPendingConsignmentOrders());
});

router.get('/consignment', (req, res) => {
  res.json(
    shipmentService.listConsignmentReports({
      reportMonth: req.query.reportMonth,
      customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    })
  );
});

router.post('/consignment', validateRequest(consignmentSchema), (req, res, next) => {
  try {
    res.status(201).json(shipmentService.submitConsignmentReport(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
