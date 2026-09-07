const express = require('express');
const { z } = require('zod');
const customerModel = require('../models/customerModel');
const customerNoteService = require('../services/customerNoteService');
const { validateRequest } = require('../middlewares/validateRequest');
const { getConnection } = require('../db/connection');
const { nextMasterCode } = require('../utils/masterCode');
const customerService = require('../services/customerService');

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
  // 本店。支店の得意先がこれを指すと、空欄の請求まわりの値を本店から引き継ぐ。
  // 空文字を送れば本店を外せる。
  parentId: z.union([z.number().int().positive(), z.null(), z.literal('')]).optional(),
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

/**
 * 担当者の候補（旧 getStaffOptions）。
 * GAS版は固定リストだったが、実際に得意先マスタで使われている名前も拾って混ぜる。
 * 固定リストだけだと、人が増えたときにコードを直さないと出てこないため。
 */
const KNOWN_STAFF = ['田中', '菅井', '辻屋', '濱村', '阿慈知', '清水', '浜田'];

router.get('/staff', (req, res) => {
  const db = getConnection();
  const used = db
    .prepare(
      `SELECT DISTINCT name FROM (
         SELECT sales_rep AS name FROM customers WHERE sales_rep IS NOT NULL AND sales_rep <> ''
         UNION
         SELECT sales_sub_rep FROM customers WHERE sales_sub_rep IS NOT NULL AND sales_sub_rep <> ''
       ) ORDER BY name`
    )
    .all()
    .map((r) => r.name);

  res.json([...new Set([...KNOWN_STAFF, ...used])]);
});

router.get('/', (req, res) => {
  res.json(customerModel.list());
});

router.get('/:id', (req, res) => {
  const customer = customerModel.findById(Number(req.params.id));
  if (!customer) return res.status(404).json({ error: 'not_found' });
  res.json(customer);
});

/** 空文字を「本店を外す」の意味に揃える */
function normalizeParentId(body) {
  if (!Object.hasOwn(body, 'parentId')) return body;
  return { ...body, parentId: body.parentId === '' ? null : body.parentId };
}

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    const input = normalizeParentId(req.body);
    customerService.assertValidParent(null, input.parentId ?? null);
    res.status(201).json(customerModel.create(input));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const input = normalizeParentId(req.body);
    if (Object.hasOwn(input, 'parentId')) {
      // 自分自身を本店にする指定と、本店と支店が輪になる指定を弾く
      customerService.assertValidParent(id, input.parentId);
    }
    const updated = customerModel.update(id, input);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/** 請求まわりの値が、本店から引き継いだ状態でどうなるかを返す（画面のヒント用） */
router.get('/:id/billing', (req, res) => {
  const resolved = customerService.resolveBilling(Number(req.params.id));
  if (!resolved) return res.status(404).json({ error: 'not_found' });
  res.json(resolved);
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
