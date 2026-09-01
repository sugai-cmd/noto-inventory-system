// 記録の取り消し（瓶詰め・箱詰め・出荷・返品）。

const express = require('express');
const { z } = require('zod');
const ledgerCancelService = require('../services/ledgerCancelService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const cancelSchema = z.object({
  reason: z.string().min(1, '取消理由は必須です'),
});

router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  res.json(ledgerCancelService.listCancellable({ limit }));
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
