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

// --- 直した結果が、どの一覧を見ても同じに見えること ---
//
// 明細を差し替えても払出の行はそのまま残る（打ち消しの戻し受入を別に足す作り）。
// そのため原料受払記録の一覧だけが「有効」と言い続け、投入明細の画面では
// 「取消済み」と出ているのに一覧では生きているように見えていた。

test('差し替えられた払出は、受払一覧でも「取消済み」として出る', async () => {
  const rows = await api('GET', '/api/raw-sake-receipts?limit=200');
  assert.equal(rows.status, 200);
  const mine = rows.body.rows.filter((r) => r.distillation_id === distillationId);

  const voided = mine.filter((r) => r.txn_type === '払出' && r.detail_cancelled);
  assert.ok(voided.length >= 1, '差し替えられた払出が取消済みとして出ること');
  assert.equal(voided[0].is_cancelled, 0, '台帳の行そのものは取り消していないこと');
  assert.match(voided[0].detail_note, /修正のため差し替え/, '明細と同じ文が出ること');
  assert.match(voided[0].detail_note, /→ DTL-/, '差し替え先までたどれること');

  // 生きている払出は、その明細番号が付いて有効のまま
  const live = mine.find((r) => r.txn_type === '払出' && !r.detail_cancelled);
  assert.ok(live, '生きている払出があること');
  assert.ok(live.detail_code, '明細番号が出ること');
});

test('打ち消しの「戻し」受入は、原酒入荷と見分けられる', async () => {
  const rows = await api('GET', '/api/raw-sake-receipts?limit=200');
  const restore = rows.body.rows.find(
    (r) => r.distillation_id === distillationId && r.txn_type === '受入'
  );
  assert.ok(restore, '戻しの受入があること');
  // 受入に蒸留IDが付くのは戻しだけ。原酒入荷の受入は distillation_id が NULL
  const receipts = rows.body.rows.filter((r) => r.txn_type === '受入' && r.distillation_id == null);
  assert.ok(receipts.length >= 2, '原酒入荷の受入は蒸留IDを持たないこと');
});

test('使用原酒（表示用の文）が、生きている明細で組み直される', async () => {
  const d = distillation();
  const live = db
    .prepare(
      `SELECT t.name, d.input_l FROM distillation_details d
         JOIN tanks t ON t.id = d.source_tank_id
        WHERE d.distillation_id = ? AND d.is_cancelled = 0 ORDER BY d.id`
    )
    .all(distillationId);

  assert.equal(
    d.input_summary,
    live.map((r) => `${r.name} ${r.input_l}L`).join(' / '),
    '取り消された明細の投入元が残らないこと'
  );
  assert.equal(d.total_input_l, live.reduce((s, r) => s + r.input_l, 0));
});

// 0022 は「直しが入る前に修正された記録」を組み直すマイグレーション。
// サービス側の組み直しはこれから明細を動かしたときだけ走るので、
// 既に直してある記録（利用者の D2609-0006）は二度と直る機会がない。
// **マイグレーションの .sql をそのまま読んで流す**（試験用に書き写すと、
// 本体を直したときに食い違う）。
test('0022: 直しが入る前に修正された記録の「使用原酒」を組み直す', () => {
  const sql = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../db/migrations/0022_rebuild_corrected_input_summary.sql'),
    'utf8'
  );

  const live = db
    .prepare(
      `SELECT t.name, d.input_l FROM distillation_details d
         JOIN tanks t ON t.id = d.source_tank_id
        WHERE d.distillation_id = ? AND d.is_cancelled = 0 ORDER BY d.id`
    )
    .all(distillationId);
  const expected = live.map((r) => `${r.name} ${r.input_l}L`).join(' / ');

  // 直す前の状態（古い投入元が残っている）を作る
  db.prepare("UPDATE distillations SET input_summary = '原酒ポリ1 20L / 原酒ポリ3 10L' WHERE id = ?")
    .run(distillationId);

  db.exec(sql);

  assert.equal(
    db.prepare('SELECT input_summary FROM distillations WHERE id = ?').get(distillationId).input_summary,
    expected,
    '生きている明細から組み直されること'
  );
});

test('0022: 直していない記録には触らない', () => {
  const sql = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../db/migrations/0022_rebuild_corrected_input_summary.sql'),
    'utf8'
  );

  // 取消済みの明細を持たない蒸留を1件作る（移行で入った記録と同じ形）
  const other = db
    .prepare(
      `INSERT INTO distillations (distillation_code, started_on, started_time, input_summary, status)
       VALUES ('D9999-0001', '2026-07-01', '09:00', '原酒ポリ5 10.0L / 原酒ポリ6 20.0L', '完了')`
    )
    .run().lastInsertRowid;
  db.prepare(
    `INSERT INTO distillation_details (detail_code, distillation_id, raw_sake_ledger_id, input_l, source_tank_id)
     VALUES ('DTL-9999', ?, (SELECT id FROM raw_sake_ledger LIMIT 1), 30, ?)`
  ).run(other, TANK_A);

  db.exec(sql);

  assert.equal(
    db.prepare('SELECT input_summary FROM distillations WHERE id = ?').get(other).input_summary,
    '原酒ポリ5 10.0L / 原酒ポリ6 20.0L',
    'シートから取り込んだ文をそのまま残すこと'
  );
});

test('差し替えで作った払出にも引き当てが付く', async () => {
  const live = db
    .prepare('SELECT raw_sake_ledger_id FROM distillation_details WHERE distillation_id = ? AND is_cancelled = 0')
    .get(distillationId);

  const allocated = db
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM raw_sake_lot_allocations WHERE payout_ledger_id = ?')
    .get(live.raw_sake_ledger_id).n;
  const payout = db
    .prepare('SELECT quantity FROM raw_sake_ledger WHERE id = ?')
    .get(live.raw_sake_ledger_id).quantity;

  assert.equal(allocated, payout, '払出量ぶんが引き当てられていること');

  // 未紐付けの一覧にも残らない
  const unlinked = await api('GET', '/api/raw-sake-receipts/ledger/unlinked');
  assert.ok(
    !unlinked.body.some((r) => r.id === live.raw_sake_ledger_id),
    '差し替えた明細だけが未紐付けに残り続けないこと'
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
