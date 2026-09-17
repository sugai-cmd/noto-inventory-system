// 資材の入出庫履歴を、あとから取り消し・編集できること。
//
// これまで資材の履歴は画面から一切直せなかった。入荷を打ち間違えても、
// 破損の記録を入れ違えても、直す手段が無い。
// 瓶詰め・箱詰めに入れたもの（PR #35）と同じ形にする。
//
// いちばん気をつけるのは**瓶詰め・箱詰めに紐付いた消費**。
// bottlingService.updateRecord は本数を変えたとき、紐付く資材の行を本数の比で
// 引き直して日付も動かすので、ここで直しても次にあちらを直した瞬間に上書きされる。
// 実データでは消費167件のうち153件がこれに当たるため、ここからは断る。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-material-ledger-edit.sqlite');
const api = harness.api;

let db;

function materialRow(db, {
  code, date, materialId, type, quantity,
  unitPrice = null, totalPrice = null, counterparty = null, note = null,
  productLedgerId = null, cancelled = 0,
}) {
  return db
    .prepare(
      `INSERT INTO material_stock_ledger
         (history_code, txn_date, material_id, txn_type, quantity, unit_price, total_price,
          counterparty, note, product_ledger_id, is_cancelled, cancel_reason, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code, date, materialId, type, quantity, unitPrice, totalPrice, counterparty, note,
      productLedgerId, cancelled,
      cancelled ? '先に入れた取消' : null,
      cancelled ? '2026-08-10 00:00:00' : null
    ).lastInsertRowid;
}

const stock = (materialId) =>
  db.prepare('SELECT current_stock FROM v_material_stock WHERE material_id = ?').get(materialId)
    .current_stock;
const row = (id) => db.prepare('SELECT * FROM material_stock_ledger WHERE id = ?').get(id);
const logs = (action) =>
  db.prepare('SELECT * FROM operation_logs WHERE action = ? ORDER BY id DESC').all(action);

// 台帳のid。seedで入れた順に決まる
const RECEIPT = 1;           // M2608-0001 入荷 300mlガラス瓶 200本（単価281）
const RECEIPT_CORK = 2;      // M2608-0002 入荷 コルクキャップ 135個（実データと同じ端数）
const BREAKAGE = 3;          // M2606-0003 消費 300mlガラス瓶 1本「破損」（紐付きなし）
const LINKED = 4;            // M2607-0010 消費 300mlガラス瓶 100本（瓶詰めに紐付く）
const ALREADY_CANCELLED = 5; // M2608-0003 入荷 紙垂（白）50枚（取消済み）
const STOCKTAKING = 6;       // M2608-0004 棚卸調整 コルクキャップ 5個

const GLASS = 1; // 300mlガラス瓶（初期在庫500）
const CORK = 2;  // コルクキャップ（初期在庫0）
const PAPER = 3; // 紙垂（白）（初期在庫100）

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, unit, initial_product_stock, initial_wip_stock)
       VALUES (?, 'P001', '浄酎 300ml', 300, '本', 0, 0)`
    ).run(generateUid(db, 'products'));

    for (const [code, name, unit, initial] of [
      ['MAT-003', '300mlガラス瓶', '本', 500],
      ['MAT-008', 'コルクキャップ', '個', 0],
      ['MAT-011', '紙垂（白）', '枚', 100],
    ]) {
      db.prepare(
        `INSERT INTO materials (uid, code, name, unit, initial_stock) VALUES (?, ?, ?, ?, ?)`
      ).run(generateUid(db, 'materials'), code, name, unit, initial);
    }

    db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, 'T-001', '浄酎タンク1', 'ステンレス', 1000, 500)`
    ).run(generateUid(db, 'tanks'));

    // 消費の紐付き先になる瓶詰めの記録
    db.prepare(
      `INSERT INTO product_stock_ledger (history_code, txn_date, product_id, txn_type, quantity)
       VALUES ('L2607-0072', '2026-07-10', 1, '瓶詰', 100)`
    ).run();

    materialRow(db, {
      code: 'M2608-0001', date: '2026-08-07', materialId: GLASS, type: '入荷', quantity: 200,
      unitPrice: 281, totalPrice: 56200, counterparty: '酒井硝子',
    });
    materialRow(db, {
      code: 'M2608-0002', date: '2026-08-07', materialId: CORK, type: '入荷', quantity: 135,
      unitPrice: 93, totalPrice: 12555, counterparty: 'ナオライ神石高原',
    });
    // 実データの M2606-0003 と同じ形。単独の書き落としで、紐付き先が無い
    materialRow(db, {
      code: 'M2606-0003', date: '2026-06-01', materialId: GLASS, type: '消費', quantity: 1,
      note: '破損',
    });
    materialRow(db, {
      code: 'M2607-0010', date: '2026-07-10', materialId: GLASS, type: '消費', quantity: 100,
      productLedgerId: 1,
    });
    materialRow(db, {
      code: 'M2608-0003', date: '2026-08-08', materialId: PAPER, type: '入荷', quantity: 50,
      cancelled: 1,
    });
    materialRow(db, {
      code: 'M2608-0004', date: '2026-08-09', materialId: CORK, type: '棚卸調整', quantity: 5,
      note: '棚卸: 理論130 → 実測135',
    });
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 下ごしらえの確認 ---

test('seedの在庫が、取消済みの行を数えない形になっている', () => {
  assert.equal(stock(GLASS), 599, '初期500 + 入荷200 - 破損1 - 消費100');
  assert.equal(stock(CORK), 140, '初期0 + 入荷135 + 棚卸調整5');
  assert.equal(stock(PAPER), 100, '取消済みの入荷50は数えない');
});

// --- 編集 ---

test('入荷の数量を直すと在庫が動き、金額が単価×数量で引き直される', async () => {
  const { status, body } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, { quantity: 120 });
  assert.equal(status, 200);

  assert.equal(stock(GLASS), 519, '200 → 120 なので80減る');
  const after = row(RECEIPT);
  assert.equal(after.quantity, 120);
  assert.equal(after.total_price, 281 * 120, '金額が引き直されること');
  assert.equal(after.history_code, 'M2608-0001', '履歴IDは変わらない');
  assert.deepEqual(Object.keys(body.changes).sort(), ['quantity', 'total_price']);
});

test('月をまたぐ日付に直しても履歴IDはそのまま', async () => {
  const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, { txnDate: '2026-09-02' });
  assert.equal(status, 200);

  const after = row(RECEIPT);
  assert.equal(after.txn_date, '2026-09-02');
  assert.equal(after.history_code, 'M2608-0001', '番号は台帳の名前なので動かさない');
});

test('単価だけ直しても金額が引き直される', async () => {
  const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, { unitPrice: 300 });
  assert.equal(status, 200);
  assert.equal(row(RECEIPT).total_price, 300 * 120);
});

test('単価を空にすると金額も空になる', async () => {
  const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, { unitPrice: null });
  assert.equal(status, 200);
  assert.equal(row(RECEIPT).unit_price, null);
  assert.equal(row(RECEIPT).total_price, null, '単価が無いのに金額が残らないこと');
});

test('相手先と備考を直せる', async () => {
  const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, {
    counterparty: 'ナオライ神石高原',
    note: '別ルートからの仕入れ',
  });
  assert.equal(status, 200);
  assert.equal(row(RECEIPT).counterparty, 'ナオライ神石高原');
  assert.equal(row(RECEIPT).note, '別ルートからの仕入れ');
});

test('瓶詰め・箱詰めに紐付いていない消費は直せる（実データの「破損」と同じ形）', async () => {
  const before = stock(GLASS);
  const { status } = await api('PATCH', `/api/materials/ledger/${BREAKAGE}`, { quantity: 3 });
  assert.equal(status, 200);
  assert.equal(stock(GLASS), before - 2, '消費が1→3なので在庫は2減る');
  assert.equal(row(BREAKAGE).note, '破損', '備考はそのまま');
});

test('直す項目がひとつも無ければ400', async () => {
  const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, {});
  assert.equal(status, 400);
});

test('資材や区分を送ると400（知らないキーを黙って捨てない）', async () => {
  for (const payload of [{ materialId: 2 }, { txnType: '消費' }, { historyCode: 'M9999-0001' }]) {
    const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, payload);
    assert.equal(status, 400, `${JSON.stringify(payload)} は受け付けないこと`);
  }
});

test('数量を0やマイナスにはできない', async () => {
  for (const quantity of [0, -5]) {
    const { status } = await api('PATCH', `/api/materials/ledger/${RECEIPT}`, { quantity });
    assert.equal(status, 400);
  }
});

// --- 紐付いた消費は触らせない ---

test('瓶詰めに紐付いた消費の編集は422で、紐付き先の履歴IDを教える', async () => {
  const before = row(LINKED);
  const { status, body } = await api('PATCH', `/api/materials/ledger/${LINKED}`, { quantity: 50 });
  assert.equal(status, 422);
  assert.match(body.message, /L2607-0072/, 'どこへ行けばよいか分かること');
  assert.match(body.message, /瓶詰め・箱詰めタブ/);
  assert.deepEqual(row(LINKED), before, '行が1文字も変わっていないこと');
});

test('瓶詰めに紐付いた消費の取消も422', async () => {
  const before = row(LINKED);
  const { status, body } = await api('POST', `/api/materials/ledger/${LINKED}/cancel`, {
    reason: '間違いだった',
  });
  assert.equal(status, 422);
  assert.match(body.message, /L2607-0072/);
  assert.deepEqual(row(LINKED), before);
});

// --- 取り消し ---

test('入荷を取り消すと在庫が戻り、数量の値は書き換わらない', async () => {
  const before = stock(CORK);
  const { status, body } = await api('POST', `/api/materials/ledger/${RECEIPT_CORK}/cancel`, {
    reason: '二重に登録していた',
  });
  assert.equal(status, 200);

  assert.equal(stock(CORK), before - 135, '入荷135が消える');
  assert.equal(body.stock.current_stock, stock(CORK));

  const after = row(RECEIPT_CORK);
  assert.equal(after.is_cancelled, 1);
  assert.equal(after.cancel_reason, '二重に登録していた');
  assert.ok(after.cancelled_at, '取消日時が入ること');
  assert.equal(after.quantity, 135, '数量は書き戻さない（ビューが取消済みを0として数える）');
});

test('取消理由が無ければ400', async () => {
  for (const payload of [{}, { reason: '' }]) {
    const { status } = await api('POST', `/api/materials/ledger/${RECEIPT}/cancel`, payload);
    assert.equal(status, 400);
  }
});

test('二重の取消は409', async () => {
  const { status, body } = await api('POST', `/api/materials/ledger/${RECEIPT_CORK}/cancel`, {
    reason: 'もう一度',
  });
  assert.equal(status, 409);
  assert.match(body.message, /既に取消済み/);
});

test('取消済みの行は編集できない（409）', async () => {
  const before = row(ALREADY_CANCELLED);
  const { status, body } = await api('PATCH', `/api/materials/ledger/${ALREADY_CANCELLED}`, {
    quantity: 10,
  });
  assert.equal(status, 409);
  assert.match(body.message, /取消済み/);
  assert.deepEqual(row(ALREADY_CANCELLED), before);
});

test('存在しない行は404', async () => {
  const get = await api('GET', '/api/materials/ledger/9999');
  assert.equal(get.status, 404);
  const patch = await api('PATCH', '/api/materials/ledger/9999', { quantity: 1 });
  assert.equal(patch.status, 404);
  const cancel = await api('POST', '/api/materials/ledger/9999/cancel', { reason: 'x' });
  assert.equal(cancel.status, 404);
});

// --- 在庫の守り ---

test('在庫を前より悪くマイナスにする編集は422で、台帳は変わらない', async () => {
  // 紙垂（白）は在庫100。取消済みの入荷を除くと動かせる行が無いので、消費を1件足して試す
  const id = materialRow(db, {
    code: 'M2609-0001', date: '2026-09-05', materialId: PAPER, type: '消費', quantity: 10,
  });
  assert.equal(stock(PAPER), 90);

  const before = row(id);
  const { status, body } = await api('PATCH', `/api/materials/ledger/${id}`, { quantity: 500 });
  assert.equal(status, 422);
  assert.match(body.message, /紙垂（白）の在庫/);
  assert.deepEqual(row(id), before, '断ったなら1文字も書き換わっていないこと');
  assert.equal(stock(PAPER), 90);
});

// --- 棚卸の行 ---

test('棚卸の行の数量を直すと、備考に直した跡が足される', async () => {
  const { status } = await api('PATCH', `/api/materials/ledger/${STOCKTAKING}`, { quantity: 8 });
  assert.equal(status, 200);

  const after = row(STOCKTAKING);
  assert.equal(after.quantity, 8);
  assert.match(after.note, /棚卸: 理論130 → 実測135/, '元の備考は消さない');
  assert.match(after.note, /編集: 数量 5 → 8/, '備考と数量が食い違ったままにしない');
});

test('棚卸の行も取り消せる（在庫が理論値に戻る）', async () => {
  const before = stock(CORK);
  const { status } = await api('POST', `/api/materials/ledger/${STOCKTAKING}/cancel`, {
    reason: '数え間違いだった',
  });
  assert.equal(status, 200);
  assert.equal(stock(CORK), before - 8, '棚卸調整の8個が消える');
});

// --- 操作ログ ---

test('編集の操作ログに、変える前と後の値が残る', () => {
  const log = logs('material.ledger.update').at(-1); // いちばん古い＝最初の数量の編集
  assert.ok(log, '操作ログが残っていること');
  assert.equal(log.target_type, 'material_stock_ledger');
  assert.equal(log.target_id, RECEIPT);
  assert.match(log.summary, /M2608-0001/);

  const detail = JSON.parse(log.detail_json);
  assert.equal(detail.changes.quantity.from, 200);
  assert.equal(detail.changes.quantity.to, 120);
  assert.equal(detail.stockBefore, 599);
  assert.equal(detail.stockAfter, 519);
});

test('取消の操作ログに理由が残る', () => {
  const log = logs('material.ledger.cancel').find((l) => l.target_id === RECEIPT_CORK);
  assert.ok(log);
  assert.match(log.summary, /理由: 二重に登録していた/);
  assert.equal(JSON.parse(log.detail_json).reason, '二重に登録していた');
});

test('取り消した資材の行が、修正履歴にそのまま出る', async () => {
  const { status, body } = await api('GET', '/api/corrections');
  assert.equal(status, 200);

  const found = body.rows.find((r) => r.target_code === 'M2608-0002');
  assert.ok(found, '資材在庫変動履歴の取消として出ること');
  assert.equal(found.target_type, '資材在庫変動履歴');
  assert.equal(found.reason, '二重に登録していた');
  assert.match(found.action, /入荷 135(\.0)? を取消/, 'REALなので 135.0 と出ることもある');
});

// --- 棚卸の操作ログ（これまで1行も残していなかった） ---

test('資材の棚卸が操作ログを残し、台帳の行に登録者が入る', async () => {
  const { status, body } = await api('POST', '/api/stocktaking/materials', {
    materialId: PAPER,
    actualStock: 80,
    txnDate: '2026-09-10',
    reason: '棚を数え直した',
  });
  assert.equal(status, 201);
  assert.equal(body.diff, -10, '理論90 → 実測80');

  const log = logs('stocktaking.material')[0];
  assert.ok(log, '操作ログが残っていること');
  assert.equal(log.target_id, body.ledgerId);
  assert.match(log.summary, /紙垂（白）を棚卸/);
  assert.match(log.summary, /理論90 → 実測80/);
  assert.match(log.summary, /理由: 棚を数え直した/);

  const detail = JSON.parse(log.detail_json);
  assert.equal(detail.diff, -10);
  assert.equal(detail.txnType, '欠損');

  assert.ok(row(body.ledgerId).created_by, '誰が入れた行かが台帳にも残ること');
});

test('差が0で1行も書かないときも、棚卸したことが操作ログに残る', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM material_stock_ledger').get().n;
  const { status, body } = await api('POST', '/api/stocktaking/materials', {
    materialId: PAPER,
    actualStock: 80,
  });
  assert.equal(status, 201);
  assert.equal(body.skipped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM material_stock_ledger').get().n, before,
    '台帳は汚さない');

  const log = logs('stocktaking.material')[0];
  assert.equal(log.target_id, null);
  assert.match(log.summary, /差なし/);
});

test('商品とタンクの棚卸も操作ログを残す', async () => {
  const product = await api('POST', '/api/stocktaking/products', {
    productId: 1,
    actualProductStock: 12,
    txnDate: '2026-09-10',
  });
  assert.equal(product.status, 201);
  const productLog = logs('stocktaking.product')[0];
  assert.ok(productLog);
  assert.match(productLog.summary, /商品 理論0 → 実測12/);
  assert.equal(JSON.parse(productLog.detail_json).adjustments.length, 1);

  const tank = await api('POST', '/api/stocktaking/tanks', {
    tankId: 1,
    actualVolumeL: 480,
    abv: 35.13,
    txnDate: '2026-09-10',
  });
  assert.equal(tank.status, 201);
  const tankLog = logs('stocktaking.tank')[0];
  assert.ok(tankLog);
  assert.match(tankLog.summary, /浄酎タンク1（T-001）を棚卸/);
  assert.match(tankLog.summary, /理論500L → 実測480L/);
  assert.match(tankLog.summary, /実測度数 35.13%/);
  assert.equal(JSON.parse(tankLog.detail_json).txnType, '欠減');

  assert.ok(
    db.prepare('SELECT created_by FROM tank_ledger WHERE id = ?').get(tank.body.ledgerId).created_by,
    'タンク台帳にも登録者が入ること'
  );
});
