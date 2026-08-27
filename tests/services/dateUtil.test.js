// 入金予定日の計算（支払いサイト）のテスト。
// DATA_STRUCTURE.md 4-1 M列「納品日＋得意先の支払いサイトから自動計算」の実装を担保する。

const test = require('node:test');
const assert = require('node:assert/strict');

const { calcPaymentDueOn, lastDayOfMonth } = require('../../src/utils/dateUtil');

test('翌月末日サイト', () => {
  assert.equal(calcPaymentDueOn('2026-08-08', 1, '末日'), '2026-09-30');
});

test('翌々月末日サイト', () => {
  assert.equal(calcPaymentDueOn('2026-08-08', 2, '末日'), '2026-10-31');
});

test('当月末日サイト（月数0）', () => {
  assert.equal(calcPaymentDueOn('2026-08-08', 0, '末日'), '2026-08-31');
});

test('年をまたぐ場合', () => {
  assert.equal(calcPaymentDueOn('2026-12-10', 1, '末日'), '2027-01-31');
});

test('日付指定（20日）', () => {
  assert.equal(calcPaymentDueOn('2026-08-08', 1, '20'), '2026-09-20');
});

test('31日指定でも、その月に31日がなければ末日に丸める', () => {
  // 2026-08-08 の翌月は9月（30日まで）
  assert.equal(calcPaymentDueOn('2026-08-08', 1, '31'), '2026-09-30');
});

test('うるう年の2月末', () => {
  assert.equal(calcPaymentDueOn('2028-01-15', 1, '末日'), '2028-02-29');
  assert.equal(lastDayOfMonth(2028, 2), 29);
  assert.equal(lastDayOfMonth(2026, 2), 28);
});

test('支払いサイト日付が未設定・自由記述なら末日にフォールバックする', () => {
  assert.equal(calcPaymentDueOn('2026-08-08', 1, null), '2026-09-30');
  assert.equal(calcPaymentDueOn('2026-08-08', 1, '翌月末'), '2026-09-30');
});

test('起点日が不正ならnullを返す（例外にしない）', () => {
  assert.equal(calcPaymentDueOn('2026/08/08', 1, '末日'), null);
  assert.equal(calcPaymentDueOn(null, 1, '末日'), null);
});
