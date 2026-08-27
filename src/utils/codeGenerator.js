// 伝票番号の採番（受注番号 D+年月+連番、商品履歴ID L+年月+連番 等）。
//
// 現行システムは「月ごとに1からリセットする連番」という仕様（DATA_STRUCTURE.md 4-1）。
// 既存の最大連番をDBから引いて+1する方式にすることで、別途カウンタテーブルを
// 持たずに済み、移行データの続きからも正しく採番できる。
// 呼び出しは必ずトランザクション内で行うこと（採番と実INSERTの間に割り込まれないように）。

const SEQ_DIGITS = 4;

/**
 * 'YYYY-MM-DD' → 'YYMM'
 */
function toYymm(dateOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new Error(`日付はYYYY-MM-DD形式で指定してください: "${dateOnly}"`);
  }
  return dateOnly.slice(2, 4) + dateOnly.slice(5, 7);
}

/**
 * 同一プレフィックス・同一年月の最大連番+1で次の伝票番号を作る。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.table - 採番対象テーブル
 * @param {string} opts.column - 伝票番号カラム
 * @param {string} opts.prefix - 'D' / 'L' / 'M' / 'S' 等
 * @param {string} opts.dateOnly - 採番の基準日（YYYY-MM-DD）
 * @returns {string} 例: 'D2608-0001'
 */
function generateCode(db, { table, column, prefix, dateOnly }) {
  const yymm = toYymm(dateOnly);
  const pattern = `${prefix}${yymm}-%`;

  const row = db
    .prepare(`SELECT ${column} AS code FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`)
    .get(pattern);

  let next = 1;
  if (row?.code) {
    const seqPart = row.code.slice(row.code.indexOf('-') + 1);
    const parsed = Number.parseInt(seqPart, 10);
    if (Number.isFinite(parsed)) next = parsed + 1;
  }

  return `${prefix}${yymm}-${String(next).padStart(SEQ_DIGITS, '0')}`;
}

const nextOrderNo = (db, dateOnly) =>
  generateCode(db, { table: 'orders', column: 'order_no', prefix: 'D', dateOnly });

const nextProductHistoryCode = (db, dateOnly) =>
  generateCode(db, { table: 'product_stock_ledger', column: 'history_code', prefix: 'L', dateOnly });

const nextMaterialHistoryCode = (db, dateOnly) =>
  generateCode(db, { table: 'material_stock_ledger', column: 'history_code', prefix: 'M', dateOnly });

const nextSampleNo = (db, dateOnly) =>
  generateCode(db, { table: 'sample_shipments', column: 'sample_no', prefix: 'S', dateOnly });

module.exports = {
  generateCode,
  nextOrderNo,
  nextProductHistoryCode,
  nextMaterialHistoryCode,
  nextSampleNo,
  toYymm,
};
