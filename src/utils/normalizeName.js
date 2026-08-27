// 得意先名・商品名・タンク名・酒蔵名など、名前ベースの緩い紐付けを比較する際に使う正規化関数。
// DB_SCHEMA_DESIGN.md 8-3「名寄せ（名前解決）の仕組み」のルールをそのまま実装したもの。
// アプリ本体（重複チェック等）と scripts/migrate-from-sheets.js の両方から共有して使う。

/**
 * NFKC正規化（全角/半角統一）＋前後空白トリム＋連続空白の圧縮。
 * @param {string} value
 * @returns {string}
 */
function normalizeName(value) {
  if (value == null) return '';
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

module.exports = { normalizeName };
