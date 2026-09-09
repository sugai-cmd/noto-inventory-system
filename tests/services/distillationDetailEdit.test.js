// 投入明細と蒸留量を、あとから直せること。**在庫が正しく動くことが本体。**
//
// 移行した過去の記録に誤りがあり、完了済みでも直したい。
// 台帳は書き換えず、「取り消して入れ直す」を1トランザクションで行う。
// このシステムは在庫を台帳の積み上げで出しており、取消も
// 「論理削除＋戻し行の追加」で表している。編集だけUPDATEにすると、
// 台帳を見ても何が起きたのか分からなくなる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-distillation-detail-edit.sqlite');
const api = harness.api;

let db;
let distillationId;
let detailId;

const TANK_A = 1; // 原酒ポリ1
const TANK_B = 2; // 原酒ポリ2
const OUT_TANK = 3; // 浄酎タンク1
const OUT_TANK_2 = 4; // 浄酎タンク2

/** 原酒タンクの残量 */
function rawVolume(tankId) {
  return db
    .prepare('SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE tank_id = ?')
    .get(tankId).current_volume_l;
}

/** 浄酎タンクの残量 */
function tankVolume(tankId) {
  return db
    .prepare('SELECT current_volume_l FROM v_tank_monitor WHERE tank_id = ?')
    .get(tankId).current_volume_l;
}

function distillation() {
  return db.prepare('SELECT * FROM distillations WHERE id = ?').get(distillationId);
}

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const ins = db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, ?, ?, ?, ?, 0)`
    );
    ins.run(generateUid(db, 'tanks'), 'SP-001', '原酒ポリ1', 'PE', 200);
    ins.run(generateUid(db, 'tanks'), 'SP-002', '原酒ポリ2', 'PE', 200);
    ins.run(generateUid(db, 'tanks'), 'T-001', '浄酎タンク1', 'ステンレスタンク', 1000);
    ins.run(generateUid(db, 'tanks'), 'T-002', '浄酎タンク2', 'ステンレスタンク', 1000);
  }));

  // 原酒ポリ1に100L・原酒ポリ2に100L入れて、30L投入で蒸留を完了させる
  await api('POST', '/api/raw-sake-receipts', { txnDate: '2026-07-01', toTankId: TANK_A, quantity: 100 });
  await api('POST', '/api/raw-sake-receipts', { txnDate: '2026-07-01', toTankId: TANK_B, quantity: 100 });

  const started = await api('POST', '/api/distillations', {
    startedOn: '2026-07-02',
    startedTime: '09:00',
    items: [{ tankId: TANK_A, volumeL: 30 }],
  });
  distillationId = started.body.distillationId;
  detailId = started.body.details[0].detailId;

  await api('POST', `/api/distillations/${distillationId}/complete`, {
    completedOn: '2026-07-02',
    completedTime: '18:00',
    outputTankId: OUT_TANK,
    outputL: 20,
    outputAbv: 41,
  });
});

test.after(async () => {
  await harness.teardown();
});

test('前提：完了済みで、原酒ポリ1は70L、浄酎タンク1は20L', () => {
  assert.equal(distillation().status, '完了');
  assert.equal(rawVolume(TANK_A), 70);
  assert.equal(tankVolume(OUT_TANK), 20);
});

test('完了済みの投入量を 30L → 20L に直すと、原酒タンクの残量が10L増える', async () => {
  const res = await api('PATCH', `/api/distillations/details/${detailId}`, { inputL: 20 });

  assert.equal(res.status, 200);
  assert.equal(rawVolume(TANK_A), 80); // 70 + 10
  assert.equal(distillation().total_input_l, 20);
});

test('元の明細は取消済みで残り、新しい明細が別の番号で作られる', async () => {
  const details = db
    .prepare('SELECT * FROM distillation_details WHERE distillation_id = ? ORDER BY id')
    .all(distillationId);

  assert.equal(details.length, 2);
  assert.equal(details[0].id, detailId);
  assert.equal(details[0].is_cancelled, 1);
  assert.match(details[0].note, /修正のため差し替え/);
  // どの明細に差し替わったかをたどれること
  assert.match(details[0].note, /→ DTL-2/);

  assert.equal(details[1].is_cancelled, 0);
  assert.equal(details[1].detail_code, 'DTL-2');
  assert.equal(details[1].input_l, 20);
});

test('台帳は書き換えず、戻しと払出を足して表す', () => {
  const rows = db
    .prepare("SELECT txn_type, quantity, from_tank_id, to_tank_id FROM raw_sake_ledger WHERE distillation_id = ? ORDER BY id")
    .all(distillationId);

  // 元の払出30L / 修正の戻し30L / 新しい払出20L
  assert.deepEqual(
    rows.map((r) => `${r.txn_type}${r.quantity}`),
    ['払出30', '受入30', '払出20']
  );
});

test('元容器を変えると、古いタンクが増えて新しいタンクが減る', async () => {
  const newDetail = db
    .prepare('SELECT id FROM distillation_details WHERE distillation_id = ? AND is_cancelled = 0')
    .get(distillationId).id;

  const before = { a: rawVolume(TANK_A), b: rawVolume(TANK_B) };
  const res = await api('PATCH', `/api/distillations/details/${newDetail}`, {
    sourceTankId: TANK_B,
  });

  assert.equal(res.status, 200);
  assert.equal(rawVolume(TANK_A), before.a + 20); // 戻ってくる
  assert.equal(rawVolume(TANK_B), before.b - 20); // 新しいタンクから出る
});

test('残量を超える投入量に直そうとすると422で、何も変わっていない', async () => {
  const detail = db
    .prepare('SELECT id FROM distillation_details WHERE distillation_id = ? AND is_cancelled = 0')
    .get(distillationId).id;

  const before = {
    a: rawVolume(TANK_A),
    b: rawVolume(TANK_B),
    total: distillation().total_input_l,
    details: db.prepare('SELECT COUNT(*) AS c FROM distillation_details').get().c,
    ledger: db.prepare('SELECT COUNT(*) AS c FROM raw_sake_ledger').get().c,
  };

  const res = await api('PATCH', `/api/distillations/details/${detail}`, { inputL: 999 });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /残量が/);

  // トランザクションが効いていること
  assert.equal(rawVolume(TANK_A), before.a);
  assert.equal(rawVolume(TANK_B), before.b);
  assert.equal(distillation().total_input_l, before.total);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM distillation_details').get().c, before.details);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM raw_sake_ledger').get().c, before.ledger);
});

test('取消済みの明細は直せない', async () => {
  const res = await api('PATCH', `/api/distillations/details/${detailId}`, { inputL: 5 });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /取消済み/);
});

test('直した記録が、前後の値つきで操作ログに残る', () => {
  const log = db
    .prepare(
      "SELECT summary, detail_json FROM operation_logs WHERE action = 'distillation.detail.update' ORDER BY id"
    )
    .get();
  assert.match(log.summary, /投入明細 DTL-1 を DTL-2 として直しました（30L → 20L）/);

  const detail = JSON.parse(log.detail_json);
  assert.equal(detail.before.input_l, 30);
  assert.equal(detail.after.input_l, 20);
});

// --- 蒸留量（出力） ---------------------------------------------------------

test('蒸留量を直すと、浄酎タンクの残量が連動する', async () => {
  assert.equal(tankVolume(OUT_TANK), 20);

  const res = await api('PATCH', `/api/distillations/${distillationId}/output`, { outputL: 18 });

  assert.equal(res.status, 200);
  assert.equal(tankVolume(OUT_TANK), 18);
  assert.equal(distillation().output_l, 18);
});

test('古い継足は取消済みで残り、新しい継足が入る', () => {
  const rows = db
    .prepare('SELECT quantity_l, is_cancelled, cancel_reason FROM tank_ledger WHERE distillation_id = ? ORDER BY id')
    .all(distillationId);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].quantity_l, 20);
  assert.equal(rows[0].is_cancelled, 1);
  assert.match(rows[0].cancel_reason, /蒸留量の修正/);
  assert.equal(rows[1].quantity_l, 18);
  assert.equal(rows[1].is_cancelled, 0);
});

test('出力タンクを変えると、古いタンクが空になり新しいタンクに入る', async () => {
  const res = await api('PATCH', `/api/distillations/${distillationId}/output`, {
    outputTankId: OUT_TANK_2,
  });

  assert.equal(res.status, 200);
  assert.equal(tankVolume(OUT_TANK), 0);
  assert.equal(tankVolume(OUT_TANK_2), 18);
});

test('既に瓶詰めで使われている量より減らそうとすると422', async () => {
  // 浄酎タンク2から15L瓶詰めする
  db.prepare(
    `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                           initial_product_stock, initial_wip_stock)
     VALUES ('prodtest', 'P001', '浄酎 300ml', 300, 35, '本', 3000, 0, 0)`
  ).run();
  db.prepare(
    `INSERT INTO tank_ledger (txn_date, from_tank_id, txn_type, to_tank_id, quantity_l, data_kind)
     VALUES ('2026-07-03', ?, '瓶詰', NULL, 15, '運用中（リアルタイム）')`
  ).run(OUT_TANK_2);
  assert.equal(tankVolume(OUT_TANK_2), 3);

  const before = distillation().output_l;
  const res = await api('PATCH', `/api/distillations/${distillationId}/output`, { outputL: 10 });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /既に瓶詰めなどで使われています/);
  assert.equal(distillation().output_l, before);
  assert.equal(tankVolume(OUT_TANK_2), 3);
});

test('蒸留中の記録では、蒸留量の口を使わせない（完了報告を使う）', async () => {
  const started = await api('POST', '/api/distillations', {
    startedOn: '2026-07-05',
    startedTime: '09:00',
    items: [{ tankId: TANK_A, volumeL: 5 }],
  });

  const res = await api('PATCH', `/api/distillations/${started.body.distillationId}/output`, {
    outputL: 3,
  });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /まだ完了していません/);
});

test('知らない項目を送ったら断る（黙って無視しない）', async () => {
  const detail = db
    .prepare('SELECT id FROM distillation_details WHERE distillation_id = ? AND is_cancelled = 0')
    .get(distillationId).id;

  const a = await api('PATCH', `/api/distillations/details/${detail}`, { rawSakeLedgerId: 1 });
  assert.equal(a.status, 400);

  const b = await api('PATCH', `/api/distillations/${distillationId}/output`, { status: '蒸留中' });
  assert.equal(b.status, 400);
});
