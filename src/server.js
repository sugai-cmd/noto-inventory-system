const path = require('node:path');
const express = require('express');
const config = require('./config');
const { migrate } = require('./db/migrate');

// 起動時にマイグレーションを適用してからサーバーを立ち上げる
migrate();

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// TODO: ここに src/routes/* を app.use() でマウントしていく
// 例: app.use('/api/customers', require('./routes/customers'));

app.listen(config.port, () => {
  console.log(`NOTO inventory server listening on http://localhost:${config.port}`);
});
