// Express共通エラーハンドラ。
// 業務ルール違反（在庫不足・二重発送等）は利用者に原因が伝わる4xxで返し、
// 想定外の例外だけを500にする。

const { BusinessRuleError } = require('../utils/errors');

// SQLiteの制約違反は英語のまま返すと画面で意味が取れないので、
// よくある2つ（重複・参照されている行の削除）だけ日本語にする。
// 元のメッセージはどのカラムかを判断する手がかりなので残す。
const COLUMN_LABELS = {
  'customers.name': '得意先名',
  'customers.code': '得意先コード',
  'products.name': '商品名称',
  'products.code': '商品ID',
  'materials.name': '資材名',
  'materials.code': '資材ID',
  'tanks.name': '容器名称',
  'tanks.code': '容器ID',
  'breweries.name': '酒蔵名',
  'raw_sake_brands.name': '銘柄名',
};

function constraintMessage(err) {
  const raw = String(err.message ?? '');

  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return '他の記録から参照されているため削除できません。先に参照している側を消してください。';
  }

  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const column = raw.match(/UNIQUE constraint failed: ([\w.]+)/)?.[1];
    const label = column && COLUMN_LABELS[column];
    return label
      ? `その${label}はすでに登録されています。`
      : `すでに登録されている値です（${raw}）`;
  }

  return raw;
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof BusinessRuleError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }

  if (err && err.code && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
    return res
      .status(409)
      .json({ error: 'constraint_violation', message: constraintMessage(err) });
  }

  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
}

module.exports = { errorHandler };
