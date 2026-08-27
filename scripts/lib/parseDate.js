// スプレッドシート由来の日付・日時セルを、DB_SCHEMA_DESIGN.md 2.0の方針
// （`_on`=YYYY-MM-DDのみ、`_time`=HH:MMのみに分離）に従って正規化する。

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30); // Excel/Sheetsのシリアル値の起点

function pad2(n) {
  return String(n).padStart(2, '0');
}

function excelSerialToParts(serial) {
  const ms = EXCEL_EPOCH_UTC_MS + serial * 86400000;
  const dt = new Date(Math.round(ms));
  const date = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  const hasTime = Math.abs(serial % 1) > 1e-9;
  const time = hasTime ? `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}` : null;
  return { date, time };
}

/**
 * 日付のみのセルを 'YYYY-MM-DD' に正規化する。
 * 空文字・null・undefinedはnullを返す。解釈できない値は例外を投げる。
 */
function parseDateOnly(raw) {
  const parts = parseDateTimeParts(raw);
  return parts.date;
}

/**
 * 日付＋時刻が混在しうるセルを { date: 'YYYY-MM-DD'|null, time: 'HH:MM'|null } に分解する。
 * 空文字・null・undefinedは両方nullを返す。解釈できない値は例外を投げる。
 */
function parseDateTimeParts(raw) {
  if (raw == null) return { date: null, time: null };
  const s = String(raw).trim();
  if (s === '') return { date: null, time: null };

  // 'YYYY-MM-DD[ T]HH:MM[:SS]' / 'YYYY/M/D HH:MM[:SS]'
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
  if (m) {
    const [, y, mo, d, hh, mm] = m;
    return { date: `${y}-${pad2(mo)}-${pad2(d)}`, time: `${pad2(hh)}:${mm}` };
  }

  // 'YYYY-MM-DD' / 'YYYY/M/D'（時刻なし）
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*$/);
  if (m) {
    const [, y, mo, d] = m;
    return { date: `${y}-${pad2(mo)}-${pad2(d)}`, time: null };
  }

  // Excel/Sheetsのシリアル値
  if (/^\d+(\.\d+)?$/.test(s)) {
    return excelSerialToParts(Number(s));
  }

  throw new Error(`日付/日時を解釈できません: "${raw}"`);
}

/**
 * 「対象月」「取引開始月」等の月単位セルを 'YYYY-MM' に正規化する。
 * 'YYYY-MM'、'YYYY/M'、日付付きの値（日は切り捨てる）のいずれも受け付ける。
 * 空文字・null・undefinedはnullを返す。
 */
function parseMonthOnly(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  const m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?/);
  if (m) {
    const [, y, mo] = m;
    return `${y}-${pad2(mo)}`;
  }

  // 日付そのものが入っている/Excelシリアル値の場合は日付側から流用する
  const { date } = parseDateTimeParts(raw);
  if (date) return date.slice(0, 7);

  throw new Error(`月を解釈できません: "${raw}"`);
}

module.exports = { parseDateOnly, parseDateTimeParts, parseMonthOnly };
