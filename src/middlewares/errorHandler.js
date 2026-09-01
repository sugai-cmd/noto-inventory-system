// Express共通エラーハンドラ。
// 業務ルール違反（在庫不足・二重発送等）は利用者に原因が伝わる4xxで返し、
// 想定外の例外だけを500にする。

const { BusinessRuleError } = require('../utils/errors');

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof BusinessRuleError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }

  if (err && err.code && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'constraint_violation', message: err.message });
  }

  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
}

module.exports = { errorHandler };
