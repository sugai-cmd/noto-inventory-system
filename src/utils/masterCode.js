// 得意先コード・商品ID・資材IDの自動採番。
//
// 現行シートの採番は「C0001」のような プレフィックス＋連番 で、
// 伝票番号（O2609-0001）と違って月ごとのリセットはない。
//
// プレフィックスと桁数は**既存データから読み取る**。
// こちらで決め打ちにすると、移行した過去データと形が変わって
// 「C0001」と「CUST-1」が混在することになるため。
// 1件も無いときだけ、呼び出し側が渡した既定値を使う。

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.table          - customers / products / materials
 * @param {string} opts.defaultPrefix  - 既存データが無いときのプレフィックス
 * @param {number} [opts.defaultDigits] - 同じく桁数（既定4）
 * @returns {{code: string, prefix: string, basedOn: string|null}}
 */
function nextMasterCode(db, { table, defaultPrefix, defaultDigits = 4 }) {
  const rows = db
    .prepare(`SELECT code FROM ${table} WHERE code IS NOT NULL AND TRIM(code) <> ''`)
    .all();

  // 「先頭の英字など＋末尾の数字」に分解できるものだけを採番の対象にする
  const parsed = [];
  for (const row of rows) {
    const matched = /^(\D*)(\d+)$/.exec(String(row.code).trim());
    if (matched) {
      parsed.push({ prefix: matched[1], digits: matched[2], value: Number.parseInt(matched[2], 10) });
    }
  }

  if (!parsed.length) {
    return {
      code: `${defaultPrefix}${'1'.padStart(defaultDigits, '0')}`,
      prefix: defaultPrefix,
      basedOn: null,
    };
  }

  // 複数のプレフィックスが混在していたら、いちばん多いものに合わせる
  const counts = new Map();
  for (const p of parsed) counts.set(p.prefix, (counts.get(p.prefix) ?? 0) + 1);
  const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const samePrefix = parsed.filter((p) => p.prefix === prefix);
  const max = samePrefix.reduce((a, b) => (b.value > a.value ? b : a));
  const width = Math.max(...samePrefix.map((p) => p.digits.length));

  return {
    code: `${prefix}${String(max.value + 1).padStart(width, '0')}`,
    prefix,
    basedOn: `${prefix}${max.digits}`,
  };
}

module.exports = { nextMasterCode };
