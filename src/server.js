const path = require('node:path');
const express = require('express');
const config = require('./config');
const { migrate } = require('./db/migrate');
const { errorHandler } = require('./middlewares/errorHandler');

// 起動時にマイグレーションを適用してからサーバーを立ち上げる
migrate();

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 8-2: 酒蔵マスタ・原酒マスタは移行対象外のため、このAPIが主な入力経路になる
app.use('/api/breweries', require('./routes/breweries'));
app.use('/api/raw-sake-brands', require('./routes/rawSakeBrands'));

// TODO: customers / products / materials / orders 等、残りのroutesを実装次第マウントする

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`NOTO inventory server listening on http://localhost:${config.port}`);
});
