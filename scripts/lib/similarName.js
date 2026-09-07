// 名寄せで引けなかった名前に対して、マスタから「似ている名前」の候補を出す。
//
// 156件の得意先から目で似た名前を探すのは骨が折れるので、
// レポート側で候補を並べて、人は選ぶだけにする。
//
// 似ている度合いは2文字組（bigram）の重なりで測る。
// 「のと空港セレンブティ」と「のと空港セレンディピティ」のように
// 途中が違うだけの誤字に強く、外部ライブラリを足さずに書ける。

const { normalizeName } = require('../../src/utils/normalizeName');

/** 文字列を2文字組の集合にする（1文字の語はその文字だけ） */
function bigrams(text) {
  const s = normalizeName(text);
  if (s.length <= 1) return new Set(s ? [s] : []);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 0〜1の似ている度合い。1が完全一致。
 * 重なりの数を、両方の平均の大きさで割る（Dice係数）。
 */
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;

  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;

  const dice = (2 * shared) / (A.size + B.size);

  // 片方がもう片方に丸ごと含まれるとき（「カナカン」と「カナカン酒類石川」など）は
  // 略称の可能性が高いので底上げする。Diceだけだと長さの差で沈む。
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const contained = na && nb && (na.includes(nb) || nb.includes(na)) ? 0.6 : 0;

  return Math.max(dice, contained);
}

/**
 * 候補を似ている順に返す。
 *
 * @param {string} query      引けなかった名前
 * @param {string[]} names    マスタに登録されている名前
 * @param {{limit?: number, threshold?: number}} [opts]
 * @returns {{name: string, score: number}[]}
 */
function suggest(query, names, { limit = 3, threshold = 0.4 } = {}) {
  return names
    .map((name) => ({ name, score: similarity(query, name) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** 名前に含まれる数字の並びを取り出す（「出荷ポリタンク2」→ ['2']） */
function digitsOf(text) {
  return (normalizeName(text).match(/\d+/g) ?? []).join(',');
}

/**
 * 候補が1つに絞れるかどうか。
 * 絞れたものだけを雛形（aliases-suggested.json）に入れるので、
 * ここは**厳しめ**にする。もっともらしいが違う対応を書いてしまうと、
 * 人が確かめずに貼って別の得意先・別のタンクに紐付いてしまう。
 */
function confidentSuggestion(query, names) {
  const candidates = suggest(query, names, { limit: 2 });
  if (!candidates.length) return null;
  const [first, second] = candidates;

  // 数字が違うものは別物とみなす。
  // 「出荷ポリタンク2」と「出荷用ポリタンク3」、
  // 「白30ml サンプル用」と「白35 30ml サンプル用」は文字はよく似ているが別物で、
  // 2文字組の重なりではその差がほとんど出ない。
  if (digitsOf(query) !== digitsOf(first.name)) return null;

  // 片方がもう片方に丸ごと含まれるだけ（略称らしきもの）は、候補には出すが自動では決めない。
  // 「近江町松本」→「松本」のように、別の取引先である可能性が残る。
  if (first.score <= 0.6) return null;

  if (second && first.score - second.score < 0.15) return null;
  return first.name;
}

module.exports = { similarity, suggest, confidentSuggestion, digitsOf };
