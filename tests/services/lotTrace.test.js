// ロット追跡。「どのタンクにどの蒸留ロットの液体が入っているか」を検証する。
//
// 液体は混ざるので割合で追う。移動・瓶詰めをまたいでも由来が追えること、
// 内訳の合計がタンクモニターの現在液量と一致することを見る。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-lot-trace.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 原酒ポリ2本、浄酎タンク3本
    for (const [code, name, type, max] of [
      ['SP-001', '原酒ポリ1', '原酒ポリタンク', 200],
      ['SP-002', '原酒ポリ2', '原酒ポリタンク', 200],
      ['T-001', '浄酎タンク1', 'ステンレスタンク', 1000],
      ['T-002', '浄酎タンク2', 'ステンレスタンク', 1000],
      ['T-003', '浄酎タンク3', 'ステンレスタンク', 1000],
    ]) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(generateUid(db, 'tanks'), code, name, type, max);
    }

    db.prepare(`INSERT INTO breweries (uid, name) VALUES (?, '鳥屋酒造')`).run(
      generateUid(db, 'breweries')
    );
    db.prepare(
      `INSERT INTO raw_sake_brands (uid, name, brewery_id) VALUES (?, '浄酎用池月', 1)`
    ).run(generateUid(db, 'raw_sake_brands'));

    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, list_price, initial_product_stock, initial_wip_stock)
       VALUES (?, 'JOCHU White NOTO 35 300ml', 300, 3300, 0, 0)`
    ).run(generateUid(db, 'products'));
    db.prepare(
      `INSERT INTO materials (uid, name, unit, unit_price, proper_stock_qty, initial_stock)
       VALUES (?, '300ml瓶', '本', 100, 100, 10000)`
    ).run(generateUid(db, 'materials'));
    db.prepare(
      `INSERT INTO product_recipes (product_id, material_id, qty_required, process)
       VALUES (1, 1, 1, '瓶詰')`
    ).run();
  }));

  // 原酒を2本のポリタンクへ受け入れる
  await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-01', toTankId: 1, quantity: 150, rawSakeBrandId: 1, supplier: '鳥屋酒造',
  });
  await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-01', toTankId: 2, quantity: 100, rawSakeBrandId: 1, supplier: '鳥屋酒造',
  });

  // 蒸留1回目 → T-001 へ 60L
  const d1 = await api('POST', '/api/distillations', {
    startedOn: '2026-09-02', startedTime: '09:00', items: [{ tankId: 1, volumeL: 100 }],
  });
  await api('POST', `/api/distillations/${d1.body.distillationId}/complete`, {
    completedOn: '2026-09-02', completedTime: '18:00', outputTankId: 3, outputL: 60, outputAbv: 40,
  });

  // 蒸留2回目 → 同じ T-001 へ 40L（1本のタンクに2ロットが混ざる）
  const d2 = await api('POST', '/api/distillations', {
    startedOn: '2026-09-03', startedTime: '09:00', items: [{ tankId: 2, volumeL: 80 }],
  });
  await api('POST', `/api/distillations/${d2.body.distillationId}/complete`, {
    completedOn: '2026-09-03', completedTime: '18:00', outputTankId: 3, outputL: 40, outputAbv: 38,
  });
});

test.after(async () => {
  await harness.teardown();
});

test('継足した蒸留ロットがタンクの中身として出る', async () => {
  const { status, body } = await api('GET', '/api/lots/tanks');
  assert.equal(status, 200);

  const t1 = body.find((t) => t.code === 'T-001');
  assert.equal(t1.currentVolumeL, 100);   // 60 + 40
  assert.equal(t1.lots.length, 2);

  const first = t1.lots.find((l) => l.label === 'D2609-0001');
  const second = t1.lots.find((l) => l.label === 'D2609-0002');
  assert.equal(first.volumeL, 60);
  assert.equal(first.share, 60);
  assert.equal(second.volumeL, 40);
  assert.equal(second.share, 40);
});

test('容器移動すると、中身の割合そのままで移る', async () => {
  // 100L（D-1が60L / D-2が40L）のうち50Lを T-002 へ移す
  const moved = await api('POST', '/api/tank-operations/transfer', {
    txnDate: '2026-09-04', fromTankId: 3, toTankId: 4, quantityL: 50,
  });
  assert.equal(moved.status, 201);

  const { body } = await api('GET', '/api/lots/tanks');
  const from = body.find((t) => t.code === 'T-001');
  const to = body.find((t) => t.code === 'T-002');

  // 移した先は割合が同じ（30L / 20L）
  assert.equal(to.currentVolumeL, 50);
  assert.equal(to.lots.find((l) => l.label === 'D2609-0001').volumeL, 30);
  assert.equal(to.lots.find((l) => l.label === 'D2609-0002').volumeL, 20);

  // 移した元も残りは同じ割合（30L / 20L）
  assert.equal(from.currentVolumeL, 50);
  assert.equal(from.lots.find((l) => l.label === 'D2609-0001').volumeL, 30);
  assert.equal(from.lots.find((l) => l.label === 'D2609-0002').volumeL, 20);
});

test('内訳の合計はタンクモニターの現在液量と一致する', async () => {
  const [lots, monitor] = await Promise.all([
    api('GET', '/api/lots/tanks'),
    api('GET', '/api/tanks/monitor'),
  ]);
  for (const t of lots.body) {
    const m = monitor.body.find((x) => x.tank_id === t.tankId);
    const sum = t.lots.reduce((s, l) => s + l.volumeL, 0);
    assert.equal(
      Math.round(sum * 100) / 100,
      Math.round((m?.current_volume_l ?? 0) * 100) / 100,
      `${t.code} の内訳合計が現在液量と違います`
    );
  }
});

test('蒸留ロットの行方が、残っているタンクごとに出る', async () => {
  const { body } = await api('GET', '/api/lots/distillations');

  const d1 = body.find((d) => d.distillationCode === 'D2609-0001');
  assert.equal(d1.outputL, 60);
  assert.equal(d1.remainingL, 60);   // T-001に30L + T-002に30L
  assert.equal(d1.inTanks.length, 2);
  assert.deepEqual(
    d1.inTanks.map((t) => `${t.code}:${t.volumeL}`).sort(),
    ['T-001:30', 'T-002:30']
  );
  assert.equal(d1.bottledL, 0);
});

test('瓶詰めすると、その瓶詰めが使った蒸留ロットが分かる', async () => {
  // T-001（D-1が30L / D-2が20L）から100本＝30L瓶詰めする
  const bottled = await api('POST', '/api/bottling', {
    txnDate: '2026-09-05', productId: 1, quantity: 100, tankId: 3, volumeL: 30,
  });
  assert.equal(bottled.status, 201);

  const { body } = await api('GET', '/api/lots/wip');
  const lot = body[0];
  assert.equal(lot.quantity, 100);
  assert.equal(lot.remaining, 100);
  assert.equal(lot.tank, 'T-001 浄酎タンク1');

  // 30Lの内訳は、タンクの割合どおり D-1が18L / D-2が12L
  assert.equal(lot.sourceLots.find((s) => s.label === 'D2609-0001').volumeL, 18);
  assert.equal(lot.sourceLots.find((s) => s.label === 'D2609-0002').volumeL, 12);
});

test('蒸留ロット側からも、瓶詰めに使われたぶんが見える', async () => {
  const { body } = await api('GET', '/api/lots/distillations');
  const d1 = body.find((d) => d.distillationCode === 'D2609-0001');

  assert.equal(d1.bottledL, 18);
  assert.equal(d1.remainingL, 42);   // 60 - 18
  assert.equal(d1.bottled.length, 1);
  assert.equal(d1.bottled[0].productName, 'JOCHU White NOTO 35 300ml');
  assert.equal(d1.bottled[0].quantity, 60);   // 100本の18/30 = 60本相当
});

test('箱詰めすると、仕掛品ロットの残数と引当先が出る', async () => {
  await api('POST', '/api/boxing', {
    txnDate: '2026-09-06', productId: 1, quantity: 40,
  });

  const { body } = await api('GET', '/api/lots/wip');
  const lot = body[0];
  assert.equal(lot.allocated, 40);
  assert.equal(lot.remaining, 60);
  assert.equal(lot.boxings.length, 1);
  assert.equal(lot.boxings[0].quantity, 40);
});

test('原酒タンクの中身が銘柄と酒蔵で出る', async () => {
  const { body } = await api('GET', '/api/lots/raw-sake');

  // SP-001 は150L受入 → 蒸留に100L投入で50L残り
  const sp1 = body.find((t) => t.code === 'SP-001');
  assert.equal(sp1.currentVolumeL, 50);
  assert.equal(sp1.lots.length, 1);
  assert.equal(sp1.lots[0].label, '浄酎用池月（鳥屋酒造）');
  assert.equal(sp1.lots[0].volumeL, 50);

  const sp2 = body.find((t) => t.code === 'SP-002');
  assert.equal(sp2.currentVolumeL, 20);   // 100 - 80
});

test('中身が空のタンクは既定で出さない（includeEmptyで出せる）', async () => {
  const hidden = await api('GET', '/api/lots/tanks');
  assert.ok(!hidden.body.some((t) => t.code === 'T-003'));

  const shown = await api('GET', '/api/lots/tanks?includeEmpty=1');
  assert.ok(shown.body.some((t) => t.code === 'T-003'));
});

test('ログインしていないとロット追跡は見られない', async () => {
  const res = await harness.rawFetch('/api/lots/tanks');
  assert.equal(res.status, 401);
});
