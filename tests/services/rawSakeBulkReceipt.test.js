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

const TANK_COUNT = 25;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    for (let i = 1; i <= TANK_COUNT; i++) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, '原酒ポリタンク', 20, 0)`
      ).run(generateUid(db, 'tanks'), `SP-${String(i).padStart(3, '0')}`, `原酒ポリ${i}`);
    }
  }));
});

test.after(async () => {
  await harness.teardown();
});

/** 原酒ポリ1〜25 に各20L */
function allTanks(quantity = 20) {
  return Array.from({ length: TANK_COUNT }, (_, i) => ({ toTankId: i + 1, quantity }));
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
  for (let id = 1; id <= TANK_COUNT; id++) assert.equal(tankVolume(id), 20);
});

test('タンクごとに数量を変えられる（満量でない本が混ざっても入る）', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-11',
    items: [
      { toTankId: 1, quantity: 20 },
      { toTankId: 2, quantity: 12.5 },
    ],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.totalL, 32.5);
  assert.equal(ledgerCount(), before + 2);
  assert.equal(tankVolume(1), 40);
  assert.equal(tankVolume(2), 32.5);
});

test('同じタンクを2行入れたら断る（どちらが正しいか決められないため）', async () => {
  const before = ledgerCount();
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-12',
    items: [
      { toTankId: 3, quantity: 20 },
      { toTankId: 3, quantity: 18 },
    ],
  });

  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /同じ受入先タンク/);
  assert.equal(ledgerCount(), before);
});

test('1件でも存在しないタンクがあれば、1件も入らない', async () => {
  const before = ledgerCount();
  const volumeBefore = tankVolume(4);

  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-13',
    items: [
      { toTankId: 4, quantity: 20 },
      { toTankId: 9999, quantity: 20 },
    ],
  });

  assert.equal(res.status, 404);
  // 途中まで入って「何本目まで入ったか分からない」状態にしない
  assert.equal(ledgerCount(), before);
  assert.equal(tankVolume(4), volumeBefore);
});

test('操作ログに、まとめて入れたことが1本だけ残る', async () => {
  const before = db
    .prepare("SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'rawSake.receipt.bulk'")
    .get().c;

  await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-09-14',
    items: [
      { toTankId: 5, quantity: 20 },
      { toTankId: 6, quantity: 20 },
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
  const volumeBefore = tankVolume(7);
  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-15',
    toTankId: 7,
    quantity: 20,
  });

  assert.equal(res.status, 201);
  assert.equal(ledgerCount(), before + 1);
  assert.equal(tankVolume(7), volumeBefore + 20);

  // 単発にも操作ログが残るようになった（今までは残っていなかった）
  const log = db
    .prepare("SELECT summary FROM operation_logs WHERE action = 'rawSake.receipt' ORDER BY id DESC")
    .get();
  assert.match(log.summary, /原酒入荷 20L/);
});

test('まとめ登録のあとに1件ずつ登録しても、伝票番号がぶつからない', async () => {
  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-16',
    toTankId: 8,
    quantity: 20,
  });
  assert.equal(res.status, 201);

  const codes = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE lot_code LIKE 'R2609-%'")
    .all()
    .map((r) => r.lot_code);
  assert.equal(new Set(codes).size, codes.length);
});
