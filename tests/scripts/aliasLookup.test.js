// aliases.json の対応表が、書き写しのぶれを越えて引けること。
//
// キーは unmatched-names.csv の rawValue をそのまま貼る前提だが、
// 手で書き写すと幅（全角/半角）や前後の空白がずれる。
// そこだけのために「書いたのに効かない」となるのは分かりにくいので、
// 正規化したキーでも引けるようにしてある。

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveId } = require('../../scripts/lib/loadHelper');
const { normalizeName } = require('../../src/utils/normalizeName');

function makeCtx(aliases, names) {
  const idMap = new Map(names.map((n, i) => [normalizeName(n), i + 1]));
  return {
    aliases,
    normalize: normalizeName,
    report: { unmatched: [], recordUnmatched(...a) { this.unmatched.push(a); } },
    idMap,
  };
}

function resolve(ctx, rawValue) {
  return resolveId(ctx, {
    sheet: '顧客リスト', column: '得意先', rawValue, idMap: ctx.idMap,
  });
}

test('キーがCSVの値と完全に一致すれば引ける', () => {
  const ctx = makeCtx(
    { 得意先: { 'のと空港セレンブティ': 'のと空港セレンディピティ' } },
    ['のと空港セレンディピティ']
  );
  assert.equal(resolve(ctx, 'のと空港セレンブティ'), 1);
  assert.equal(ctx.report.unmatched.length, 0);
});

test('キーの全角・半角や前後の空白がずれていても引ける', () => {
  const ctx = makeCtx(
    // 「ＱＢ００９」と全角で書き写し、うしろに空白も付いてしまった場合
    { 得意先: { 'ＱＢ００９ ': 'テナー9' } },
    ['テナー9']
  );
  assert.equal(resolve(ctx, 'QB009'), 1);
  assert.equal(ctx.report.unmatched.length, 0);
});

test('右辺がマスタに無い名前なら、不一致として報告される', () => {
  const ctx = makeCtx(
    { 得意先: { 'カナカン': 'カナカン株式会社' } },
    ['カナカン酒類石川']
  );
  assert.equal(resolve(ctx, 'カナカン'), null);
  assert.equal(ctx.report.unmatched.length, 1);
  // 生値はそのまま残す（レポートからCSVを探せるように）
  assert.equal(ctx.report.unmatched[0][2], 'カナカン');
});

test('対応表に無い値は、これまで通り正規化だけで引く', () => {
  const ctx = makeCtx({}, ['地域未来創造（コレゾCOREZO）']);
  assert.equal(resolve(ctx, '地域未来創造(コレゾCOREZO)'), 1);
});
