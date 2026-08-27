// Expressアプリの組み立て。listenはsrc/server.js側で行い、
// ここはテストからも再利用できるようにアプリだけを返す。

const path = require('node:path');
const express = require('express');
const { errorHandler } = require('./middlewares/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

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

  // TODO: 在庫監査レポートを実装次第マウントする

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
