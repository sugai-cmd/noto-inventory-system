const express = require('express');
const { z } = require('zod');
const productModel = require('../models/productModel');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const createSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, '商品名称は必須です'),
  volumeMl: z.number().int().positive().optional(),
  abv: z.number().optional(),
  containerType: z.string().optional(),
  unit: z.string().optional(),
  listPrice: z.number().nonnegative().optional(),
  janCode: z.string().optional(),
  targetExtractSpec: z.string().optional(),
  category: z.string().optional(),
  taxPerUnit: z.number().nonnegative().optional(),
  initialProductStock: z.number().int().optional(),
  initialWipStock: z.number().int().optional(),
  note: z.string().optional(),
});

// 受注登録・瓶詰め画面のインクリメンタル検索（2.2）
router.get('/search', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json(productModel.search(String(req.query.q ?? ''), limit));
});

// 商品在庫モニター相当（3章 v_product_stock）
router.get('/stock', (req, res) => {
  res.json(productModel.stockAll());
});

router.get('/', (req, res) => {
  res.json(productModel.list());
});

router.get('/:id', (req, res) => {
  const product = productModel.findById(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'not_found' });
  res.json(product);
});

router.get('/:id/stock', (req, res) => {
  const stock = productModel.stockByProductId(Number(req.params.id));
  if (!stock) return res.status(404).json({ error: 'not_found' });
  res.json(stock);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(productModel.create(req.body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
