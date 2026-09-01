// 在庫監査レポート（読み取り専用）

const express = require('express');
const stockAuditService = require('../services/stockAuditService');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    res.json(stockAuditService.runAudit());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
