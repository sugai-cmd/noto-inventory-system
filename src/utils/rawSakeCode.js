// 原酒受払ID（raw_sake_ledger.lot_code）の採番。
//
// 形は `R{YYMM}-{帯}{連番3桁}`。**千の位が「その月の何回目の移入か」を表す。**
//   1回目の移入 → R2609-1001, 1002, …
//   2回目の移入 → R2609-2001, 2002, …
//   払出・棚卸   → R2609-0001, 0002, …（0帯。移入ではないので回数を持たない）
//
// DATA_STRUCTURE.md 4-9 F列は「払出は0001から、受入は1000刻みでロット・月ごとに採番」と
// 書いてあるだけで、**「回数ごとに千の位を+1」が落ちていた**。
// そのため以前は受入を 1000 から1ずつ連番にしており、同じ月の2回目の移入が
// 1026, 1027… と1回目の続きになっていた。
//
// 旧シートの実データもこの構造になっている（1回の移入が1日で完結し、
// 下3桁が原酒ポリの本数ぶんの連番）:
//   R2508-3009,3010（2025-08-27）／R2603-0001〜0026（2026-03-19）
//   R2606-2001〜2026（2026-06-25）／R2607-1001〜1025（2026-07-15）
//
// ただし千の位の値は 3/0/2/1 とばらついており、日付順にも月内の回数にも対応していない
// （手で振られたもの）。**帯の前提に頼らず、できた番号が既に使われていたら飛ばす。**
//   R2603-0001〜0026 は受入なのに0帯／R2606-1001,1002 は払出なのに1000帯
//
// ※移行した過去データはシートの値をそのまま取り込むため、この関数は新規登録にのみ影響する。

const { BusinessRuleError } = require('./errors');

const PREFIX = 'R';
const BAND_SIZE = 1000; // 帯の幅。千の位が回数
const SEQ_DIGITS = 4;

/** 移入（＝回数の帯を使う区分）。払出・棚卸調整・欠減は 0帯 */
const RECEIPT_TXN_TYPE = '受入';

function toYymm(dateOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new Error(`日付はYYYY-MM-DD形式で指定してください: "${dateOnly}"`);
  }
  return dateOnly.slice(2, 4) + dateOnly.slice(5, 7);
}

/** `R2607-1001` → 1001。読めなければ null */
function seqOf(lotCode) {
  const seq = Number.parseInt(lotCode.slice(lotCode.indexOf('-') + 1), 10);
  return Number.isFinite(seq) ? seq : null;
}

const bandOf = (seq) => Math.floor(seq / BAND_SIZE);

/**
 * その月に既にある原酒受払IDを1回だけ読む。
 *
 * 1件ずつ採番すると月ぶんを毎回読み直すので、原酒ポリ25本のまとめ入力で25回走る。
 */
function monthRows(db, yymm) {
  return db
    .prepare('SELECT lot_code, txn_date, txn_type FROM raw_sake_ledger WHERE lot_code LIKE ?')
    .all(`${PREFIX}${yymm}-%`)
    .map((r) => ({ ...r, seq: seqOf(r.lot_code) }))
    .filter((r) => r.seq != null);
}

/**
 * 移入の開始番号を決める。
 *
 * - その日付に既に受入があれば、**その行が使っている帯をそのまま使う**（同じ日付は同じ回）。
 *   既存行を振り直さないので、後から前の日付を足しても過去の番号は動かない
 * - 無ければ、その月の受入が使っている**最大の帯 + 1**（受入が無ければ1回目）
 */
function receiptStart(rows, dateOnly) {
  const receipts = rows.filter((r) => r.txn_type === RECEIPT_TXN_TYPE);
  const sameDay = receipts.filter((r) => r.txn_date === dateOnly);

  const band = sameDay.length
    ? Math.max(...sameDay.map((r) => bandOf(r.seq)))
    : (receipts.length ? Math.max(...receipts.map((r) => bandOf(r.seq))) : 0) + 1;

  const inBand = receipts.map((r) => r.seq).filter((seq) => bandOf(seq) === band);
  return {
    band,
    start: inBand.length ? Math.max(...inBand) + 1 : band * BAND_SIZE + 1,
  };
}

/** 払出・棚卸調整・欠減は 0帯（0001〜）。移入ではないので回数を持たない */
function otherStart(rows) {
  const others = rows
    .filter((r) => r.txn_type !== RECEIPT_TXN_TYPE && bandOf(r.seq) === 0)
    .map((r) => r.seq);
  return { band: 0, start: others.length ? Math.max(...others) + 1 : 1 };
}

/**
 * 連番をまとめて採る。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {'受入'|'払出'|'棚卸調整'|'欠減'} txnType
 * @param {string} dateOnly - YYYY-MM-DD
 * @param {number} count - 必要な個数
 * @returns {string[]}
 */
function nextRawSakeLotCodes(db, txnType, dateOnly, count) {
  const yymm = toYymm(dateOnly);
  const rows = monthRows(db, yymm);
  const used = new Set(rows.map((r) => r.lot_code));

  const { band, start } =
    txnType === RECEIPT_TXN_TYPE ? receiptStart(rows, dateOnly) : otherStart(rows);
  const bandEnd = band * BAND_SIZE + (BAND_SIZE - 1);

  const codes = [];
  for (let seq = start; codes.length < count; seq += 1) {
    if (seq > bandEnd) {
      // 帯をはみ出すと、千の位が別の回を指してしまう。黙って隣の帯へ入れない
      throw new BusinessRuleError(
        `${yymm.slice(0, 2)}年${yymm.slice(2)}月の${
          txnType === RECEIPT_TXN_TYPE ? `${band}回目の移入` : '払出・棚卸'
        }で採番できる番号（${String(band * BAND_SIZE + 1).padStart(SEQ_DIGITS, '0')}〜` +
          `${String(bandEnd).padStart(SEQ_DIGITS, '0')}）を使い切りました`
      );
    }
    const code = `${PREFIX}${yymm}-${String(seq).padStart(SEQ_DIGITS, '0')}`;
    // 移行データは帯を守っていないので、計算しただけでは衝突しうる。
    // lot_code の UNIQUE で落ちる前にこちらで避ける
    if (used.has(code)) continue;
    used.add(code);
    codes.push(code);
  }
  return codes;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'受入'|'払出'|'棚卸調整'|'欠減'} txnType
 * @param {string} dateOnly - YYYY-MM-DD
 */
function nextRawSakeLotCode(db, txnType, dateOnly) {
  return nextRawSakeLotCodes(db, txnType, dateOnly, 1)[0];
}

module.exports = { nextRawSakeLotCode, nextRawSakeLotCodes, RECEIPT_TXN_TYPE, BAND_SIZE };
