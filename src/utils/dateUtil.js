// 日付ユーティリティ。
// DB_SCHEMA_DESIGN.md 2.0の方針により、業務日付は常に 'YYYY-MM-DD' の文字列で扱い、
// Dateオブジェクトはこのモジュール内の計算にのみ使う（タイムゾーンの影響を避けるため
// 常にUTCで組み立てる）。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isDateOnly(value) {
  return typeof value === 'string' && DATE_RE.test(value);
}

function assertDateOnly(value, label = '日付') {
  if (!isDateOnly(value)) {
    throw new Error(`${label}はYYYY-MM-DD形式で指定してください: "${value}"`);
  }
}

function toParts(dateOnly) {
  assertDateOnly(dateOnly);
  return {
    year: Number(dateOnly.slice(0, 4)),
    month: Number(dateOnly.slice(5, 7)),
    day: Number(dateOnly.slice(8, 10)),
  };
}

function format(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** その年月の末日（28〜31）を返す */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 今日の日付を 'YYYY-MM-DD' で返す（ローカルタイム基準）。
 */
function today() {
  const now = new Date();
  return format(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * 支払いサイトから入金予定日を計算する（DATA_STRUCTURE.md 4-1 M列
 * 「納品日＋得意先の支払いサイトから自動計算」の実装）。
 *
 * @param {string} baseDateOnly - 起点日（通常は納品日）YYYY-MM-DD
 * @param {number|null} termMonths - 支払いサイト月数（1=翌月, 2=翌々月）
 * @param {string|null} termDay - 支払いサイト日付（'末日' または '20' のような日）
 * @returns {string|null}
 */
function calcPaymentDueOn(baseDateOnly, termMonths, termDay) {
  if (!isDateOnly(baseDateOnly)) return null;

  const { year, month } = toParts(baseDateOnly);
  const months = Number.isFinite(Number(termMonths)) ? Number(termMonths) : 0;

  // 月を進める（monthは1始まりなので0始まりに直して計算し戻す）
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = shifted.getUTCFullYear();
  const targetMonth = shifted.getUTCMonth() + 1;
  const endOfMonth = lastDayOfMonth(targetYear, targetMonth);

  const trimmed = (termDay ?? '').trim();
  if (trimmed === '' || trimmed === '末日' || trimmed === '末') {
    return format(targetYear, targetMonth, endOfMonth);
  }

  const dayNum = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(dayNum)) {
    // 「末日」でも数値でもない自由記述は解釈せず末日にフォールバックする
    return format(targetYear, targetMonth, endOfMonth);
  }

  // 31日指定で30日までしかない月などは、その月の末日に丸める
  return format(targetYear, targetMonth, Math.min(dayNum, endOfMonth));
}

module.exports = {
  isDateOnly,
  assertDateOnly,
  today,
  lastDayOfMonth,
  calcPaymentDueOn,
};
