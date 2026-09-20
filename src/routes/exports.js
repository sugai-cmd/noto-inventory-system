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
  // 受注一覧の絞り込みをそのまま引き継げるようにする。
  // 画面のボタンが「上の絞り込み条件で出力」と言っている以上、
  // 一覧で絞れるものはCSVでも絞れないと嘘になる
  if (query.customerId) filter.customerId = Number(query.customerId);
  if (query.productId) filter.productId = Number(query.productId);
  if (query.dateField) filter.dateField = String(query.dateField);
  return filter;
}

/**
 * CSVを返す。
 * ゆうパックは Shift_JIS 指定なので、ここでエンコードしてバイト列で返す
 * （UTF-8のまま渡すとゆうプリ側で文字化けする）。
 * 判定できなかった住所や、7品目に収まらなかった受注はヘッダで知らせる。
 */
/** ヘッダに載せる要確認の最大件数。残りは件数だけ伝える */
const HEADER_SAMPLE_LIMIT = 20;

function setCappedHeader(res, name, list) {
  if (!list?.length) return;
  res.setHeader(`X-${name}-Count`, String(list.length));
  res.setHeader(
    `X-${name}`,
    encodeURIComponent(JSON.stringify(list.slice(0, HEADER_SAMPLE_LIMIT)))
  );
}

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
  // 画面側で警告を出せるよう、要確認をヘッダに載せる（本文はCSVなので混ぜられない）。
  // **全部は載せない。** 段ボール対応表が未整備のうちは受注のほぼ全件が要確認になり、
  // 数百件ぶんをヘッダに詰めるとサイズ上限を超えて**出力そのものが失敗する**
  // （実際に120件でそうなった）。件数は必ず返し、中身は先頭だけにする。
  setCappedHeader(res, 'Unresolved', result.unresolved);
  setCappedHeader(res, 'Overflow', result.overflow);
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
