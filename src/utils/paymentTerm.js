// 支払いサイト月数の読み取り。
//
// 現行シートの「支払いサイト月数」列は「当月」「翌月」「翌々月」という言葉で入っている
// （DATA_STRUCTURE.md 得意先マスタ G列）。
// 一方こちらは入金予定日を計算するので、月数は数値で持つ必要がある
// （calcPaymentDueOn が納品日に月数を足す）。その変換をここに集約する。
//
// Number('翌月') は NaN になるだけで例外にならないため、
// 変換を挟まないと支払いサイトが黙って全件失われる。

const WORDS = new Map([
  ['当月', 0],
  ['当月末', 0],
  ['今月', 0],
  ['即時', 0],
  ['翌月', 1],
  ['翌月末', 1],
  ['翌々月', 2],
  ['翌翌月', 2],
  ['翌々々月', 3],
  ['翌翌翌月', 3],
]);

/**
 * @param {*} value - 「翌月」「1」「1ヶ月後」など
 * @returns {{months: number|null, ok: boolean}}
 *   ok=false は「値はあるが解釈できなかった」。空欄は {months:null, ok:true}。
 */
function parsePaymentTermMonths(value) {
  if (value == null || String(value).trim() === '') return { months: null, ok: true };

  const text = String(value).normalize('NFKC').replace(/[\s　]/g, '');

  if (WORDS.has(text)) return { months: WORDS.get(text), ok: true };

  // 「1」「1ヶ月」「1ヵ月後」「+2」なども拾う
  const matched = /^\+?(\d+)(ヶ月|ケ月|ヵ月|カ月|か月|月)?(後)?$/.exec(text);
  if (matched) return { months: Number.parseInt(matched[1], 10), ok: true };

  return { months: null, ok: false };
}

/** 画面のヒントなどに使う、受け付ける書き方の一覧 */
const ACCEPTED_WORDS = [...WORDS.keys()];

module.exports = { parsePaymentTermMonths, ACCEPTED_WORDS };
