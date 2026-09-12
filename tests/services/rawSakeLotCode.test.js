// 原酒受払IDの採番。千の位が「その月の何回目の移入か」を表すこと。
//
// 要件（1回目は1001〜、2回目は2001〜）が実装に落ちていなかった。
// DATA_STRUCTURE.md 4-9 F列には「払出は0001から、受入は1000刻み」とだけ書かれており、
// 「回数ごとに千の位を+1」が抜けていたため、受入は 1000 から1ずつの連番になっていた。
// 同じ月の2回目の移入が 1026, 1027… と1回目の続きになる。
//
// 旧シートの実データもこの構造（1回の移入が1日で完結し、下3桁が原酒ポリの本数ぶん）:
//   R2508-3009,3010 / R2603-0001〜0026 / R2606-2001〜2026 / R2607-1001〜1025
// ただし千の位は 3/0/2/1 とばらついており、帯の前提には頼れない。

const { createHarness } = require('../helpers/appHarness');

// src/ の require は createHarness のあとに置く（先に読むと運用中のDBを掴む）
const harness = createHarness('test-rawsake-code.sqlite');
const api = harness.api;
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextRawSakeLotCodes } = require('../../src/utils/rawSakeCode');

let db;

/** 台帳に1行入れる（移行で入った記録と同じ形） */
function ledger(db, { code, date, type, toTank = null, fromTank = null, qty = 20 }) {
  db.prepare(
    `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, to_tank_id, from_tank_id, quantity)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(code, date, type, toTank, fromTank, qty);
}

const codes = (txnType, date, count = 3) => nextRawSakeLotCodes(db, txnType, date, count);

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const tank = db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, ?, ?, 'PE', 20, 0)`
    );
    // まとめ入力は**空の原酒タンクにしか受け入れられない**（#30）。
    // 前の試験で原酒が入るので、まとめ入力用に別の空タンクを用意しておく
    for (let i = 1; i <= 8; i += 1) {
      tank.run(generateUid(db, 'tanks'), `SP-00${i}`, `原酒ポリ${i}`);
    }
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('受入が無い月の1回目は 1001 から（1000 ではない）', () => {
  assert.deepEqual(codes('受入', '2026-09-05'), ['R2609-1001', 'R2609-1002', 'R2609-1003']);
});

test('同じ日付に足すと、同じ回の続き番号になる', () => {
  ledger(db, { code: 'R2609-1001', date: '2026-09-05', type: '受入', toTank: 1 });
  ledger(db, { code: 'R2609-1002', date: '2026-09-05', type: '受入', toTank: 2 });

  // 入れ忘れを同じ日に足すだけなので、2回目扱いにはしない
  assert.deepEqual(codes('受入', '2026-09-05', 2), ['R2609-1003', 'R2609-1004']);
});

test('新しい日付は2回目として 2001 から', () => {
  assert.deepEqual(codes('受入', '2026-09-20', 2), ['R2609-2001', 'R2609-2002']);
});

test('3回目は 3001 から', () => {
  ledger(db, { code: 'R2609-2001', date: '2026-09-20', type: '受入', toTank: 1 });

  assert.deepEqual(codes('受入', '2026-09-25', 2), ['R2609-3001', 'R2609-3002']);
});

test('月をまたぐと1回目に戻る', () => {
  assert.deepEqual(codes('受入', '2026-10-01', 2), ['R2610-1001', 'R2610-1002']);
});

test('後から前の日付を足しても、既にある番号は動かない', () => {
  const before = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE lot_code LIKE 'R2609-%' ORDER BY lot_code")
    .all()
    .map((r) => r.lot_code);

  // 9月に入っているのは 09-05(1帯の2件) と 09-20(2帯の1件)。そこへ 09-01 を足す
  const added = codes('受入', '2026-09-01', 1);

  assert.deepEqual(added, ['R2609-3001'], '日付順ではなく、使われている最大の帯の次を使う');
  assert.deepEqual(
    db.prepare("SELECT lot_code FROM raw_sake_ledger WHERE lot_code LIKE 'R2609-%' ORDER BY lot_code")
      .all()
      .map((r) => r.lot_code),
    before,
    '既存の番号が振り直されています'
  );
});

test('払出は 0001 から（移入ではないので回数を持たない）', () => {
  assert.deepEqual(codes('払出', '2026-09-10', 2), ['R2609-0001', 'R2609-0002']);
});

test('棚卸調整・欠減も 0帯に入る（移入の回数を食わない）', () => {
  ledger(db, { code: 'R2609-0001', date: '2026-09-10', type: '払出', fromTank: 1, qty: 5 });

  // PR D2 で足す区分。回数の帯ではなく払出と同じ0帯を使う
  assert.deepEqual(codes('棚卸調整', '2026-09-11', 1), ['R2609-0002']);
  assert.deepEqual(codes('欠減', '2026-09-11', 1), ['R2609-0002']);
});

test('移行データが帯を守っていなくても、番号が衝突しない', () => {
  // 実データの R2603 は「受入」が 0001〜0026（払出の帯）を占有している
  for (let i = 1; i <= 5; i += 1) {
    ledger(db, {
      code: `R2603-${String(i).padStart(4, '0')}`,
      date: '2026-03-19',
      type: '受入',
      toTank: 1,
    });
  }

  // 払出の採番は0帯を見るが、受入が使っている番号は飛ばす
  assert.deepEqual(codes('払出', '2026-03-25', 2), ['R2603-0006', 'R2603-0007']);
  // 新しい日付の受入は、0帯の次の帯へ
  assert.deepEqual(codes('受入', '2026-03-25', 1), ['R2603-1001']);
  // 同じ日付に足すなら 0帯の続き
  assert.deepEqual(codes('受入', '2026-03-19', 1), ['R2603-0006']);
});

test('実データと同じく、払出が受入帯に混ざっていても0帯だけを見る', () => {
  // R2606 は払出が 1001,1002 を使っている（実データ）
  ledger(db, { code: 'R2606-0001', date: '2026-06-01', type: '払出', fromTank: 1, qty: 5 });
  ledger(db, { code: 'R2606-1001', date: '2026-06-24', type: '払出', fromTank: 1, qty: 9 });
  ledger(db, { code: 'R2606-1002', date: '2026-06-24', type: '払出', fromTank: 1, qty: 18 });

  // 1000帯の払出に引きずられず、0帯の続きを採る
  assert.deepEqual(codes('払出', '2026-06-30', 1), ['R2606-0002']);
  // 受入は、払出が使っている 1001,1002 を飛ばす
  assert.deepEqual(codes('受入', '2026-06-30', 2), ['R2606-1003', 'R2606-1004']);
});

test('帯を使い切ったら、隣の帯へ黙って入れずに断る', () => {
  assert.throws(
    () => codes('受入', '2026-11-05', 1000),
    (err) => {
      assert.match(err.message, /使い切りました/);
      assert.equal(err.status ?? err.statusCode, 422);
      return true;
    }
  );
});

test('まとめ入力でも、1回の移入として連番になる', async () => {
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-12-03',
    items: [
      { toTankId: 4, quantity: 20 },
      { toTankId: 5, quantity: 20 },
      { toTankId: 6, quantity: 20 },
    ],
  });

  assert.equal(res.status, 201);
  const saved = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE lot_code LIKE 'R2612-%' ORDER BY lot_code")
    .all()
    .map((r) => r.lot_code);
  assert.deepEqual(saved, ['R2612-1001', 'R2612-1002', 'R2612-1003']);
});

test('同じ月に2回目のまとめ入力をすると 2001 から', async () => {
  const res = await api('POST', '/api/raw-sake-receipts/bulk', {
    txnDate: '2026-12-20',
    items: [
      { toTankId: 7, quantity: 20 },
      { toTankId: 8, quantity: 20 },
    ],
  });

  assert.equal(res.status, 201);
  const second = db
    .prepare("SELECT lot_code FROM raw_sake_ledger WHERE txn_date = '2026-12-20' ORDER BY lot_code")
    .all()
    .map((r) => r.lot_code);
  assert.deepEqual(second, ['R2612-2001', 'R2612-2002']);
});
