// 在庫監査レポート（基本は読み取り専用。抜けていた出荷の記録だけ直せる）

const express = require('express');
const stockAuditService = require('../services/stockAuditService');
const orderService = require('../services/orderService');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    res.json(stockAuditService.runAudit());
  } catch (err) {
    next(err);
  }
});

/**
 * 「発送済なのに出荷の記録が無い」受注の出荷を、後から記録する。
 * 在庫が動くので、画面側は何が起きるかを見せてから押させること。
 */
router.post('/record-shipment/:orderId', (req, res, next) => {
  try {
    res.status(201).json(orderService.recordMissingShipment(Number(req.params.orderId), req.user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
