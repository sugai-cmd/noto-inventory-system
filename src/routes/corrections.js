// 修正履歴（取消の一覧）。

const express = require('express');
const correctionHistoryService = require('../services/correctionHistoryService');

const router = express.Router();

/** 修正履歴。`{rows, total}` を返す（total は同じ絞り込みでの全件数） */
router.get('/', (req, res) => {
  const q = req.query;
  res.json(
    correctionHistoryService.list({
      targetCode: q.targetCode ? String(q.targetCode) : undefined,
      targetType: q.targetType ? String(q.targetType) : undefined,
      userName: q.userName ? String(q.userName) : undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: Math.min(Number(q.limit) || 200, 1000),
      offset: Math.max(Number(q.offset) || 0, 0),
      sort: q.sort || undefined,
      order: q.order || undefined,
    })
  );
});

/** 絞り込みのプルダウンに出す値（実データにあるものだけ） */
router.get('/options', (req, res) => {
  res.json(correctionHistoryService.listFilterOptions());
});

module.exports = router;
