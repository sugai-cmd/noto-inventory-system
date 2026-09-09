// 瓶詰め・箱詰めの記録そのものを、あとから直せること。
//
// これまで、間違えた記録を直す手段は「取り消して入れ直す」しか無かった。
// 日付を1日ずらすためだけに入れ直すと、履歴ID（L2607-0072 のようなロット番号）が
// 新しい番号に変わる。この番号は箱詰め行の counterparty に文字で書かれていたり、
// 現場の記録に残っていたりするので、変わると参照がずれる。
//
// そこでここだけは台帳を書き換える（蒸留の投入明細とは逆の判断）。
// 代わりに、変更前と変更後を操作ログに残す。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-ledger-edit.sqlite');
const api = harness.api;

let db;

function ledger(db, { code, date, productId, type, quantity, counterparty = null }) {
  return db
    .prepare(
      `INSERT INTO product_stock_ledger (history_code, txn_date, product_id, txn_type, quantity, counterparty)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(code, date, productId, type, quantity, counterparty).lastInsertRowid;
}

function materialRow(db, { code, date, materialId, quantity, productLedgerId }) {
  return db
    .prepare(
      `INSERT INTO material_stock_ledger (history_code, txn_date, material_id, txn_type, quantity, product_ledger_id)
       VALUES (?, ?, ?, '消費', ?, ?)`
    )
    .run(code, date, materialId, quantity, productLedgerId).lastInsertRowid;
}

function tankRow(db, { date, fromTankId, toTankId, type, quantityL, abv = null, productLedgerId = null }) {
  return db
    .prepare(
      `INSERT INTO tank_ledger (txn_date, from_tank_id, to_tank_id, txn_type, quantity_l, abv, product_ledger_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(date, fromTankId, toTankId, type, quantityL, abv, productLedgerId).lastInsertRowid;
}

const stock = (productId) =>
  db.prepare('SELECT product_stock, wip_stock FROM v_product_stock WHERE product_id = ?').get(productId);
const tankVolume = (tankId) =>
  db.prepare('SELECT current_volume_l FROM v_tank_monitor WHERE tank_id = ?').get(tankId).current_volume_l;

// 台帳のid。seedで入れた順に決まる
const BOTTLING = 1; // L2607-0072 瓶詰 100本（資材5件・タンクの行あり）
const BOTTLING_NO_TANK = 2; // L2607-0080 瓶詰 60本（タンクの行なし。移行データの多数派）
const BOTTLING_USED = 3; // L2607-0090 瓶詰 50本（うち30本が箱詰めに使われている）
const BOXING = 4; // L2608-0027 箱詰 30本
const SHIPPING = 5; // L2608-0050 出荷
const CANCELLED = 6; // L2608-0060 箱詰（取消済み）
const BOTTLING_FROM_NEGATIVE = 7; // 既にマイナスのタンクからの瓶詰め

const TANK = 1; // 浄酎タンク1
const NEGATIVE_TANK = 2; // 出荷用ポリ13（実データと同じく、既に残量がマイナス）

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'P001', '浄酎 300ml', 300, 35, '本', 3000, 0, 0)`
    ).run(generateUid(db, 'products'));

    for (const [code, name] of [
      ['MAT001', '300mlガラス瓶'],
      ['MAT002', 'コルクキャップ'],
      ['MAT003', '紙垂（白）'],
      ['MAT004', '化粧箱'],
    ]) {
      db.prepare(
        `INSERT INTO materials (uid, code, name, unit, initial_stock) VALUES (?, ?, ?, '個', 10000)`
      ).run(generateUid(db, 'materials'), code, name);
    }

    // レシピ。**紙垂（白）はわざと入れない。**
    // 実データの L2606-0010 は紙垂（白）を46枚消費しているが、いまのレシピには無い。
    // 本数を直すときレシピから引き直すと、この行だけ置き去りになる。
    db.prepare(
      `INSERT INTO product_recipes (product_id, material_id, qty_required, process)
       VALUES (1, 1, 1, '瓶詰'), (1, 2, 1, '瓶詰'), (1, 4, 1, '箱詰')`
    ).run();

    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'T-001', '浄酎タンク1', 'ステンレス', 1000, 500)`
    ).run(generateUid(db, 'tanks'));
    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'JP-013', '出荷用ポリ13', 'PE', 100, 0)`
    ).run(generateUid(db, 'tanks'));

    // 1) 瓶詰め100本。資材3件（うち1件はレシピに無い）＋タンクの払出30L
    ledger(db, { code: 'L2607-0072', date: '2026-07-10', productId: 1, type: '瓶詰', quantity: 100 });
    materialRow(db, { code: 'M2607-0001', date: '2026-07-10', materialId: 1, quantity: 100, productLedgerId: BOTTLING });
    materialRow(db, { code: 'M2607-0002', date: '2026-07-10', materialId: 2, quantity: 100, productLedgerId: BOTTLING });
    materialRow(db, { code: 'M2607-0003', date: '2026-07-10', materialId: 3, quantity: 100, productLedgerId: BOTTLING });
    tankRow(db, {
      date: '2026-07-10', fromTankId: TANK, toTankId: null, type: '瓶詰',
      quantityL: 30, abv: 35, productLedgerId: BOTTLING,
    });

    // 2) タンクの行を持たない瓶詰め（移行した26件のうち21件がこの形）
    ledger(db, { code: 'L2607-0080', date: '2026-07-15', productId: 1, type: '瓶詰', quantity: 60 });

    // 3) 箱詰めに使われている瓶詰め
    ledger(db, { code: 'L2607-0090', date: '2026-07-20', productId: 1, type: '瓶詰', quantity: 50 });

    // 4) 箱詰め30本。3) から30本を引き当てている
    ledger(db, { code: 'L2608-0027', date: '2026-08-01', productId: 1, type: '箱詰', quantity: 30 });
    materialRow(db, { code: 'M2608-0001', date: '2026-08-01', materialId: 4, quantity: 30, productLedgerId: BOXING });
    db.prepare(
      'INSERT INTO wip_lot_allocations (boxing_ledger_id, bottling_ledger_id, quantity) VALUES (?, ?, ?)'
    ).run(BOXING, BOTTLING_USED, 30);

    // 5) 出荷（直せない区分）
    ledger(db, { code: 'L2608-0050', date: '2026-08-05', productId: 1, type: '出荷', quantity: 10 });

    // 6) 取消済みの箱詰め
    ledger(db, { code: 'L2608-0060', date: '2026-08-06', productId: 1, type: '箱詰', quantity: 5 });
    db.prepare('UPDATE product_stock_ledger SET is_cancelled = 1 WHERE id = ?').run(CANCELLED);

    // 7) 既に残量がマイナスのタンクからの瓶詰め。
    //    実データの 出荷用ポリタンク3(-13.2L) / 出荷用ポリ13(-10L) と同じ状態を作る。
    ledger(db, { code: 'L2608-0070', date: '2026-08-07', productId: 1, type: '瓶詰', quantity: 20 });
    tankRow(db, {
      date: '2026-08-07', fromTankId: NEGATIVE_TANK, toTankId: null, type: '瓶詰',
      quantityL: 10, abv: 35, productLedgerId: BOTTLING_FROM_NEGATIVE,
    });
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('直す画面の中身を取れる（本体・資材・タンク・引当済み本数）', async () => {
  const { status, body } = await api('GET', `/api/ledger-cancel/${BOTTLING}`);

  assert.equal(status, 200);
  assert.equal(body.row.history_code, 'L2607-0072');
  assert.equal(body.row.quantity, 100);
  assert.equal(body.materials.length, 3);
  assert.equal(body.tanks.length, 1);
  assert.equal(body.tanks[0].quantity_l, 30);
  assert.equal(body.editable, true);
});

test('日付を直すと、資材とタンクの行の日付も一緒に動く', async () => {
  const res = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { txnDate: '2026-07-11' });

  assert.equal(res.status, 200);
  assert.equal(res.body.changes.txnDate.before, '2026-07-10');
  assert.equal(res.body.changes.txnDate.after, '2026-07-11');
  assert.equal(res.body.materialRowsMoved, 3);
  assert.equal(res.body.tankRowsMoved, 1);

  const dates = db
    .prepare('SELECT DISTINCT txn_date FROM material_stock_ledger WHERE product_ledger_id = ?')
    .all(BOTTLING)
    .map((r) => r.txn_date);
  assert.deepEqual(dates, ['2026-07-11']);
  assert.equal(
    db.prepare('SELECT txn_date FROM tank_ledger WHERE product_ledger_id = ?').get(BOTTLING).txn_date,
    '2026-07-11'
  );
});

test('月をまたぐ日付に直しても、履歴IDは変わらない', async () => {
  const res = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { txnDate: '2026-08-11' });

  assert.equal(res.status, 200);
  // 番号はロットの名前。入れ直しではないので L2607- のまま
  assert.equal(res.body.historyCode, 'L2607-0072');
  assert.equal(
    db.prepare('SELECT history_code FROM product_stock_ledger WHERE id = ?').get(BOTTLING).history_code,
    'L2607-0072'
  );

  await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { txnDate: '2026-07-10' }); // 戻す
});

test('本数を直すと仕掛品在庫が動き、資材の消費量が同じ割合で直る', async () => {
  const before = stock(1);

  const res = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { quantity: 120 });

  assert.equal(res.status, 200);
  assert.equal(res.body.changes.quantity.before, 100);
  assert.equal(res.body.changes.quantity.after, 120);
  assert.equal(stock(1).wip_stock - before.wip_stock, 20);

  const mats = db
    .prepare('SELECT quantity FROM material_stock_ledger WHERE product_ledger_id = ? ORDER BY id')
    .all(BOTTLING)
    .map((r) => r.quantity);
  assert.deepEqual(mats, [120, 120, 120]);
  assert.equal(res.body.materialRowsScaled, 3);
});

test('レシピに無い資材の行も、置き去りにせず同じ割合で直る', async () => {
  // いまは120本。60本に半減させる
  const res = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { quantity: 60 });

  assert.equal(res.status, 200);
  const rows = db
    .prepare(
      `SELECT mt.name, m.quantity FROM material_stock_ledger m
         JOIN materials mt ON mt.id = m.material_id
        WHERE m.product_ledger_id = ? ORDER BY m.id`
    )
    .all(BOTTLING);
  // 紙垂（白）はレシピに無い。レシピから引き直す作りだと、この行だけ120のまま残る
  assert.deepEqual(
    rows.map((r) => [r.name, r.quantity]),
    [['300mlガラス瓶', 60], ['コルクキャップ', 60], ['紙垂（白）', 60]]
  );

  await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { quantity: 100 }); // 戻す
});

test('数量(L)を直すと、タンクの残量が連動する', async () => {
  const before = tankVolume(TANK);

  const res = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { volumeL: 20, abv: 36 });

  assert.equal(res.status, 200);
  assert.equal(res.body.changes.volumeL.after, 20);
  // 30L 抜いていたのを 20L に直したので、残量は10L増える
  assert.equal(tankVolume(TANK) - before, 10);
  assert.equal(db.prepare('SELECT abv FROM tank_ledger WHERE product_ledger_id = ?').get(BOTTLING).abv, 36);

  await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { volumeL: 30, abv: 35 }); // 戻す
});

test('タンクの行がない瓶詰めに数量(L)を送ると422（移行データの多数派）', async () => {
  const { status, body } = await api('PATCH', `/api/ledger-cancel/${BOTTLING_NO_TANK}`, { volumeL: 5 });

  assert.equal(status, 422);
  assert.match(body.message, /タンクの記録がありません/);
});

test('箱詰めの本数を直すと、商品在庫と仕掛品在庫が両方動く', async () => {
  const before = stock(1);

  const res = await api('PATCH', `/api/ledger-cancel/${BOXING}`, { quantity: 40 });

  assert.equal(res.status, 200);
  const after = stock(1);
  assert.equal(after.product_stock - before.product_stock, 10);
  assert.equal(after.wip_stock - before.wip_stock, -10);
  // 化粧箱も同じ割合で
  assert.equal(
    db.prepare('SELECT quantity FROM material_stock_ledger WHERE product_ledger_id = ?').get(BOXING).quantity,
    40
  );

  await api('PATCH', `/api/ledger-cancel/${BOXING}`, { quantity: 30 }); // 戻す
});

test('箱詰めで使われている本数より少なくは減らせず、何も変わらない', async () => {
  const before = db.prepare('SELECT * FROM product_stock_ledger WHERE id = ?').get(BOTTLING_USED);

  const { status, body } = await api('PATCH', `/api/ledger-cancel/${BOTTLING_USED}`, { quantity: 20 });

  assert.equal(status, 422);
  assert.match(body.message, /30 本が箱詰めに使われています/);
  assert.equal(
    db.prepare('SELECT quantity FROM product_stock_ledger WHERE id = ?').get(BOTTLING_USED).quantity,
    before.quantity
  );
});

test('引き当てている本数より少ない箱詰めには直せない', async () => {
  const { status, body } = await api('PATCH', `/api/ledger-cancel/${BOXING}`, { quantity: 20 });

  assert.equal(status, 422);
  assert.match(body.message, /30 本を引き当てています/);
  assert.equal(
    db.prepare('SELECT quantity FROM product_stock_ledger WHERE id = ?').get(BOXING).quantity,
    30
  );
});

test('仕掛品在庫がマイナスに落ちる直し方は断り、資材も日付も巻き戻る', async () => {
  // 仕掛品は 瓶詰 100+60+50+20 − 箱詰 30 = 200本。
  // 箱詰めを 30 → 300 本にすると 200−270 = −70 本で、仕掛品が足りなくなる。
  const beforeStock = stock(1);
  assert.equal(beforeStock.wip_stock, 200);

  const beforeMats = db
    .prepare('SELECT id, quantity FROM material_stock_ledger WHERE product_ledger_id = ? ORDER BY id')
    .all(BOXING);

  const { status, body } = await api('PATCH', `/api/ledger-cancel/${BOXING}`, {
    quantity: 300,
    txnDate: '2026-01-01',
  });

  assert.equal(status, 422);
  assert.match(body.message, /仕掛品在庫が -70 になります/);

  // 断った以上、資材も日付も動いていないこと（トランザクションが効いていること）
  assert.deepEqual(
    db
      .prepare('SELECT id, quantity FROM material_stock_ledger WHERE product_ledger_id = ? ORDER BY id')
      .all(BOXING),
    beforeMats,
    '断ったのに資材の行が変わっています'
  );
  assert.equal(
    db.prepare('SELECT txn_date FROM product_stock_ledger WHERE id = ?').get(BOXING).txn_date,
    '2026-08-01',
    '断ったのに日付が変わっています'
  );
  assert.deepEqual(stock(1), beforeStock);
});

test('既にマイナスのタンクでも、悪化させないなら直せる', async () => {
  // 出荷用ポリ13 は初期0Lから10L抜いており、-10L。実データと同じ状態。
  assert.equal(tankVolume(NEGATIVE_TANK), -10);

  const res = await api('PATCH', `/api/ledger-cancel/${BOTTLING_FROM_NEGATIVE}`, { volumeL: 6 });

  assert.equal(res.status, 200, '0以上を条件にすると、実データのこのタンクは一切直せなくなる');
  assert.equal(tankVolume(NEGATIVE_TANK), -6);
});

test('マイナスを深くする直し方は断る', async () => {
  const before = tankVolume(NEGATIVE_TANK);

  const { status, body } = await api('PATCH', `/api/ledger-cancel/${BOTTLING_FROM_NEGATIVE}`, {
    volumeL: 40,
  });

  assert.equal(status, 422);
  assert.match(body.message, /出荷用ポリ13 の残量/);
  assert.equal(tankVolume(NEGATIVE_TANK), before);
});

test('出荷は直せない（409）', async () => {
  const { status, body } = await api('PATCH', `/api/ledger-cancel/${SHIPPING}`, { quantity: 5 });

  assert.equal(status, 409);
  assert.match(body.message, /出荷/);
});

test('取消済みは直せない（409）', async () => {
  const { status, body } = await api('PATCH', `/api/ledger-cancel/${CANCELLED}`, { quantity: 5 });

  assert.equal(status, 409);
  assert.match(body.message, /取消済み/);
});

test('無い記録は404', async () => {
  const { status } = await api('PATCH', '/api/ledger-cancel/9999', { quantity: 5 });
  assert.equal(status, 404);
});

test('商品や区分を送っても黙って捨てず、400で断る', async () => {
  const a = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { productId: 2 });
  assert.equal(a.status, 400);

  const b = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { txnType: '箱詰' });
  assert.equal(b.status, 400);

  const c = await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, {});
  assert.equal(c.status, 400);
});

test('操作ログに、変更前と変更後が残る', async () => {
  await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { note: '直しました', quantity: 90 });

  const log = db
    .prepare(
      `SELECT * FROM operation_logs WHERE action = 'ledger.update' AND target_id = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(BOTTLING);

  assert.ok(log, '操作ログが残っていません');
  assert.match(log.summary, /L2607-0072/);
  assert.match(log.summary, /本数: 100 → 90/);

  const detail = JSON.parse(log.detail_json);
  assert.equal(detail.before.quantity, 100);
  assert.equal(detail.after.quantity, 90);
  assert.equal(detail.before.note, null);
  assert.equal(detail.after.note, '直しました');

  await api('PATCH', `/api/ledger-cancel/${BOTTLING}`, { quantity: 100 }); // 戻す
});

test('取り消したあとに直そうとしても通らない（取消のルールは変わらない）', async () => {
  const cancelled = await api('POST', `/api/ledger-cancel/${BOTTLING_NO_TANK}`, {
    reason: 'テスト',
  });
  assert.equal(cancelled.status, 200);

  const { status } = await api('PATCH', `/api/ledger-cancel/${BOTTLING_NO_TANK}`, { quantity: 10 });
  assert.equal(status, 409);
});
