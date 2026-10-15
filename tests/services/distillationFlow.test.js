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
  // 原酒は空のタンクにしか受け入れられないので、受入の試験用に空のまま1本残す
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, 'SP-03', '原酒ポリタンク3', '原酒ポリタンク', 200, 0)`
  ).run(generateUid(db, 'tanks'));
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, 'T-01', '浄酎タンク1', 'ステンレスタンク', 1000, 0)`
  ).run(generateUid(db, 'tanks'));
  // 残渣の行き先（id=5）。容器IDの接頭辞 U- が残渣タンクの目印
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES (?, 'U-001', '残渣保管タンク1', 'PP', 514, 0)`
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

test('原酒受払IDは、千の位に移入の回数が出る（4-9）', async () => {
  // 直前の2件は 07-20 と 07-21。**日付が違えば別の回**なので、
  // 1回目が 1001、2回目が 2001 になる。
  // 以前は受入を 1000 から1ずつ連番にしており、2回目が 1001 になっていた
  // （要件の「回数ごとに千の位を+1」が仕様書に落ちていなかったため）。
  const codes = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE txn_type = '受入' ORDER BY id")
    .all()
    .map((r) => r.lot_code);
  assert.deepEqual(codes, ['R2607-1001', 'R2607-2001']);
});

test('受入元は専用の列に入り、備考と同時に書いても消えない', async () => {
  // 以前は備考へ「受入元: ○○」と文字列で押し込んでいたため、
  // 受入元と備考を両方書くと備考のほうが失われていた。
  const { status, body } = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-22',
    toTankId: 3,
    quantity: 10,
    supplier: '鳥屋原酒タンク',
    note: '容器を入れ替えて受入',
  });
  assert.equal(status, 201);

  const row = db
    .prepare('SELECT source_ref, note FROM raw_sake_ledger ORDER BY id DESC LIMIT 1')
    .get();
  assert.equal(row.source_ref, '鳥屋原酒タンク');
  assert.equal(row.note, '容器を入れ替えて受入');

  // 元の残量に戻しておく（以降のテストが80Lを前提にしている）
  db.prepare('DELETE FROM raw_sake_ledger WHERE id = (SELECT MAX(id) FROM raw_sake_ledger)').run();
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

test('投入明細には DTL- の明細IDが振られる', async () => {
  const codes = db
    .prepare('SELECT detail_code FROM distillation_details ORDER BY id')
    .all()
    .map((r) => r.detail_code);
  assert.deepEqual(codes, ['DTL-1', 'DTL-2']);
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
      destinationTankId: 5, // 残渣保管タンク1
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
  assert.equal(detail.body.residues[0].destination_tank_id, 5, '行き先のタンクが残ること');
  assert.equal(detail.body.residues[0].destination_tank_name, '残渣保管タンク1');
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

// --- 払出を複数回に分けて記録する（二次蒸留・分割払出） ----------------------
//
// 10/09 の長野浄酎の蒸留で必要になった。
//   投入27.0L → 一次 13.3L/36.01% → 残渣を**蒸留機に残したまま**二次にかけて 0.8L/2.82%
//   （出荷タンク4に0.4L・出荷タンク7に0.4L）→ 最終残渣 12.9L
//
// **投入は27Lの1回きり。** 二次蒸留を別の蒸留記録にすると、投入27Lを2回
// （計40.7L）記録することになり、原酒が二重に減る。
// 1件の蒸留が払出を複数持てる形にして、投入は増やさない。

const outputsOf = (id) =>
  db
    .prepare(
      `SELECT * FROM tank_ledger
        WHERE distillation_id = ? AND txn_type = '継足' AND is_cancelled = 0
        ORDER BY id`
    )
    .all(id);

const header = (id) => db.prepare('SELECT * FROM distillations WHERE id = ?').get(id);
/** 浮動小数の誤差で落ちないように、比べる前に丸める */
const round3 = (v) => Number(v.toFixed(3));
const tankVolume = (tankId) =>
  db.prepare('SELECT current_volume_l AS v FROM v_tank_monitor WHERE tank_id = ?').get(tankId).v;

let twoPass = null; // この節で使う蒸留

test('二次蒸留のための蒸留を1件用意する（投入27L・一次払出13.3L）', async () => {
  // 払出先をもう1本増やす（分割払出を見るため）
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES ('tnk00099', 'T-02', '浄酎タンク2', 'ステンレスタンク', 1000, 0)`
  ).run();

  const started = await api('POST', '/api/distillations', {
    startedOn: '2026-10-09',
    startedTime: '12:57',
    plannedDuration: '1時間22分',
    items: [{ tankId: 1, volumeL: 27 }],
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  twoPass = started.body.distillationId;

  const done = await api('POST', `/api/distillations/${twoPass}/complete`, {
    completedOn: '2026-10-09',
    completedTime: '14:19',
    outputTankId: 4,
    outputL: 13.3,
    outputAbv: 36.01,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  assert.equal(outputsOf(twoPass).length, 1);
  assert.equal(header(twoPass).output_l, 13.3);
  assert.equal(header(twoPass).output_tank_id, 4, '払出先が1つならそのタンクが入る');
});

test('完了したあとに払出を足せる（二次蒸留ぶん）', async () => {
  const before = tankVolume(4);

  const res = await api('POST', `/api/distillations/${twoPass}/outputs`, {
    collectedOn: '2026-10-09',
    collectedTime: '16:00',
    outputTankId: 4,
    outputL: 0.4,
    outputAbv: 2.82,
    note: '二次蒸留: 残渣13.7Lを蒸留機に残したまま再蒸留',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(outputsOf(twoPass).length, 2, '継足が払出の数だけできること');
  assert.equal(round3(tankVolume(4)), round3(before + 0.4), '浄酎タンクが足した分だけ増える');
});

test('1回の払出を2つのタンクに分けられる', async () => {
  const res = await api('POST', `/api/distillations/${twoPass}/outputs`, {
    collectedOn: '2026-10-09',
    collectedTime: '16:00',
    outputTankId: 6, // 浄酎タンク2
    outputL: 0.4,
    outputAbv: 2.82,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  assert.equal(outputsOf(twoPass).length, 3);
  assert.equal(tankVolume(6), 0.4);
});

test('ヘッダは合計と加重平均になる（単純平均ではない）', () => {
  const h = header(twoPass);

  // 13.3 + 0.4 + 0.4
  assert.equal(h.output_l, 14.1);

  // (13.3×36.01 + 0.4×2.82 + 0.4×2.82) ÷ 14.1 = 34.13
  // 単純平均なら (36.01+2.82+2.82)÷3 = 13.88 になるので、取り違えたら落ちる
  assert.equal(h.output_abv, 34.13);

  assert.equal(h.output_tank_id, null, '払出先が複数なら、どれか1つを代表にしない');
});

test('払出を足しても投入は増えない（原酒が二重に減らない）', () => {
  const h = header(twoPass);
  assert.equal(h.total_input_l, 27, '投入は27Lの1回きりのまま');

  const drawn = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS q FROM raw_sake_ledger
        WHERE distillation_id = ? AND txn_type = '払出' AND is_cancelled = 0`
    )
    .get(twoPass).q;
  assert.equal(drawn, 27, '原酒の払出も27Lのまま');
});

test('完了していない蒸留には払出を足せない', async () => {
  const started = await api('POST', '/api/distillations', {
    startedOn: '2026-10-10',
    startedTime: '19:35',
    items: [{ tankId: 1, volumeL: 5 }],
  });
  const openId = started.body.distillationId;

  const res = await api('POST', `/api/distillations/${openId}/outputs`, {
    outputTankId: 4,
    outputL: 1,
  });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /まだ完了していません/);

  // 完了していれば通ること（対で見ないと空振りする）
  await api('POST', `/api/distillations/${openId}/complete`, {
    completedOn: '2026-10-10',
    completedTime: '21:02',
    outputTankId: 4,
    outputL: 2,
    outputAbv: 30,
  });
  const ok = await api('POST', `/api/distillations/${openId}/outputs`, {
    outputTankId: 4,
    outputL: 1,
    outputAbv: 10,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('払出が複数あるときは「蒸留量を直す」で一括変更できない', async () => {
  // ここは継足を全部取り消して1行にまとめるので、二次蒸留ぶんが黙って消える
  const res = await api('PATCH', `/api/distillations/${twoPass}/output`, { outputL: 99 });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.match(res.body.message, /払出が3件あります/);

  assert.equal(outputsOf(twoPass).length, 3, '断ったのに継足が消えています');
  assert.equal(header(twoPass).output_l, 14.1);
});

test('払出を1件取り消すと、継足も消えてヘッダが引き直される', async () => {
  const rows = outputsOf(twoPass);
  const target = rows[rows.length - 1]; // 浄酎タンク2 への 0.4L
  assert.equal(tankVolume(6), 0.4, '取消前は入っていること');

  const res = await api('DELETE', `/api/distillations/outputs/${target.id}`, {
    reason: '入力間違い',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal(outputsOf(twoPass).length, 2);
  assert.equal(tankVolume(6), 0, '取り消した分が戻っていません');

  const h = header(twoPass);
  assert.equal(h.output_l, 13.7, '合計が引き直されていません');
  assert.equal(h.output_tank_id, 4, '残りが1タンクに戻ったら、そのタンクが入る');
});

test('払出の明細が読める', async () => {
  const res = await api('GET', `/api/distillations/${twoPass}/outputs`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.ok(res.body[0].tank_name, '払出先のタンク名が出ること');
  assert.match(res.body[1].note, /二次蒸留/);
});

test('継足でない記録は払出として取り消せない', async () => {
  const other = db
    .prepare("SELECT id FROM tank_ledger WHERE txn_type <> '継足' AND is_cancelled = 0 LIMIT 1")
    .get();
  if (!other) return; // 対象が無ければこの確認は飛ばす

  const res = await api('DELETE', `/api/distillations/outputs/${other.id}`, { reason: '誤操作' });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /払出（継足）ではありません/);
});
