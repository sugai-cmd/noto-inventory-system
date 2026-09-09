// 記録の取り消し（瓶詰め・箱詰め・出荷・返品）。

const express = require('express');
const { z } = require('zod');
const ledgerCancelService = require('../services/ledgerCancelService');
const bottlingService = require('../services/bottlingService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const cancelSchema = z.object({
  reason: z.string().min(1, '取消理由は必須です'),
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');

/**
 * 記録そのものを直すときの入力。
 *
 * .strict() にしているのは、知らないキーを黙って捨てないため。
 * 商品・区分・払出元タンクはここに無く、送れば400になる（別の作業の記録になるので、
 * 取り消して入れ直してもらう）。
 */
const recordUpdateSchema = z
  .object({
    txnDate: dateOnly.optional(),
    quantity: z.number().int().positive('本数は1以上で入力してください').optional(),
    volumeL: z.number().positive('数量(L)は0より大きい値で入力してください').optional(),
    abv: z.number().min(0).max(100).optional(),
    storagePlace: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: '直す項目がひとつもありません' });

/**
 * 記録の一覧。絞り込み・並べ替え・ページングに対応する。
 *
 * 以前は直近30件しか返しておらず、それより古い記録は画面から見えなかった。
 * 並べ替えの列名は、サービス側の許可リスト（SORTABLE）に載っているものだけが通る。
 */
router.get('/', (req, res) => {
  const q = req.query;
  const cancelled = q.cancelled === undefined || q.cancelled === '' ? null : q.cancelled === 'true';

  const result = ledgerCancelService.listLedgerRecords({
    limit: Math.min(Number(q.limit) || 100, 500),
    offset: Math.max(Number(q.offset) || 0, 0),
    sort: q.sort || undefined,
    order: q.order || undefined,
    txnType: q.txnType || null,
    productId: Number(q.productId) || null,
    cancelled,
    from: q.from || null,
    to: q.to || null,
  });

  res.json({ ...result, limit: Math.min(Number(q.limit) || 100, 500), offset: Math.max(Number(q.offset) || 0, 0) });
});

/** 直す画面に出す1件ぶんの中身（本体＋資材消費＋タンク移動＋引当済み本数） */
router.get('/:ledgerId', (req, res, next) => {
  try {
    res.json(bottlingService.getRecord(Number(req.params.ledgerId)));
  } catch (err) {
    next(err);
  }
});

/**
 * 瓶詰め・箱詰めの記録そのものを直す。
 *
 * 取消（POST）と違い、台帳の行を書き換える。履歴IDは変わらない。
 * 変更前の値は操作ログに残る。
 */
router.patch('/:ledgerId', validateRequest(recordUpdateSchema), (req, res, next) => {
  try {
    res.json(bottlingService.updateRecord(Number(req.params.ledgerId), req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/:ledgerId', validateRequest(cancelSchema), (req, res, next) => {
  try {
    res.json(
      ledgerCancelService.cancelProductLedger(Number(req.params.ledgerId), req.body, req.user)
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
