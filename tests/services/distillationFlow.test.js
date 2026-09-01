// 原酒入荷 → 蒸留開始 → 部分取消 → 蒸留完了 の一連フローを検証する。
// DATA_STRUCTURE.md 4-7〜4-10, 5章の「蒸留の開始・完了」に対応。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

// 認証を有効にしたまま（本番と同じ構成で）テストする
const harness = createHarness('test-distillation.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
  // 原酒タンク2本と浄酎タンク1本
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, 'SP-01', '原酒ポリタンク1', '原酒ポリタンク', 200, 0)`
  ).run(generateUid(db, 'tanks'));
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, 'SP-02', '原酒ポリタンク2', '原酒ポリタンク', 200, 0)`
  ).run(generateUid(db, 'tanks'));
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, 'T-01', '浄酎タンク1', 'ステンレスタンク', 1000, 0)`
  ).run(generateUid(db, 'tanks'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('原酒入荷でタンク残量が増える', async () => {
  const first = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-20',
    toTankId: 1,
    quantity: 150,
    supplier: '山田酒造',
    specNote: '銘柄A 18度',
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.tankVolume.current_volume_l, 150);

  const second = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-21',
    toTankId: 2,
    quantity: 80,
    supplier: '佐藤酒造',
  });
  assert.equal(second.body.tankVolume.current_volume_l, 80);
});

test('原酒受払IDは受入が1000番台、払出が0001番台で採番される（4-9）', async () => {
  const codes = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE txn_type = '受入' ORDER BY id")
    .all()
    .map((r) => r.lot_code);
  assert.deepEqual(codes, ['R2607-1000', 'R2607-1001']);
});

test('蒸留開始で複数タンクから投入でき、原酒が減る', async () => {
  const { status, body } = await api('POST', '/api/distillations', {
    startedOn: '2026-08-01',
    startedTime: '09:30',
    plannedDuration: '8時間',
    items: [
      { tankId: 1, volumeL: 100 },
      { tankId: 2, volumeL: 50 },
    ],
  });
  assert.equal(status, 201);
  // 蒸留IDはDistillの'D'（受注番号はOrderの'O'に分離済み）
  assert.equal(body.distillationCode, 'D2608-0001');
  assert.equal(body.totalInputL, 150);
  assert.equal(body.details.length, 2);

  const tanks = await api('GET', '/api/raw-sake-receipts/tanks');
  const sp01 = tanks.body.find((t) => t.code === 'SP-01');
  const sp02 = tanks.body.find((t) => t.code === 'SP-02');
  assert.equal(sp01.current_volume_l, 50); // 150 - 100
  assert.equal(sp02.current_volume_l, 30); // 80 - 50
});

test('蒸留開始で払出側の原酒受払IDは0001番台になる', async () => {
  const codes = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE txn_type = '払出' ORDER BY id")
    .all()
    .map((r) => r.lot_code);
  assert.deepEqual(codes, ['R2608-0001', 'R2608-0002']);
});

test('残量を超える投入は422で拒否される', async () => {
  const { status, body } = await api('POST', '/api/distillations', {
    startedOn: '2026-08-02',
    startedTime: '10:00',
    items: [{ tankId: 1, volumeL: 999 }],
  });
  assert.equal(status, 422);
  assert.match(body.message, /原酒残量が不足/);
});

test('投入明細を部分取消すると原酒がタンクへ戻り、投入量合計が再計算される', async () => {
  const detail = await api('GET', '/api/distillations/1');
  const target = detail.body.details.find((d) => d.source_tank_name === '原酒ポリタンク2');

  const { status, body } = await api(
    'POST',
    `/api/distillations/details/${target.id}/cancel`,
    { reason: '投入量の誤り' }
  );
  assert.equal(status, 200);
  assert.equal(body.totalInputL, 100); // 150 - 取消50
  assert.equal(body.tankVolume.current_volume_l, 80); // 30 + 戻し50

  // 二重取消は409
  const again = await api('POST', `/api/distillations/details/${target.id}/cancel`, {});
  assert.equal(again.status, 409);
});

test('蒸留完了で浄酎タンクへ継足され、残渣も記録される', async () => {
  const { status, body } = await api('POST', '/api/distillations/1/complete', {
    completedOn: '2026-08-01',
    completedTime: '18:00',
    outputTankId: 3,
    outputL: 50,
    outputAbv: 40,
    residue: {
      collectedOn: '2026-08-01',
      collectedTime: '18:30',
      quantity: 30,
      abv: 5,
      saltStatus: '添加済',
      destination: '残渣タンク',
    },
  });
  assert.equal(status, 200);
  assert.equal(body.distillation.status, '完了');
  assert.equal(body.distillation.output_l, 50);
  // 日付と時刻が分離して保存されている（2.0）
  assert.equal(body.distillation.completed_on, '2026-08-01');
  assert.equal(body.distillation.completed_time, '18:00');
  assert.ok(body.residueId);

  // 浄酎タンク側は tank_ledger 経由で増える
  assert.equal(body.outputTankVolume.current_volume_l, 50);

  const detail = await api('GET', '/api/distillations/1');
  assert.equal(detail.body.residues.length, 1);
  assert.equal(detail.body.residues[0].collected_time, '18:30');
});

test('完了済みの蒸留は二重完了・明細取消ができない', async () => {
  const again = await api('POST', '/api/distillations/1/complete', {
    outputTankId: 3,
    outputL: 10,
  });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /既に完了/);

  const detail = await api('GET', '/api/distillations/1');
  const active = detail.body.details.find((d) => !d.is_cancelled);
  const cancel = await api('POST', `/api/distillations/details/${active.id}/cancel`, {});
  assert.equal(cancel.status, 409);
  assert.match(cancel.body.message, /完了済み/);
});

test('24時間超の蒸留中アラートが検出される（旧 getStaleDistillationAlerts）', async () => {
  // 30時間前に開始してまだ蒸留中の記録を作る。
  // 日付と時刻は別カラムなので（2.0）、どちらも同じ時点から求める。
  // 時刻を固定値にすると、テストを流した時間帯によって経過時間が24時間を
  // 割り込んでしまうため。
  const startedAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = `${startedAt.getFullYear()}-${p2(startedAt.getMonth() + 1)}-${p2(startedAt.getDate())}`;
  const hm = `${p2(startedAt.getHours())}:${p2(startedAt.getMinutes())}`;
  db.prepare(
    `INSERT INTO distillations (distillation_code, started_on, started_time, status, total_input_l)
     VALUES ('DS-STALE', ?, ?, '蒸留中', 10)`
  ).run(ymd, hm);

  const { status, body } = await api('GET', '/api/distillations/alerts');
  assert.equal(status, 200);
  const stale = body.find((d) => d.distillation_code === 'DS-STALE');
  assert.ok(stale, '24時間超の蒸留中レコードが検出されること');
  assert.ok(stale.elapsed_hours > 24);

  // 閾値を上げれば対象外になる
  const relaxed = await api('GET', '/api/distillations/alerts?hours=72');
  assert.equal(relaxed.body.find((d) => d.distillation_code === 'DS-STALE'), undefined);
});
