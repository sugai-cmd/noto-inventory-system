// 日付・時刻の分離パーサーのテスト。
// スプレッドシート上の日付誤表記で売上モニターが連動しなくなる事故（2.0の背景）を
// 移行時点で確実に検出・分離できることを担保する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDateOnly,
  parseDateTimeParts,
  parseMonthOnly,
} = require('../../scripts/lib/parseDate');

test('parseDateOnly はスラッシュ区切り・ゼロ埋めなしをYYYY-MM-DDに正規化する', () => {
  assert.equal(parseDateOnly('2026/8/5'), '2026-08-05');
  assert.equal(parseDateOnly('2026-08-05'), '2026-08-05');
});

test('parseDateOnly は空値をnullとして扱う', () => {
  assert.equal(parseDateOnly(''), null);
  assert.equal(parseDateOnly(null), null);
  assert.equal(parseDateOnly(undefined), null);
});

test('parseDateOnly は解釈できない値で例外を投げる（握りつぶさない）', () => {
  assert.throws(() => parseDateOnly('令和8年8月5日'), /日付\/日時を解釈できません/);
  assert.throws(() => parseDateOnly('不明'), /日付\/日時を解釈できません/);
});

test('parseDateTimeParts は日時混在の値を日付と時刻に分離する', () => {
  assert.deepEqual(parseDateTimeParts('2026/8/1 09:30'), {
    date: '2026-08-01',
    time: '09:30',
  });
  assert.deepEqual(parseDateTimeParts('2026-08-01T18:00:00'), {
    date: '2026-08-01',
    time: '18:00',
  });
});

test('parseDateTimeParts は時刻なしの値ではtimeをnullにする', () => {
  assert.deepEqual(parseDateTimeParts('2026/8/1'), { date: '2026-08-01', time: null });
});

test('parseDateTimeParts はExcel/Sheetsのシリアル値を解釈する', () => {
  // 45870 = 2025-08-01（Excelシリアル、1899-12-30起点）
  const { date, time } = parseDateTimeParts('45870');
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(time, null);

  // 小数部があれば時刻ありとして分離される
  const withTime = parseDateTimeParts('45870.5');
  assert.match(withTime.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(withTime.time, '12:00');
});

test('parseMonthOnly は対象月をYYYY-MMに正規化する', () => {
  assert.equal(parseMonthOnly('2026/8'), '2026-08');
  assert.equal(parseMonthOnly('2026-08'), '2026-08');
  // 日付が入っていても月に丸める
  assert.equal(parseMonthOnly('2026/8/15'), '2026-08');
  assert.equal(parseMonthOnly(''), null);
});
