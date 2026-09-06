// 過去の伝票番号を、新しい採番規則の記号へ振り直す。
//
// 現行シートでは
//   受注番号   D2605-0001  ←→ 蒸留ID       D2606-0001
//   原酒受払ID M2603-0001  ←→ 資材履歴ID   M2506-0001
// が同じ形で、実データでそれぞれ37件・73件が完全に一致していた。
// 新規分は既に O（受注）・R（原酒受払）で採番しているので、過去分もそこへ揃える。
// 元の番号は legacy_order_no / legacy_lot_code に残すので、シートとの突き合わせはできる。

/**
 * 先頭の記号だけを差し替える。年月と連番はそのまま。
 * 記号が想定と違う形（そもそも D で始まっていない等）のときは、
 * 勝手に作り替えず元の値を返す。
 *
 * @param {string} code   例 'D2605-0001'
 * @param {string} prefix 例 'O'
 * @returns {string}      例 'O2605-0001'
 */
function renumber(code, prefix) {
  const text = String(code ?? '').trim();
  const m = text.match(/^[A-Za-z]+(\d{4}-\d+)$/);
  return m ? `${prefix}${m[1]}` : text;
}

module.exports = { renumber };

/**
 * 伝票番号の重複を、行を落とさずに避ける。
 *
 * 実データには同じ商品履歴ID・資材履歴IDを持つ行が複数あった
 * （GAS側の採番が競合したものと、まったく同じ行が二重に記録されたもの）。
 * 履歴IDはUNIQUEなので2件目がINSERTで落ちるが、落とすと在庫の動きが1件消える。
 * 番号のほうに枝番を付けて、行は残す。
 *
 * @param {object} counters - ctx.counters（1回の実行の中で持ち回る）
 * @param {string} scope    - 'product' / 'material' など、番号の系統
 * @param {string|null} code
 * @returns {{ code: string|null, duplicated: boolean }}
 */
function dedupeCode(counters, scope, code) {
  if (!code) return { code: null, duplicated: false };

  counters.seenCodes ??= new Map();
  const key = `${scope}:${code}`;
  const seen = counters.seenCodes.get(key) ?? 0;
  counters.seenCodes.set(key, seen + 1);

  if (seen === 0) return { code, duplicated: false };
  return { code: `${code}-${seen + 1}`, duplicated: true };
}

module.exports.dedupeCode = dedupeCode;
