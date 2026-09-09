// 蒸留記録の本体と残渣を、あとから直せること。
//
// 移行した過去の記録に誤りがあり、手で直したい。
// 直せるようにするのは**在庫に響かない項目だけ**。投入量・出力量は台帳が動くので、
// ここでは受け付けない（別の口で扱う）。
//
// 蒸留記録には備考の列が無かった。「原酒を入れ間違えたので途中で足した」のような、
// 数字にならない事情を書き残す場所が要る。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-distillation-edit.sqlite');
const api = harness.api;

let db;
let distillationId;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'SP-01', '原酒ポリ1', '原酒ポリタンク', 200, 0)`
    ).run(generateUid(db, 'tanks'));
    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'T-01', '浄酎タンク1', 'ステンレスタンク', 1000, 0)`
    ).run(generateUid(db, 'tanks'));
  }));

  // 原酒を入れて、蒸留を1件、完了まで進めておく
  await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-01', toTankId: 1, quantity: 100,
  });
  const started = await api('POST', '/api/distillations', {
    startedOn: '2026-07-02',
    startedTime: '09:00',
    plannedDuration: '8時間',
    items: [{ tankId: 1, volumeL: 60 }],
  });
  distillationId = started.body.distillationId;

  await api('POST', `/api/distillations/${distillationId}/complete`, {
    completedOn: '2026-07-02',
    completedTime: '18:00',
    outputTankId: 2,
    outputL: 20,
    outputAbv: 41,
    residue: { collectedOn: '2026-07-02', collectedTime: '19:00', quantity: 30, abv: 5 },
  });
});

test.after(async () => {
  await harness.teardown();
});

function row() {
  return db.prepare('SELECT * FROM distillations WHERE id = ?').get(distillationId);
}

test('完了した蒸留にも、備考を書ける', async () => {
  assert.equal(row().status, '完了');

  const res = await api('PATCH', `/api/distillations/${distillationId}`, {
    note: '原酒を入れ間違えたので途中で足した',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.note, '原酒を入れ間違えたので途中で足した');
  assert.equal(row().note, '原酒を入れ間違えたので途中で足した');
});

test('開始日・開始時刻・設定時間を直せる', async () => {
  const res = await api('PATCH', `/api/distillations/${distillationId}`, {
    startedOn: '2026-07-03',
    startedTime: '10:30',
    plannedDuration: '10時間',
  });

  assert.equal(res.status, 200);
  const after = row();
  assert.equal(after.started_on, '2026-07-03');
  assert.equal(after.started_time, '10:30');
  assert.equal(after.planned_duration, '10時間');
});

test('在庫に響く項目は受け付けない（黙って無視しない）', async () => {
  const before = row();

  for (const body of [{ outputL: 999 }, { outputTankId: 1 }, { status: '蒸留中' }, { outputAbv: 1 }]) {
    const res = await api('PATCH', `/api/distillations/${distillationId}`, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} が通ってしまいました`);
  }

  const after = row();
  assert.equal(after.output_l, before.output_l);
  assert.equal(after.output_tank_id, before.output_tank_id);
  assert.equal(after.status, before.status);
});

test('直す前と後の値が、操作ログに残る', async () => {
  await api('PATCH', `/api/distillations/${distillationId}`, { note: '書き直した備考' });

  const log = db
    .prepare(
      "SELECT summary, detail_json FROM operation_logs WHERE action = 'distillation.update' ORDER BY id DESC"
    )
    .get();
  assert.match(log.summary, /を直しました/);

  // 間違えたときに戻せるよう、前の値も残す
  const detail = JSON.parse(log.detail_json);
  assert.equal(detail.before.note, '原酒を入れ間違えたので途中で足した');
  assert.equal(detail.after.note, '書き直した備考');
});

test('変えていない項目は、操作ログを増やさない', async () => {
  const before = db
    .prepare("SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'distillation.update'")
    .get().c;

  // いまと同じ値を送る
  await api('PATCH', `/api/distillations/${distillationId}`, { note: '書き直した備考' });

  const after = db
    .prepare("SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'distillation.update'")
    .get().c;
  assert.equal(after, before);
});

// --- 残渣 -------------------------------------------------------------------

test('残渣の回収量を直すと、ヘッダの合計も合わせ直される', async () => {
  const residue = db
    .prepare('SELECT * FROM distillation_residues WHERE distillation_id = ?')
    .get(distillationId);
  assert.equal(row().residue_qty, 30);

  const res = await api('PATCH', `/api/distillations/residues/${residue.id}`, { quantity: 25 });

  assert.equal(res.status, 200);
  assert.equal(row().residue_qty, 25);
});

test('残渣を足せる（移行で漏れていたぶんを入れられる）', async () => {
  const res = await api('POST', `/api/distillations/${distillationId}/residues`, {
    collectedOn: '2026-07-04',
    collectedTime: '08:00',
    quantity: 12,
    saltStatus: '食塩添加済',
    destination: '残渣タンク1',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.residues.length, 2);
  assert.equal(row().residue_qty, 37); // 25 + 12
});

test('残渣を消せる。ヘッダの合計も戻る', async () => {
  const added = db
    .prepare('SELECT * FROM distillation_residues WHERE distillation_id = ? ORDER BY id DESC')
    .get(distillationId);

  const res = await api('DELETE', `/api/distillations/residues/${added.id}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.residues.length, 1);
  assert.equal(row().residue_qty, 25);

  // 消したものは戻せないので、中身を操作ログに残す
  const log = db
    .prepare(
      "SELECT detail_json FROM operation_logs WHERE action = 'distillation.residue.delete' ORDER BY id DESC"
    )
    .get();
  assert.equal(JSON.parse(log.detail_json).quantity, 12);
});

test('無い残渣を直そうとすると404', async () => {
  const res = await api('PATCH', '/api/distillations/residues/9999', { quantity: 1 });
  assert.equal(res.status, 404);
});

test('残渣の口が、蒸留IDの口に飲み込まれていない', async () => {
  // ルートを書く順で PATCH /residues/5 が id="residues" として拾われる事故が起きる
  const res = await api('PATCH', '/api/distillations/residues/9999', { quantity: 1 });
  assert.equal(res.status, 404);
  assert.match(res.body.message ?? '', /残渣回収記録が見つかりません/);
});

test('無い蒸留を直そうとすると404', async () => {
  const res = await api('PATCH', '/api/distillations/9999', { note: 'x' });
  assert.equal(res.status, 404);
});
