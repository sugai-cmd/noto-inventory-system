// 原酒受払ID（raw_sake_ledger.lot_code）の採番。
//
// DATA_STRUCTURE.md 4-9 F列：「払出は0001から、受入は1000刻みでロット・月ごとに採番」。
// 「1000刻み」の解釈が一意に定まらないため、ここでは
//   払出 = R{YYMM}-0001 から1ずつ（1000未満に収める）
//   受入 = R{YYMM}-1000 から1ずつ
// と実装し、同じ月内で受入/払出が番号帯で区別できる状態を維持する。
// ※過去データの採番は移行時にシートの値をそのまま取り込むため、この関数は新規登録にのみ影響する。

const PREFIX = 'R';
const RECEIPT_BASE = 1000; // 受入の開始番号
const SEQ_DIGITS = 4;

function toYymm(dateOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new Error(`日付はYYYY-MM-DD形式で指定してください: "${dateOnly}"`);
  }
  return dateOnly.slice(2, 4) + dateOnly.slice(5, 7);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'受入'|'払出'} txnType
 * @param {string} dateOnly - YYYY-MM-DD
 */
function nextRawSakeLotCode(db, txnType, dateOnly) {
  const yymm = toYymm(dateOnly);
  const rows = db
    .prepare(`SELECT lot_code FROM raw_sake_ledger WHERE lot_code LIKE ?`)
    .all(`${PREFIX}${yymm}-%`);

  const isReceipt = txnType === '受入';
  const base = isReceipt ? RECEIPT_BASE : 1;

  let max = base - 1;
  for (const { lot_code: code } of rows) {
    const seq = Number.parseInt(code.slice(code.indexOf('-') + 1), 10);
    if (!Number.isFinite(seq)) continue;
    // 受入帯(>=1000)と払出帯(<1000)をそれぞれ独立に見る
    const inBand = isReceipt ? seq >= RECEIPT_BASE : seq < RECEIPT_BASE;
    if (inBand && seq > max) max = seq;
  }

  return `${PREFIX}${yymm}-${String(max + 1).padStart(SEQ_DIGITS, '0')}`;
}

module.exports = { nextRawSakeLotCode };
