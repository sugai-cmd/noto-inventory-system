const path = require('node:path');

const config = {
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.resolve(__dirname, '..', 'db', 'database.sqlite'),
};

module.exports = config;
