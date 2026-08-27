// Express共通エラーハンドラ。better-sqlite3のCHECK/UNIQUE制約違反等を
// 500で握りつぶさず、原因が分かる形でJSON返却する。

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(err);

  if (err && err.code && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'constraint_violation', message: err.message });
  }

  res.status(500).json({ error: 'internal_error', message: err.message });
}

module.exports = { errorHandler };
