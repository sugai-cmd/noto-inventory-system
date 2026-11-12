// 蒸留設定時間の書き方をそろえる。
//
// 画面では自由入力（例：8時間）。音声では「8時間」「8h」「480分」「8時間半」と言い方が揺れるので、
// 時間として読めたものは「N時間」「N時間M分」にそろえる。**読めなければ言われたまま残す**
// （捨てると、何と言ったのかが分からなくなる）。

const { normalizeName } = require('../utils/normalizeName');

const HOUR = '(?:時間|h|hr|hrs|hour|hours)';
const MINUTE = '(?:分|m|min|mins|minute|minutes)';
const NUM = '(\\d+(?:\\.\\d+)?)';

/** @returns {number|null} 分。読めなければ null */
function parseMinutes(text) {
  const s = normalizeName(text).replace(/\s/g, '').toLowerCase();
  let m;
  if ((m = s.match(new RegExp(`^${NUM}${HOUR}半$`)))) return Number(m[1]) * 60 + 30;
  if ((m = s.match(new RegExp(`^${NUM}${HOUR}${NUM}${MINUTE}$`)))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(new RegExp(`^${NUM}${HOUR}$`)))) return Number(m[1]) * 60;
  if ((m = s.match(new RegExp(`^${NUM}${MINUTE}$`)))) return Number(m[1]);
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

/**
 * @param {string|undefined} value
 * @returns {{value: string|undefined, recognized: boolean}}
 */
function normalizePlannedDuration(value) {
  if (value == null || String(value).trim() === '') return { value: undefined, recognized: true };
  const raw = String(value).trim();
  const minutes = parseMinutes(raw);
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return { value: raw, recognized: false };

  const rounded = Math.round(minutes);
  const h = Math.floor(rounded / 60);
  const min = rounded % 60;
  if (h === 0) return { value: `${min}分`, recognized: true };
  return { value: min === 0 ? `${h}時間` : `${h}時間${min}分`, recognized: true };
}

module.exports = { normalizePlannedDuration };
