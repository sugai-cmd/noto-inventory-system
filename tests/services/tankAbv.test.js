// タンクの度数を、浄酎容器変動履歴から計算すること。
//
// これまでは tanks.current_abv をそのまま出していた。あの列は旧シートの
// 「理論アルコール度数」を取り込んだもので、**単位が混ざっている**
// （実データで ステンレスタンク1=0.34・2=0.35 は割合、出荷用ポリタンク3=35 は％）。
// 一律100倍すると出荷用ポリタンク3が 3500% になる。
//
// さらに悪いのは、この値が台帳へ漏れること。容器移動・未納税移出・瓶詰めの
// どれもが「度数が未入力なら current_abv を使う」で tank_ledger.abv に書いていた。
// 台帳は全件％で揃っているので、そこに 0.34 が1行混ざる。

const { createHarness } = require('../helpers/appHarness');

// src/ の require は createHarness のあとに置く（先に読むと運用中のDBを掴む）
const harness = createHarness('test-tank-abv.sqlite');
const api = harness.api;
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTankAbv, computeTankState } = require('../../src/services/tankService');

let db;

const A = 1; // T-001 初期100L・度数マスタは 0.34（割合。使ってはいけない）
const B = 2; // T-002 初期0L
const C = 3; // T-003 初期50L・継足なし（度数が分からないタンク）
const NEG = 4; // JP-001 残量がマイナスになる
const UNTOUCHED = 5; // T-009 台帳に1行も無い（実データの一斗瓶と同じ）

/** 台帳に1行入れる */
function ledger(db, { date, type, from = null, to = null, qty, abv = null, cancelled = 0 }) {
  return db
    .prepare(
      `INSERT INTO tank_ledger (txn_date, txn_type, from_tank_id, to_tank_id, quantity_l, abv, is_cancelled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(date, type, from, to, qty, abv, cancelled).lastInsertRowid;
}

const abvOf = (tankId) => computeTankAbv(db).get(tankId);
const volumeOf = (tankId) =>
  db.prepare('SELECT current_volume_l FROM v_tank_monitor WHERE tank_id = ?').get(tankId).current_volume_l;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const tank = db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l, current_abv)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    // current_abv は実データと同じく単位を混ぜて入れる（使われていないことを確かめるため）
    tank.run(generateUid(db, 'tanks'), 'T-001', 'ステンレスタンク1', 'ステンレスタンク', 1000, 100, 0.34);
    tank.run(generateUid(db, 'tanks'), 'T-002', 'ステンレスタンク2', 'ステンレスタンク', 1000, 0, 0.35);
    tank.run(generateUid(db, 'tanks'), 'T-003', 'ステンレスタンク3', 'ステンレスタンク', 1000, 50, 0);
    tank.run(generateUid(db, 'tanks'), 'JP-001', '出荷用ポリ1', 'PE', 20, 0, 35);
    // どの試験も触らないタンク。度数が分からないままであることの確認に使う
    tank.run(generateUid(db, 'tanks'), 'T-009', '一斗瓶6', '斗瓶', 19.9, 19.9, 0);

    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'P001', '浄酎 300ml', 300, 35, '本', 3000, 0, 0)`
    ).run(generateUid(db, 'products'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('継足の度数が、液量で重みをつけて混ざる', () => {
  // 初期100L（度数は分からない）＋ 継足100L@40% → 前が不明なので入れた液の度数になる
  ledger(db, { date: '2026-07-01', type: '継足', to: A, qty: 100, abv: 40 });
  assert.equal(abvOf(A), 40);

  // さらに 200L@30% を足すと (200×40 + 200×30) / 400 = 35
  ledger(db, { date: '2026-07-02', type: '継足', to: A, qty: 200, abv: 30 });
  assert.equal(abvOf(A), 35);
  assert.equal(volumeOf(A), 400);
});

test('マスタの current_abv は使わない', () => {
  // マスタは 0.34 のままだが、計算結果は台帳から出た 35
  assert.equal(db.prepare('SELECT current_abv FROM tanks WHERE id = ?').get(A).current_abv, 0.34);
  assert.equal(abvOf(A), 35);
});

test('払出は度数を変えない', () => {
  const before = abvOf(A);
  ledger(db, { date: '2026-07-03', type: '瓶詰', from: A, qty: 100 });

  assert.equal(abvOf(A), before);
  assert.equal(volumeOf(A), 300);
});

test('度数を持たない容器移動は、出す側のその時点の度数を引き継ぐ', () => {
  // 実データでは容器移動12件のうち11件が度数を持たない
  ledger(db, { date: '2026-07-04', type: '容器移動', from: A, to: B, qty: 100, abv: null });

  assert.equal(abvOf(B), 35, '移動元の度数が引き継がれていません');
  assert.equal(abvOf(A), 35, '出した側は変わらない');
  assert.equal(volumeOf(A), 200);
  assert.equal(volumeOf(B), 100);
});

test('棚卸で入れた度数は、混ぜずに置き換える', () => {
  // 棚卸はタンク全体を測った値。加重平均に混ぜると、測った意味がなくなる
  ledger(db, { date: '2026-07-05', type: '棚卸調整', to: B, qty: 10, abv: 33.5 });

  assert.equal(abvOf(B), 33.5);
  assert.equal(volumeOf(B), 110);
});

test('欠減でも、度数が入っていれば測定値として置き換える', () => {
  ledger(db, { date: '2026-07-06', type: '欠減', from: B, qty: 10, abv: 32 });

  assert.equal(abvOf(B), 32);
  assert.equal(volumeOf(B), 100);
});

test('台帳に度数を運ぶ行が無いタンクは null（0とは言わない）', () => {
  // 実データのステンレスタンク3・一斗瓶1がこれ。液量は移行時の初期在庫のまま
  assert.equal(abvOf(C), null);
  assert.equal(volumeOf(C), 50);
});

test('取消済みの行は数えない', () => {
  const before = { abv: abvOf(A), volume: volumeOf(A) };
  ledger(db, { date: '2026-07-07', type: '継足', to: A, qty: 500, abv: 10, cancelled: 1 });

  assert.equal(abvOf(A), before.abv);
  assert.equal(volumeOf(A), before.volume);
});

test('度数0の継足も、記録どおりの値として扱う（実データに1件ある）', () => {
  // 0.1L の 0% が1件ある。0を「不明」と読み替えると記録を勝手に変えることになる。
  // 量が小さいので影響もごくわずか（200L@35% に 0.1L@0% → 34.98%）
  ledger(db, { date: '2026-07-08', type: '継足', to: A, qty: 0.1, abv: 0 });

  assert.equal(abvOf(A), 34.98);
});

test('残量がマイナスでも落ちない（実データに2本ある）', () => {
  ledger(db, { date: '2026-07-09', type: '瓶詰', from: NEG, qty: 13.2 });

  assert.equal(volumeOf(NEG), -13.2);
  assert.equal(abvOf(NEG), null);
  // 0除算でNaNやInfinityにならないこと
  ledger(db, { date: '2026-07-10', type: '継足', to: NEG, qty: 5, abv: 35 });
  assert.equal(abvOf(NEG), 35);
});

test('払出先と受入先が同じ行があっても、液量がビューと食い違わない', () => {
  // 実データに1件ある（移行時に報告済み）。v_tank_monitor は to_tank_id を先に見るので
  // 「+24」としてだけ数える。計算側が両側を処理すると、液量がずれて度数も狂う
  ledger(db, { date: '2026-07-11', type: '瓶詰', from: C, to: C, qty: 24, abv: 35.05 });

  const tanks = db.prepare('SELECT id FROM tanks').all();
  for (const t of tanks) {
    const state = computeTankAbv(db); // 副作用が無いこと込みで呼び直す
    assert.ok(state.has(t.id));
  }
  assert.equal(volumeOf(C), 74, 'ビューは +24 として数える');
});

test('全タンクで、計算に使う液量が v_tank_monitor と一致する', () => {
  // ここがずれると度数も狂う。計算とビューで数え方が揃っていることの見張り。
  // 実際、試作のとき払出を引き忘れて T-001 が 138L のはずが 322.8L になった
  const state = computeTankState(db);
  const round = (n) => Math.round(n * 1000) / 1000;

  for (const t of db.prepare('SELECT id, code FROM tanks').all()) {
    assert.equal(
      round(state.get(t.id).volume),
      round(volumeOf(t.id)),
      `${t.code} の液量が、計算とビューで違います`
    );
  }
});

test('タンクモニターが、計算した度数を返す（current_abv は返さない）', async () => {
  const { body } = await api('GET', '/api/tanks/monitor');
  const byCode = Object.fromEntries(body.map((r) => [r.code, r]));

  assert.equal(byCode['T-001'].abv, abvOf(A));
  assert.ok(!('current_abv' in byCode['T-001']), 'current_abv が返っています');
  // 台帳に1行も無いタンクは null のまま（マスタには 0 が入っている）
  assert.equal(byCode['T-009'].abv, null);
  assert.equal(db.prepare('SELECT current_abv FROM tanks WHERE id = ?').get(UNTOUCHED).current_abv, 0);
});

test('容器移動の度数を省くと、計算した度数が台帳に載る（0.34 が混ざらない）', async () => {
  const res = await api('POST', '/api/tank-operations/transfer', {
    fromTankId: A, toTankId: B, quantityL: 10, txnDate: '2026-07-20',
  });
  assert.equal(res.status, 201);

  const row = db.prepare('SELECT abv FROM tank_ledger ORDER BY id DESC LIMIT 1').get();
  assert.ok(row.abv > 1, `台帳に ${row.abv} が書かれました（割合が漏れています）`);
  assert.equal(row.abv, 34.98);
});

test('瓶詰めで度数を省いても、計算した度数が台帳に載る', async () => {
  const res = await api('POST', '/api/bottling', {
    productId: 1, quantity: 10, tankId: A, volumeL: 3, txnDate: '2026-07-21',
  });
  assert.equal(res.status, 201);

  const row = db
    .prepare("SELECT abv FROM tank_ledger WHERE txn_type = '瓶詰' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(row.abv > 1, `台帳に ${row.abv} が書かれました（割合が漏れています）`);
});
