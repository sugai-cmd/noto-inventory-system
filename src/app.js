// Expressアプリの組み立て。listenはsrc/server.js側で行い、
// ここはテストからも再利用できるようにアプリだけを返す。

const path = require('node:path');
const express = require('express');
const { errorHandler } = require('./middlewares/errorHandler');
const { attachUser, requireAuth } = require('./middlewares/auth');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ログインしていなくても配信するもの（ログイン画面と、その表示に必要な資材）
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/favicon.svg',
  '/assets/css/app.css',
  '/assets/js/app.js',
]);

function createApp({ requireLogin = true } = {}) {
  const app = express();
  app.use(express.json());

  // 全リクエストでセッションを解決する（弾くのは requireAuth の役目）
  app.use(attachUser);

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', require('./routes/auth'));

  if (requireLogin) {
    // 画面・API問わず、ログイン画面まわり以外は認証を必須にする。
    // 静的ファイルの配信より前に置くことで、HTMLを直接開かれても素通りさせない。
    app.use((req, res, next) => {
      if (PUBLIC_PATHS.has(req.path)) return next();
      return requireAuth(req, res, next);
    });
  }

  app.use(express.static(PUBLIC_DIR));

  // マスタ系
  app.use('/api/customers', require('./routes/customers'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/materials', require('./routes/materials'));
  app.use('/api/tanks', require('./routes/tanks'));
  // 8-2: 酒蔵マスタ・原酒マスタは移行対象外のため、このAPIが主な入力経路になる
  app.use('/api/breweries', require('./routes/breweries'));
  app.use('/api/raw-sake-brands', require('./routes/rawSakeBrands'));

  // 業務系
  app.use('/api/orders', require('./routes/orders'));
  app.use('/api', require('./routes/bottling')); // /api/bottling, /api/boxing, /api/recipe/:productId
  app.use('/api/distillations', require('./routes/distillations'));
  app.use('/api/raw-sake-receipts', require('./routes/rawSakeReceipts'));
  app.use('/api/stocktaking', require('./routes/stocktaking'));
  app.use('/api/exports', require('./routes/exports'));
  app.use('/api/tank-operations', require('./routes/tankOperations'));
  app.use('/api/audit', require('./routes/audit'));
  app.use('/api/shipments', require('./routes/shipments')); // 返品・サンプル送付・委託販売報告
  app.use('/api/sales-targets', require('./routes/salesTargets'));
  app.use('/api/locks', require('./routes/locks'));
  app.use('/api/shipping', require('./routes/shipping'));       // 送料計算とそのマスタ
  app.use('/api/dashboard', require('./routes/dashboard'));      // 未入金・出荷予定・注文予測
  app.use('/api/ledger-cancel', require('./routes/ledgerCancel')); // 記録の取り消し
  app.use('/api/master-import', require('./routes/masterImport')); // マスタのCSV一括登録

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
