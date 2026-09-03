// CSV出力エンドポイント。ブラウザからそのままダウンロードできるよう
// Content-Disposition を付けて返す。

const express = require('express');
const csvExportService = require('../services/csvExportService');
const iconv = require('iconv-lite');

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

/**
 * CSVを返す。
 * ゆうパックは Shift_JIS 指定なので、ここでエンコードしてバイト列で返す
 * （UTF-8のまま渡すとゆうプリ側で文字化けする）。
 * 判定できなかった住所や、7品目に収まらなかった受注はヘッダで知らせる。
 */
function sendCsv(res, filenameBase, result) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = result.filename ?? `${filenameBase}_${stamp}.csv`;
  const encoding = result.encoding ?? 'UTF-8';

  const body =
    encoding === 'Shift_JIS' ? iconv.encode(result.csv, 'Shift_JIS') : Buffer.from(result.csv, 'utf8');

  res.setHeader('Content-Type', `text/csv; charset=${encoding === 'Shift_JIS' ? 'Shift_JIS' : 'utf-8'}`);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filenameBase}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('X-Row-Count', String(result.count ?? ''));
  // 画面側で警告を出せるよう、要確認の件数をヘッダに載せる（本文はCSVなので混ぜられない）
  if (result.unresolved?.length) {
    res.setHeader('X-Unresolved', encodeURIComponent(JSON.stringify(result.unresolved)));
  }
  if (result.overflow?.length) {
    res.setHeader('X-Overflow', encodeURIComponent(JSON.stringify(result.overflow)));
  }
  res.send(body);
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
