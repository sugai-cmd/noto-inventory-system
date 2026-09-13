// 記録を直したあとに在庫を見張るための共通の決まり。
//
// 瓶詰め・箱詰めの編集（bottlingService）と資材の入出庫履歴の編集（materialService）が
// 同じ判断をするので、決まりの説明が2箇所に増えないようここに置く。

const { BusinessRuleError } = require('./errors');

/** 浮動小数のごみ（45 * (50/45) が 50.00000000000001 になるような）を落とす */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 直した結果、在庫が**前より悪化して**マイナスになっていないか。書き込んだあとに確かめる。
 *
 * 「0以上であること」を条件にしていないのは、移行した実データに既にマイナスの
 * ものがあるため（出荷用ポリタンク3 が -13.2L、出荷用ポリ13 が -10L）。
 * そこに触る修正まで断ってしまうと、移行データを直すための機能なのに直せなくなる。
 * 前より悪くしないことだけを条件にする。
 */
function assertNotWorseNegative(label, before, after) {
  if (after < 0 && after < before) {
    throw new BusinessRuleError(
      `${label}が ${round6(after)} になります（いまは ${round6(before)}）。この直し方はできません`
    );
  }
}

module.exports = { round6, assertNotWorseNegative };
