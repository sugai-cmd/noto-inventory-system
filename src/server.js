const config = require('./config');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');

// 起動時にマイグレーションを適用してからサーバーを立ち上げる
migrate();

const app = createApp();

app.listen(config.port, () => {
  console.log(`NOTO inventory server listening on http://localhost:${config.port}`);
});
