// 原酒入荷のまとめ登録。
//
// 原酒ポリタンクは20Lで25本まとめて入荷することがある。1本ずつ送っていると
// 25回の送信になるので、表で選んで1回で入れられるようにした。
//
// 大事なのは2つ。
//   ・伝票番号が連番で重複しないこと（1件ずつ採ると月ぶんを毎回読み直すので、
//     まとめて採る作りに変えた）
//   ・途中で失敗したら1件も入らないこと（何本目まで入ったか分からない状態を作らない）

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-rawsake-bulk.sqlite');
const api = harness.api;

// SP-001〜025 … まとめ登録の試験で全部埋める
// SP-026〜030 … そのあとの試験のために空で残しておく
//   （空のタンクにしか受け入れられなくなったので、埋めた本は再利用できない）
const BULK_COUNT = 25;
const TANK_COUNT = 30;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 実データと同じく、容器種別は材質（PE）で入っている。
    // 原酒タンクかどうかは容器IDの SP- で判定する
    for (let i = 1; i <= TANK_COUNT; i++) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, 'PE', 20, 0)`
      ).run(generateUid(db, 'tanks'), `SP-${String(i).padStart(3, '0')}`, `原酒ポリ${i}`);
    }
    // 原酒タンクではない容器（実データの画面にはこれらが混ざって出ていた）
    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'JP-003', '出荷用ポリタンク3', 'PE', 20, 3)`
    ).run(generateUid(db, 'tanks'));
    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'Q-010', 'テナー10', 'QBテナー', 20, 9)`
    ).run(generateUid(db, 'tanks'));
  }));
});

const JP_TANK_ID = TANK_COUNT + 1;

test.after(async () => {
  await harness.teardown();
});

/** 原酒ポリ1〜25 に各20L */
function allTanks(quantity = 20) {
  return Array.from({ length: BULK_COUNT }, (_, i) => ({ toTankId: i + 1, quantity }));
}

function ledgerCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM raw_sake_ledger WHERE txn_type = '受入'").get().c;
}

function tankVolume(tankId) {
  return db
    .prepare('SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE tank_id = ?')
    .get(tankId).current_volume_l;
}

test('原酒ポリ1〜25に各20Lを、1回の送信でまとめて登録できる', async () => {
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-10',
    supplier: '鳥屋酒造',
    items: allTanks(20),
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.count, 25);
  assert.equal(res.body.totalL, 500);
  assert.equal(ledgerCount(), 25);

  // 伝票番号は連番で、重複しない
  const codes = res.body.rows.map((r) => r.lotCode);
  assert.equal(new Set(codes).size, 25);
  assert.deepEqual(codes.slice(0, 3), ['R2609-1000', 'R2609-1001', 'R2609-1002']);

  // 各タンクの残量が、それぞれの受入量ぶん増える
  for (let id = 1; id <= BULK_COUNT; id++) assert.equal(tankVolume(id), 20);
});

test('タンクごとに数量を変えられる（満量でない本が混ざっても入る）', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-11',
    items: [
      { toTankId: 26, quantity: 20 },
      { toTankId: 27, quantity: 12.5 },
    ],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.totalL, 32.5);
  assert.equal(ledgerCount(), before + 2);
  assert.equal(tankVolume(26), 20);
  assert.equal(tankVolume(27), 12.5);
});

test('同じタンクを2行入れたら断る（どちらが正しいか決められないため）', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-12',
    items: [
      { toTankId: 28, quantity: 20 },
      { toTankId: 28, quantity: 18 },
    ],
  });

  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /同じ受入先タンク/);
  assert.equal(ledgerCount(), before);
});

test('1件でも存在しないタンクがあれば、1件も入らない', async () => {
  const before = ledgerCount();

  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-13',
    items: [
      { toTankId: 28, quantity: 20 },
      { toTankId: 9999, quantity: 20 },
    ],
  });

  assert.equal(res.status, 404);
  // 途中まで入って「何本目まで入ったか分からない」状態にしない
  assert.equal(ledgerCount(), before);
});

// --- 受入先を原酒タンクの空きだけに絞る ------------------------------------

test('受入先の候補は、原酒タンク（SP-）だけ', async () => {
  const res = await api('GET', '/api/raw-sake-receipts/tanks/receivable');

  assert.equal(res.status, 200);
  assert.equal(res.body.length, TANK_COUNT);
  for (const t of res.body) assert.match(t.code, /^SP-/);

  // 画面に混ざって出ていた容器が入っていないこと
  const codes = res.body.map((t) => t.code);
  assert.ok(!codes.includes('JP-003'), '出荷用ポリタンクが候補に出ています');
  assert.ok(!codes.includes('Q-010'), 'テナーが候補に出ています');
});

test('候補には、空でないタンクも「空ではない」と分かる形で入る', async () => {
  // 消してしまうと「原酒ポリ1が出てこないのはなぜか」が分からなくなる
  const { body } = await api('GET', '/api/raw-sake-receipts/tanks/receivable');
  const used = body.find((t) => t.code === 'SP-001');
  assert.equal(used.is_empty, 0);
  assert.equal(used.current_volume_l, 20);

  const empty = body.find((t) => t.code === 'SP-028');
  assert.equal(empty.is_empty, 1);
});

test('原酒タンクでない容器には受け入れられない', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-17',
    items: [{ toTankId: JP_TANK_ID, quantity: 20 }],
  });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /原酒タンクではありません/);
  assert.equal(ledgerCount(), before);
});

test('前の原酒が残っているタンクには受け入れられない', async () => {
  // SP-001 には最初の試験で20L入っている
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-18',
    items: [{ toTankId: 1, quantity: 20 }],
  });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /残っています/);
  assert.equal(ledgerCount(), before);
});

test('1件でも使用中のタンクが混ざっていたら、1件も入らない', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-19',
    items: [
      { toTankId: 28, quantity: 20 }, // 空
      { toTankId: 1, quantity: 20 },  // 使用中
    ],
  });

  assert.equal(res.status, 422);
  assert.equal(ledgerCount(), before);
  assert.equal(tankVolume(28), 0);
});

test('1件ずつの登録にも同じ制限がかかる（画面だけの制限にしない）', async () => {
  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-20',
    toTankId: JP_TANK_ID,
    quantity: 20,
  });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /原酒タンクではありません/);
});

test('操作ログに、まとめて入れたことが1本だけ残る', async () => {
  const before = db
    .prepare("SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'rawSake.receipt.bulk'")
    .get().c;

  await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-14',
    items: [
      { toTankId: 28, quantity: 20 },
      { toTankId: 29, quantity: 20 },
    ],
  });

  const logs = db
    .prepare(
      `SELECT summary, detail_json FROM operation_logs
        WHERE action = 'rawSake.receipt.bulk' ORDER BY id DESC`
    )
    .all();
  assert.equal(logs.length, before + 1);
  assert.match(logs[0].summary, /2件・合計40L/);
  assert.equal(JSON.parse(logs[0].detail_json).count, 2);
});

test('1件ずつの登録は、これまで通り動く', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-15',
    toTankId: 30,
    quantity: 20,
  });

  assert.equal(res.status, 201);
  assert.equal(ledgerCount(), before + 1);
  assert.equal(tankVolume(30), 20);

  // 単発にも操作ログが残るようになった（今までは残っていなかった）
  const log = db
    .prepare("SELECT summary FROM operation_logs WHERE action = 'rawSake.receipt' ORDER BY id DESC")
    .get();
  assert.match(log.summary, /原酒入荷 20L/);
});

test('まとめ登録のあとに1件ずつ登録しても、伝票番号がぶつからない', async () => {
  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-16',
    toTankId: 25,
    quantity: 20,
  });
  // SP-025 は最初のまとめ登録で埋まっているので、ここでは断られる
  assert.equal(res.status, 422);

  const codes = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE lot_code LIKE 'R2609-%'")
    .all()
    .map((r) => r.lot_code);
  assert.equal(new Set(codes).size, codes.length);
});
