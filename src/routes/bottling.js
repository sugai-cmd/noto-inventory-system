const express = require('express');
const wipLotService = require('../services/wipLotService');
const { z } = require('zod');
const bottlingService = require('../services/bottlingService');
const { getConnection } = require('../db/connection');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

const bottlingSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('本数は1以上で入力してください'),
  tankId: z.number().int().positive(),
  volumeL: z.number().positive('数量(L)は0より大きい値で入力してください'),
  abv: z.number().optional(),
  txnDate: dateOnly.optional(),
  storagePlace: z.string().optional(),
  note: z.string().optional(),
});

const boxingSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive('本数は1以上で入力してください'),
  // 引き当てたいロット（瓶詰めの台帳ID）。足りない分は古いロットから自動で補う。
  // 未指定なら古い順（FIFO）。
  lotLedgerId: z.number().int().positive().optional(),
  txnDate: dateOnly.optional(),
  storagePlace: z.string().optional(),
  note: z.string().optional(),
});

// 瓶詰め登録：商品在庫・資材消費・タンク払出を1トランザクションで記録
router.post('/bottling', validateRequest(bottlingSchema), (req, res, next) => {
  try {
    res.status(201).json(bottlingService.submitBottling(req.body));
  } catch (err) {
    next(err);
  }
});

// 箱詰め登録：仕掛品→商品への振替＋資材消費
router.post('/boxing', validateRequest(boxingSchema), (req, res, next) => {
  try {
    res.status(201).json(bottlingService.submitBoxing(req.body));
  } catch (err) {
    next(err);
  }
});

// 瓶詰め/箱詰め画面で「この商品は何をどれだけ消費するか」を事前表示するため
router.get('/recipe/:productId', (req, res) => {
  const db = getConnection();
  const productId = Number(req.params.productId);
  res.json({
    瓶詰: bottlingService.getRecipe(db, productId, '瓶詰'),
    箱詰: bottlingService.getRecipe(db, productId, '箱詰'),
  });
});

/** 箱詰め画面のロット一覧（残量つき、古い順） */
router.get('/wip-lots', (req, res) => {
  res.json(wipLotService.listLots(req.query.productId ? Number(req.query.productId) : null));
});

/** 仕掛品滞留アラート（既定は瓶詰めから7日以上） */
router.get('/wip-lots/stale', (req, res) => {
  const thresholdDays = Number(req.query.days) || 7;
  res.json(wipLotService.listStaleLots({ thresholdDays }));
});

module.exports = router;
