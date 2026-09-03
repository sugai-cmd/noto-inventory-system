// リードタイムの読み取り。
//
// 現行シートの資材マスタ「リードタイム」列は「1日」「3週間」「1.5ヶ月」「-」という
// 書き方で入っている。こちらは日数（整数）で持つので、その変換をここに集約する。
// Number('1週間') は NaN になるだけで例外にならないため、
// 変換を挟まないとリードタイムが黙って失われる。

const WEEK = 7;
const MONTH = 30; // 運用上の目安。発注の逆算に使うだけなので暦月まで厳密にしない

/**
 * @param {*} value - 「1日」「3週間」「1.5ヶ月」「10」「-」など
 * @returns {{days: number|null, ok: boolean}}
 *   ok=false は「値はあるが解釈できなかった」。空欄や「-」は {days:null, ok:true}。
 */
function parseLeadTimeDays(value) {
  if (value == null) return { days: null, ok: true };

  const text = String(value).normalize('NFKC').replace(/[\s　]/g, '');
  if (text === '' || text === '-' || text === '−' || text === '—') {
    return { days: null, ok: true };
  }

  const matched = /^(\d+(?:\.\d+)?)(日|営業日|週間|週|ヶ月|ケ月|ヵ月|カ月|か月|月)?$/.exec(text);
  if (!matched) return { days: null, ok: false };

  const amount = Number(matched[1]);
  const unit = matched[2] ?? '日';

  let days;
  if (unit === '週間' || unit === '週') days = amount * WEEK;
  else if (unit === '日' || unit === '営業日') days = amount;
  else days = amount * MONTH;

  return { days: Math.round(days), ok: true };
}

module.exports = { parseLeadTimeDays };
