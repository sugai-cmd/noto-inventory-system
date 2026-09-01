const express = require('express');
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

module.exports = router;
