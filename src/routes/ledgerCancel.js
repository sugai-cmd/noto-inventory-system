// 記録の取り消し（瓶詰め・箱詰め・出荷・返品）。

const express = require('express');
const { z } = require('zod');
const ledgerCancelService = require('../services/ledgerCancelService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const cancelSchema = z.object({
  reason: z.string().min(1, '取消理由は必須です'),
});

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
