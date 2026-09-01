// CSV出力エンドポイント。ブラウザからそのままダウンロードできるよう
// Content-Disposition を付けて返す。

const express = require('express');
const csvExportService = require('../services/csvExportService');

const router = express.Router();

function parseFilter(query) {
  const filter = {};
  if (query.orderIds) {
    filter.orderIds = String(query.orderIds)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }
  if (query.from) filter.from = String(query.from);
  if (query.to) filter.to = String(query.to);
  if (query.status) filter.status = String(query.status);
  return filter;
}

function sendCsv(res, filenameBase, result) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${filenameBase}_${stamp}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(result.csv);
}

// ゆうパック送り状用
router.get('/yupack', (req, res, next) => {
  try {
    sendCsv(res, 'yupack', csvExportService.exportYuPack(parseFilter(req.query)));
  } catch (err) {
    next(err);
  }
});

// マネーフォワード売上用
router.get('/moneyforward', (req, res, next) => {
  try {
    sendCsv(res, 'moneyforward', csvExportService.exportMoneyForward(parseFilter(req.query)));
  } catch (err) {
    next(err);
  }
});

// 棚卸用の在庫リスト（実測記入欄つき）
router.get('/product-stock', (req, res, next) => {
  try {
    sendCsv(res, 'product_stock', csvExportService.exportProductStock());
  } catch (err) {
    next(err);
  }
});

router.get('/material-stock', (req, res, next) => {
  try {
    sendCsv(res, 'material_stock', csvExportService.exportMaterialStock());
  } catch (err) {
    next(err);
  }
});

router.get('/tank-monitor', (req, res, next) => {
  try {
    sendCsv(res, 'tank_monitor', csvExportService.exportTankMonitor());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
