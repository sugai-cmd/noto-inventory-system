// 修正履歴（取消の一覧）。

const express = require('express');
const correctionHistoryService = require('../services/correctionHistoryService');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(
    correctionHistoryService.list({
      targetCode: req.query.targetCode ? String(req.query.targetCode) : undefined,
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    })
  );
});

module.exports = router;
