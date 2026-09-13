// 残渣の行き先をタンクに紐付け、タンク別の回収累計を出せること。
//
// distillation_residues.destination は自由文で、タンクマスタと結び付いていなかった。
// 実データは7件すべて「黒タンク6」（合計 95.8L）で、タンクマスタに同名の容器は無い
// （残渣タンクは「残渣保管タンク1〜6」）。利用者に確認して U-006 だと分かったので、
// マイグレーションで紐付ける。
//
// **回収累計であって残量ではない。** 残渣には払出（廃棄）の記録がどこにも無いので、
// この数字は増えるだけで減らない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('../helpers/appHarness');

/**
 * マイグレーション本体から紐付けのUPDATE文を取り出す。
 *
 * 試験にSQLを写すと、マイグレーションを緩めても試験は通ってしまう。
 * 実際のファイルを読んで、そこに書いてある文を走らせる。
 */
function backfillSql() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../db/migrations/0018_residue_tank.sql'),
    'utf8'
  );
  const stmt = sql.split(';').find((s) => /UPDATE distillation_residues/.test(s));
  assert.ok(stmt, '0018 に紐付けのUPDATE文があること');
  return `${stmt.trim()};`;
}

const harness = createHarness('test-residue-tank.sqlite');
const api = harness.api;

let db;
let distillationId;

// タンクのid。seedで入れた順に決まる
const RAW = 1;      // SP-001 原酒ポリ1（投入元）
const JOCHU = 2;    // T-001 浄酎タンク1（出力先）
const RESIDUE = 3;  // U-001 残渣保管タンク1
const RESIDUE2 = 4; // U-002 残渣保管タンク2
const DISCARDED = 5; // U-003 残渣保管タンク3（廃棄済み）

const residues = () =>
  db.prepare('SELECT * FROM distillation_residues ORDER BY id').all();
const collected = (tankId) =>
  db.prepare('SELECT * FROM v_residue_tank_collected WHERE tank_id = ?').get(tankId);
const header = () =>
  db.prepare('SELECT residue_qty FROM distillations WHERE id = ?').get(distillationId);

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    for (const [code, name, type, max] of [
      ['SP-001', '原酒ポリ1', '原酒ポリタンク', 200],
      ['T-001', '浄酎タンク1', 'ステンレスタンク', 1000],
      ['U-001', '残渣保管タンク1', 'PP', 514],
      ['U-002', '残渣保管タンク2', 'PP', 514],
      ['U-003', '残渣保管タンク3', 'PP', 514],
    ]) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(generateUid(db, 'tanks'), code, name, type, max);
    }
    // 廃棄済みのタンクは行き先に選べないこと の確認用
    db.prepare("UPDATE tanks SET discarded_on = '2026-05-01' WHERE code = 'U-003'").run();
  }));

  await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-01', toTankId: RAW, quantity: 100,
  });
  const started = await api('POST', '/api/distillations', {
    startedOn: '2026-07-02',
    startedTime: '09:00',
    items: [{ tankId: RAW, volumeL: 60 }],
  });
  distillationId = started.body.distillationId;
});

test.after(async () => {
  await harness.teardown();
});

// --- マイグレーション ---

test('移行の紐付けは、容器IDと名称の両方が合ったときだけ行われる', () => {
  // 実データと同じ形の行を入れて、マイグレーション本体のUPDATE文を走らせる
  const sql = backfillSql();

  db.prepare(
    `INSERT INTO distillation_residues
       (distillation_id, collected_on, collected_time, quantity, destination)
     VALUES (?, '2026-06-16', '10:00', 14.8, '黒タンク6')`
  ).run(distillationId);

  db.prepare(sql).run();
  const row = db.prepare("SELECT * FROM distillation_residues WHERE destination = '黒タンク6'").get();
  assert.equal(row.destination_tank_id, null, '名前が違えば黙って別のタンクに入れないこと');

  // 容器IDだけ合っていて名前が違うタンクがあっても、紐付かない
  db.prepare(
    `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
     VALUES ('uid-u006', 'U-006', '別名のタンク', 'PP', 2137, 0)`
  ).run();
  db.prepare(sql).run();
  assert.equal(
    db.prepare("SELECT destination_tank_id FROM distillation_residues WHERE destination = '黒タンク6'")
      .get().destination_tank_id,
    null,
    '容器IDだけの一致では紐付けないこと'
  );

  // 名前も合わせると紐付く
  db.prepare("UPDATE tanks SET name = '残渣保管タンク6' WHERE code = 'U-006'").run();
  db.prepare(sql).run();
  const after = db.prepare("SELECT * FROM distillation_residues WHERE destination = '黒タンク6'").get();
  const u006 = db.prepare("SELECT id FROM tanks WHERE code = 'U-006'").get();
  assert.equal(after.destination_tank_id, u006.id);
  assert.equal(after.destination, '黒タンク6', '元の記載は消さない');

  // 以降の試験に影響させない
  db.prepare("DELETE FROM distillation_residues WHERE destination = '黒タンク6'").run();
  db.prepare("DELETE FROM tanks WHERE code = 'U-006'").run();
});

test('外部キーが壊れていない', () => {
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

// --- 蒸留完了のときの残渣 ---

test('払出先タンクを選ばずに残渣を記録しようとすると400', async () => {
  const { status } = await api('POST', `/api/distillations/${distillationId}/complete`, {
    completedOn: '2026-07-02',
    completedTime: '18:00',
    outputTankId: JOCHU,
    outputL: 20,
    residue: { collectedOn: '2026-07-02', collectedTime: '19:00', quantity: 30 },
  });
  assert.equal(status, 400);
  assert.equal(residues().length, 0, '1行も入っていないこと');
  assert.equal(
    db.prepare('SELECT status FROM distillations WHERE id = ?').get(distillationId).status,
    '蒸留中',
    '蒸留も完了していないこと（全部ロールバックされる）'
  );
});

test('残渣タンク以外を行き先にすると422', async () => {
  for (const [tankId, label] of [[JOCHU, '浄酎'], [RAW, '原酒']]) {
    const { status, body } = await api('POST', `/api/distillations/${distillationId}/complete`, {
      completedOn: '2026-07-02',
      completedTime: '18:00',
      outputTankId: JOCHU,
      outputL: 20,
      residue: {
        collectedOn: '2026-07-02', collectedTime: '19:00', quantity: 30, destinationTankId: tankId,
      },
    });
    assert.equal(status, 422, `${label}タンクは断ること`);
    assert.match(body.message, new RegExp(`${label}タンクです`));
  }
  assert.equal(residues().length, 0);
});

test('廃棄済みのタンクも行き先にできない', async () => {
  const { status, body } = await api('POST', `/api/distillations/${distillationId}/complete`, {
    completedOn: '2026-07-02',
    completedTime: '18:00',
    outputTankId: JOCHU,
    outputL: 20,
    residue: {
      collectedOn: '2026-07-02', collectedTime: '19:00', quantity: 30, destinationTankId: DISCARDED,
    },
  });
  assert.equal(status, 422);
  assert.match(body.message, /廃棄されています/);
});

test('残渣タンクを選べば完了でき、回収累計に乗る', async () => {
  assert.equal(collected(RESIDUE).collected_l, 0, '紐付ける前は0');

  const { status } = await api('POST', `/api/distillations/${distillationId}/complete`, {
    completedOn: '2026-07-02',
    completedTime: '18:00',
    outputTankId: JOCHU,
    outputL: 20,
    residue: {
      collectedOn: '2026-07-02', collectedTime: '19:00', quantity: 30, destinationTankId: RESIDUE,
    },
  });
  assert.equal(status, 200);

  const row = collected(RESIDUE);
  assert.equal(row.collected_l, 30);
  assert.equal(row.collection_count, 1);
  assert.equal(row.last_collected_on, '2026-07-02');

  // 新しい記録は自由文を持たない（タンクIDが唯一の出どころ）
  assert.equal(residues()[0].destination, null);
});

// --- 残渣の追加・編集・削除 ---

test('残渣を足すときも払出先は必須', async () => {
  const { status } = await api('POST', `/api/distillations/${distillationId}/residues`, {
    collectedOn: '2026-07-04', collectedTime: '08:00', quantity: 12,
  });
  assert.equal(status, 400);
  assert.equal(residues().length, 1, '増えていないこと');
});

test('残渣を足すと回収累計とヘッダの合計が追従する', async () => {
  const { status } = await api('POST', `/api/distillations/${distillationId}/residues`, {
    collectedOn: '2026-07-04', collectedTime: '08:00', quantity: 12, destinationTankId: RESIDUE,
  });
  assert.equal(status, 201);
  assert.equal(collected(RESIDUE).collected_l, 42, '30 + 12');
  assert.equal(collected(RESIDUE).collection_count, 2);
  assert.equal(header().residue_qty, 42, 'ヘッダのサマリも合うこと');
});

test('回収量を直すと回収累計もヘッダも合わせ直される', async () => {
  const id = residues()[1].id;
  const { status } = await api('PATCH', `/api/distillations/residues/${id}`, { quantity: 20 });
  assert.equal(status, 200);
  assert.equal(collected(RESIDUE).collected_l, 50, '30 + 20');
  assert.equal(header().residue_qty, 50);
});

test('行き先のタンクを移し替えられる', async () => {
  const id = residues()[1].id;
  const { status } = await api('PATCH', `/api/distillations/residues/${id}`, {
    destinationTankId: RESIDUE2,
  });
  assert.equal(status, 200);
  assert.equal(collected(RESIDUE).collected_l, 30, '移した分だけ減る');
  assert.equal(collected(RESIDUE2).collected_l, 20);
  assert.equal(header().residue_qty, 50, '蒸留ぜんたいの回収量は変わらない');
});

test('行き先を残渣タンク以外に移そうとすると422で、元のままになる', async () => {
  const id = residues()[1].id;
  const { status } = await api('PATCH', `/api/distillations/residues/${id}`, {
    destinationTankId: JOCHU,
  });
  assert.equal(status, 422);
  assert.equal(residues()[1].destination_tank_id, RESIDUE2, '書き換わっていないこと');
});

test('行き先を空に戻すことはできない（必須なので）', async () => {
  const id = residues()[1].id;
  const { status } = await api('PATCH', `/api/distillations/residues/${id}`, {
    destinationTankId: null,
  });
  assert.equal(status, 400);
  assert.equal(residues()[1].destination_tank_id, RESIDUE2);
});

test('残渣を消すと回収累計から外れる', async () => {
  const id = residues()[1].id;
  const { status } = await api('DELETE', `/api/distillations/residues/${id}`);
  assert.equal(status, 200);
  assert.equal(collected(RESIDUE2).collected_l, 0);
  assert.equal(collected(RESIDUE2).collection_count, 0);
  assert.equal(header().residue_qty, 30);
});

test('回収量が空の残渣があっても回収累計が壊れない', async () => {
  const add = await api('POST', `/api/distillations/${distillationId}/residues`, {
    collectedOn: '2026-07-05', collectedTime: '09:00', destinationTankId: RESIDUE,
  });
  assert.equal(add.status, 201);

  const row = collected(RESIDUE);
  assert.equal(row.collected_l, 30, '量の無い行は足されないが、合計は壊れない');
  assert.equal(row.collection_count, 2, '件数には入る');
});

// --- 画面が使う口 ---

test('残渣タンクの回収累計を返し、浄酎や原酒のタンクは混ざらない', async () => {
  const { status, body } = await api('GET', '/api/tanks/residue-collection');
  assert.equal(status, 200);

  const codes = body.tanks.map((t) => t.code);
  assert.deepEqual(codes, ['U-001', 'U-002'], '残渣タンクだけ。廃棄済みのU-003も出さない');

  const u1 = body.tanks.find((t) => t.code === 'U-001');
  assert.equal(u1.collected_l, 30);
  assert.equal(u1.fill_rate, 30 / 514, '最大容量に対する割合');
});

test('行き先が決まっていない残渣は unlinked に出る', async () => {
  db.prepare(
    `INSERT INTO distillation_residues
       (distillation_id, collected_on, collected_time, quantity, destination)
     VALUES (?, '2026-06-16', '10:00', 9.9, '黒タンク9')`
  ).run(distillationId);

  const { body } = await api('GET', '/api/tanks/residue-collection');
  assert.equal(body.unlinked.length, 1);
  assert.equal(body.unlinked[0].destination, '黒タンク9', '何と書いてあったか分かること');
  assert.ok(body.unlinked[0].distillation_code, 'どの蒸留か分かること');

  // 回収累計には入っていない（どのタンクのものか分からないため）
  const total = body.tanks.reduce((n, t) => n + t.collected_l, 0);
  assert.equal(total, 30);

  db.prepare("DELETE FROM distillation_residues WHERE destination = '黒タンク9'").run();
});

test('操作ログに行き先の変更が残る', () => {
  const logs = db
    .prepare(
      "SELECT * FROM operation_logs WHERE action = 'distillation.residue.update' ORDER BY id DESC"
    )
    .all();
  const moved = logs.find((l) => JSON.parse(l.detail_json).after?.destination_tank_id != null);
  assert.ok(moved, '移し替えが残っていること');

  const detail = JSON.parse(moved.detail_json);
  assert.equal(detail.before.destination_tank_id, RESIDUE);
  assert.equal(detail.after.destination_tank_id, RESIDUE2);
});
