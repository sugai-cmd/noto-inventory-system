// ロット追跡。どのタンクにどのロットの液体が入っているかを返す。

const express = require('express');
const lotTraceService = require('../services/lotTraceService');

const router = express.Router();

const wantsEmpty = (req) => req.query.includeEmpty === '1';

// 浄酎タンクの中身（蒸留ロット別）
router.get('/tanks', (req, res) => {
  res.json(lotTraceService.listTankLots({ includeEmpty: wantsEmpty(req) }));
});

// 蒸留ロットの行方（いまどのタンクに残っていて、どれだけ瓶詰めされたか）
router.get('/distillations', (req, res) => {
  res.json(
    lotTraceService.listDistillationLots({
      limit: Math.min(Number(req.query.limit) || 100, 500),
    })
  );
});

// 原酒タンクの中身（銘柄・酒蔵別）
router.get('/raw-sake', (req, res) => {
  res.json(lotTraceService.listRawSakeTankLots({ includeEmpty: wantsEmpty(req) }));
});

// 仕掛品ロット（瓶詰め1件＝1ロット）の残数と、箱詰めの内訳
router.get('/wip', (req, res) => {
  res.json(lotTraceService.listWipLots({ includeEmpty: wantsEmpty(req) }));
});

module.exports = router;
