// 名寄せで引けなかった名前に対する「似ている候補」。
//
// 156件の得意先から目で探す作業を肩代わりするためのもの。
// もっともらしいが違う対応を自動で決めてしまうと、確かめずに貼られて
// 別の得意先・別のタンクに紐付くので、決める条件は厳しくしている。

const test = require('node:test');
const assert = require('node:assert/strict');
const { suggest, confidentSuggestion } = require('../../scripts/lib/similarName');

const 得意先 = [
  'のと空港セレンディピティ', 'カナカン酒類石川', 'カナカン酒類七尾', 'カナカン酒類高岡',
  'カナカン酒類富山', 'カナカン酒類福井', 'カナカン業本七尾', '道の駅のと千里浜',
  '地域未来創造（コレゾCOREZO）', '県アンテナショップ', 'プリスリゾート株式会社（百楽荘）',
];
const タンク = ['出荷用ポリタンク3', '出荷用ポリ13', 'ステンレスタンク2', '残渣保管タンク2'];

test('誤字は候補の1位に出る', () => {
  assert.equal(suggest('のと空港セレンブティ', 得意先)[0].name, 'のと空港セレンディピティ');
  assert.equal(confidentSuggestion('のと空港セレンブティ', 得意先), 'のと空港セレンディピティ');
});

test('書き足しの違いも拾う', () => {
  assert.equal(confidentSuggestion('県アンテナショップ八重洲', 得意先), '県アンテナショップ');
  assert.equal(confidentSuggestion('地域未来創造（コレゾ）', 得意先), '地域未来創造（コレゾCOREZO）');
  assert.equal(confidentSuggestion('道の駅千里浜', 得意先), '道の駅のと千里浜');
});

test('候補が複数あるものは自動で決めない（カナカンの支店）', () => {
  const found = suggest('カナカン', 得意先);
  assert.ok(found.length >= 3, 'カナカン系が候補に並ぶ');
  assert.ok(found.every((c) => c.name.startsWith('カナカン')));
  assert.equal(confidentSuggestion('カナカン', 得意先), null);
});

test('数字が違うものは別物として扱う（自動では決めない）', () => {
  // 「出荷ポリタンク2」と「出荷用ポリタンク3」は文字はよく似ているが別のタンク
  assert.equal(suggest('出荷ポリタンク2', タンク)[0].name, '出荷用ポリタンク3');
  assert.equal(confidentSuggestion('出荷ポリタンク2', タンク), null);

  // 「白30ml サンプル用(旧)」と「白35 30ml サンプル用」も別の商品
  assert.equal(confidentSuggestion('白30ml サンプル用(旧)', ['白35 30ml サンプル用']), null);
});

test('片方に含まれるだけの略称は候補に出すが、自動では決めない', () => {
  // 「近江町松本」と「松本」は別の取引先かもしれない
  assert.equal(suggest('近江町松本', ['松本'])[0].name, '松本');
  assert.equal(confidentSuggestion('近江町松本', ['松本']), null);
});

test('似ていない名前には候補を出さない', () => {
  assert.deepEqual(suggest('まったく無い会社', 得意先), []);
  assert.equal(confidentSuggestion('まったく無い会社', 得意先), null);
});

test('引き先が空でも落ちない', () => {
  assert.deepEqual(suggest('なにか', []), []);
  assert.equal(confidentSuggestion('なにか', []), null);
});
