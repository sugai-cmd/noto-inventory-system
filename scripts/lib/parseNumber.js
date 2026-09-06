// シート由来の数値を読む。
//
// シートの数量・金額は `1,000` `31,680` のように3桁区切りで、度数は `36.55%`、
// 空欄は `` だったり `-` だったりする。素の Number() だと
// Number('1,000') は NaN、Number('') は 0 になってしまい、
// 数量が黙って消えたり0になったりする。読み取りをここ1か所に集める。

// 数値として「値なし」を意味する書き方
const BLANKS = new Set(['', '-', '―', '−', 'ー', 'なし', '該当なし', 'N/A', 'n/a', '#N/A']);

/** 全角数字・記号を半角に直し、桁区切りや単位記号を落とす */
function clean(value) {
  return String(value)
    .normalize('NFKC')      // 全角数字・全角記号・全角空白を半角へ
    .replace(/[\s　]/g, '')
    .replace(/[,，]/g, '')  // 桁区切り
    .replace(/[¥￥$]/g, '') // 通貨記号
    .replace(/%$/, '')      // 末尾のパーセント（36.55% → 36.55）
    .replace(/[LlｍlML]$/u, (m) => (/[Ll]/.test(m) ? '' : m)) // 末尾の「L」（20L → 20）
    .trim();
}

/**
 * 数値として読む。空欄は null。読めない値は例外にする
 * （黙って0やNULLにすると、あとで数字が合わない原因が分からなくなる）。
 *
 * @param {*} value
 * @param {string} label - エラーメッセージに出す列名
 * @param {{ required?: boolean, allowNegative?: boolean }} [opts]
 * @returns {number|null}
 */
function parseNumber(value, label, { required = false, allowNegative = true } = {}) {
  if (value == null) {
    if (required) throw new Error(`${label}が空です`);
    return null;
  }
  const text = clean(value);
  if (BLANKS.has(text)) {
    if (required) throw new Error(`${label}が空です`);
    return null;
  }

  const num = Number(text);
  if (!Number.isFinite(num)) {
    throw new Error(`${label}を数値として読み取れませんでした: "${value}"`);
  }
  if (!allowNegative && num < 0) {
    throw new Error(`${label}は0以上で入力してください: "${value}"`);
  }
  return num;
}

/** 整数として読む（本数・ロット数など）。小数は切り捨てる */
function parseInteger(value, label, opts) {
  const num = parseNumber(value, label, opts);
  return num == null ? null : Math.trunc(num);
}

/**
 * 向きを符号で表しているシートの数量を、大きさだけの数として読む。
 * こちらは受入元/払出先の列で向きを表すので、符号は捨てる。
 */
function parseAbsNumber(value, label, opts) {
  const num = parseNumber(value, label, opts);
  return num == null ? null : Math.abs(num);
}

/**
 * 数値のうしろに人の書き込みが付いているセルを救う。
 * 実データには `500（3000）` のように、数量の横へ注記を書いた列がある。
 * 行ごと落とすとその資材を使うレシピまで芋づるで落ちるので、
 * 先頭の数値を取り、元の文字列は呼び出し元が備考へ残せるように返す。
 *
 * マスタの数量にだけ使う。台帳の数量は読めない時点で止めたいので使わない。
 *
 * @returns {{ value: number|null, salvaged: string|null }}
 *   salvaged は「数値以外が混ざっていたので削ぎ落とした」ときの元の文字列
 */
function parseNumberLoose(value, label) {
  if (value == null || BLANKS.has(clean(value))) return { value: null, salvaged: null };

  try {
    return { value: parseNumber(value, label), salvaged: null };
  } catch {
    // 先頭の数値だけ取り出す（全角も半角に直したうえで）
    const m = clean(value).match(/^-?\d+(\.\d+)?/);
    if (!m) throw new Error(`${label}を数値として読み取れませんでした: "${value}"`);
    return { value: Number(m[0]), salvaged: String(value).trim() };
  }
}

module.exports = { parseNumber, parseInteger, parseAbsNumber, parseNumberLoose };
