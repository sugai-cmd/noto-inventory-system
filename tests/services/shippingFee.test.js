// 送料の計算（PR E）。
//
//   送料 ＝ 繰り上げ50円( (運賃 × 荷物の個数 ＋ 段ボールの税抜単価 × 枚数) × 1.1 )
//
// いままでは運賃をそのまま送料にしていて、**段ボール代も消費税も入っていなかった**。
//
// **枚数と荷物の個数は別物。**
// 300ml 2本は1本用の箱を2枚使うが、テープでくっつけて1つの荷物として送るので、
// 在庫は2枚減るのに運賃は1回しかかからない。
// 24本は12本用を2枚使い、2つの荷物として送るので運賃も2回。
//
// この案件では「通るのに何も確かめていない試験」を4回書いた。
// ここでは1つずつ、**直しを外すと落ちる**形にしてある。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-shipping-fee.sqlite');
const api = harness.api;

let db;

const PRODUCT = 1;
const BOX_1 = 1;  // 300ml1本入り段ボール 58.3円
const BOX_12 = 2; // 300ml12本入り段ボール 150円

// 石川県内の運賃（実データと同じ値）
const FREIGHT = { 60: 478, 80: 617, 100: 739, 120: 901, 140: 1079, 160: 1290, 170: 1527 };

const quote = (body) => api('POST', '/api/shipping/quote', { prefecture: '石川県', ...body });

/**
 * 対応表の行を一時的に書き換えて試す。
 * **戻す処理は finally に置く。** 試験が落ちたときに戻らないと、
 * あとの試験まで巻き添えで落ちて、どれが本当の失敗か分からなくなる。
 */
async function withRule(quantity, patch, body) {
  const before = db
    .prepare('SELECT material_qty, parcels, length_cm, width_cm, height_cm FROM carton_rules WHERE product_id = ? AND quantity = ?')
    .get(PRODUCT, quantity);
  const set = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
  const apply = (values) =>
    db.prepare(`UPDATE carton_rules SET ${set} WHERE product_id = @pid AND quantity = @qty`)
      .run({ ...values, pid: PRODUCT, qty: quantity });

  apply(patch);
  try {
    return await body();
  } finally {
    apply(Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])));
  }
}
const forBottles = (quantity) => quote({ items: [{ productId: PRODUCT, quantity }] });

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare('INSERT INTO customers (uid, code, name) VALUES (?, ?, ?)')
      .run(generateUid(db, 'customers'), 'C-001', '株式会社NOTO');
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, list_price)
       VALUES (?, 'P-001', '浄酎 300ml', 300, 3000)`
    ).run(generateUid(db, 'products'));

    const mat = db.prepare(
      `INSERT INTO materials (uid, code, name, category, unit, unit_price, initial_stock)
       VALUES (?, ?, ?, '外箱', '枚', ?, 100)`
    );
    mat.run(generateUid(db, 'materials'), 'MAT-029', '300ml1本入り段ボール', 58.3);
    mat.run(generateUid(db, 'materials'), 'MAT-025', '300ml12本入り段ボール', 150);

    const rule = db.prepare(
      `INSERT INTO carton_rules
         (product_id, quantity, carton_size, box_name, material_id, material_qty, parcels,
          length_cm, width_cm, height_cm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // 2本: 1本用を2枚、くっつけて1荷物。外寸から60サイズ（合計50cm）
    rule.run(PRODUCT, 2, '80', '300ml2本用', BOX_1, 2, 1, 20, 20, 10);
    // 12本: 12本用を1枚、1荷物。外寸は入れていない → 手入力の100サイズを使う
    rule.run(PRODUCT, 12, '100', '300ml12本用', BOX_12, 1, 1, null, null, null);
    // 1本: 資材を設定していない行（段ボール代が出せないケース）
    rule.run(PRODUCT, 1, '60', '300ml一本用', null, 1, 1, null, null, null);
  }));
});

test.after(() => harness.teardown());

// --- 繰り上げ ---------------------------------------------------------------

test('50円ごとに繰り上げる。ちょうどの金額は繰り上げない', async () => {
  const { ceilTo50 } = require('../../src/services/shippingFeeService');
  assert.equal(ceilTo50(795), 800);
  assert.equal(ceilTo50(800), 800, 'ちょうど800円を850円にしてはいけない');
  assert.equal(ceilTo50(801), 850);
  assert.equal(ceilTo50(811), 850);
  assert.equal(ceilTo50(0), 0);
  assert.equal(ceilTo50(654.06), 700);
});

// --- 本題の2例 ---------------------------------------------------------------

test('300ml 2本 = 700円（1本用2枚・くっつけて1荷物）', async () => {
  const { body } = await forBottles(2);

  // 外寸 20+20+10 = 50cm → 60サイズ。手入力の80サイズではない
  assert.equal(body.cartonSize, '60');
  assert.equal(body.sizeFrom, '外寸');
  assert.equal(body.dimensionSum, 50);

  assert.equal(body.sheets, 2, '在庫から引く枚数');
  assert.equal(body.parcels, 1, 'くっつけて1荷物');

  assert.equal(body.freightPerParcel, FREIGHT[60]);
  assert.equal(body.freight, 478, '運賃は1荷物ぶん');
  assert.equal(body.materialUnitPrice, 58.3);
  assert.equal(Math.round(body.materialCost * 100) / 100, 116.6, '58.3 × 2枚');
  assert.equal(Math.round(body.subtotal * 100) / 100, 594.6);
  assert.equal(body.taxed, 654.06);
  assert.equal(body.fee, 700);
  assert.equal(body.resolved, true);
  assert.deepEqual(body.reasons, []);
});

test('300ml 24本 = 2,000円（12本用2枚・2荷物）', async () => {
  const { body } = await forBottles(24);

  assert.equal(body.cartonSize, '100');
  assert.equal(body.sizeFrom, '対応表', '外寸を入れていないので手入力に落ちる');
  assert.equal(body.sheets, 2);
  assert.equal(body.parcels, 2);

  assert.equal(body.freight, 739 * 2, '運賃が荷物の数だけ掛かっていない');
  assert.equal(body.materialCost, 150 * 2);
  assert.equal(body.subtotal, 1778);
  assert.equal(body.taxed, 1955.8);
  assert.equal(body.fee, 2000);

  // 24本ぴったりの行は無い。割り算で決まっていることの裏取り
  const exact = db
    .prepare('SELECT COUNT(*) AS n FROM carton_rules WHERE product_id = ? AND quantity = 24')
    .get(PRODUCT).n;
  assert.equal(exact, 0);
});

// --- 枚数と荷物が別々に効く --------------------------------------------------

test('荷物の個数だけ変えると、運賃だけ倍になって段ボール代は変わらない', async () => {
  const before = (await forBottles(2)).body;

  await withRule(2, { parcels: 2 }, async () => {
    const after = (await forBottles(2)).body;
    assert.equal(after.freight, before.freight * 2, '運賃が荷物の数に連動していない');
    assert.equal(after.materialCost, before.materialCost, '段ボール代まで変わってしまっている');
    assert.equal(after.sheets, before.sheets);
  });
});

test('枚数だけ変えると、段ボール代だけ変わって運賃は変わらない', async () => {
  const before = (await forBottles(2)).body;

  await withRule(2, { material_qty: 4 }, async () => {
    const after = (await forBottles(2)).body;
    assert.equal(after.sheets, 4);
    assert.equal(after.freight, before.freight, '枚数を変えたのに運賃まで変わっている');
    assert.equal(Math.round(after.materialCost * 100) / 100, 233.2, '58.3 × 4枚');
  });
});

// --- 外寸 -------------------------------------------------------------------

test('外寸があれば手入力より優先される', async () => {
  // 2本の行は 手入力80サイズ / 外寸は60サイズ。**わざと違う値**にしてある
  const row = db
    .prepare('SELECT carton_size FROM carton_rules WHERE product_id = ? AND quantity = 2')
    .get(PRODUCT);
  assert.equal(row.carton_size, '80', '手入力と外寸が同じだと、この試験は空振りする');

  const { body } = await forBottles(2);
  assert.equal(body.cartonSize, '60');
  assert.equal(body.freightPerParcel, FREIGHT[60]);
});

test('外寸が無ければ手入力のサイズに落ちる', async () => {
  await withRule(2, { length_cm: null, width_cm: null, height_cm: null }, async () => {
    const { body } = await forBottles(2);
    assert.equal(body.cartonSize, '80', '手入力に戻っていない');
    assert.equal(body.sizeFrom, '対応表');
    assert.equal(body.freightPerParcel, FREIGHT[80]);
  });
});

test('外寸が一番大きい区分を超えたら、黙って安いサイズにせず理由を返す', async () => {
  await withRule(2, { length_cm: 100, width_cm: 60, height_cm: 40 }, async () => {
    const { body } = await forBottles(2);
    assert.equal(body.dimensionSum, 200);
    assert.equal(body.cartonSize, null, '手入力の80サイズに落ちてしまっている（安く請求する）');
    assert.equal(body.fee, null);
    assert.equal(body.resolved, false);
    assert.match(body.reasons.join(' '), /どの区分にも収まりません/);
  });
});

test('サイズ区分の候補は運賃表から作る（固定の配列ではない）', async () => {
  const { cartonSizeBands } = require('../../src/services/shippingFeeService');
  assert.deepEqual(cartonSizeBands(db), [60, 80, 100, 120, 140, 160, 170]);

  // 60サイズの料金を消すと、3辺50cmは次に大きい80サイズに繰り上がる
  const removed = db.prepare("DELETE FROM shipping_rates WHERE carton_size = '60'").run();
  assert.ok(removed.changes > 0);
  const { body } = await forBottles(2);
  assert.equal(body.cartonSize, '80', '候補が運賃表に追従していない');

  // 元に戻す
  const back = db.prepare(
    'INSERT INTO shipping_rates (zone, carton_size, fee) VALUES (?, ?, ?)'
  );
  for (const [zone, fee] of [['県内', 478], ['第1地帯', 488], ['第2地帯', 504],
    ['第3地帯', 585], ['第5地帯', 809], ['第10地帯', 1200]]) back.run(zone, '60', fee);
});

// --- 資材が未設定 -----------------------------------------------------------

test('段ボール資材が未設定でも、運賃だけで送料を出して断り書きを付ける', async () => {
  const { body } = await forBottles(1);
  assert.equal(body.materialUnitPrice, 0);
  assert.equal(body.materialCost, 0);
  assert.equal(body.freight, FREIGHT[60]);
  assert.equal(body.taxed, 525.8); // 478 × 1.1
  assert.equal(body.fee, 550);
  assert.equal(body.resolved, true, '資材が無いだけで送料を出さないのは行き過ぎ');
  assert.match(body.reasons.join(' '), /段ボール代は含んでいません/);
});

// --- 税 ---------------------------------------------------------------------

test('運賃も段ボール代も税抜として扱い、合計に一度だけ10%を足す', async () => {
  const { body } = await forBottles(2);
  const { TAX_RATE } = require('../../src/services/shippingFeeService');
  assert.equal(TAX_RATE, 0.1);
  // 税を足していなければ 594.6 → 600円 になり、700円にはならない
  assert.equal(body.fee, 700);
  assert.notEqual(body.fee, 600);
  assert.equal(Math.round(body.subtotal * (1 + TAX_RATE) * 100) / 100, body.taxed);
});

// --- 既定値 -----------------------------------------------------------------

test('枚数・荷物を入れていない行は 1枚・1荷物として動く', async () => {
  // 画面から最低限の項目だけで登録した行
  const created = await api('POST', '/api/shipping/carton-rules', {
    productId: PRODUCT, quantity: 6, cartonSize: '100',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.material_qty, 1);
  assert.equal(created.body.parcels, 1);

  const { body } = await forBottles(6);
  assert.equal(body.sheets, 1);
  assert.equal(body.parcels, 1);
  assert.equal(body.freight, FREIGHT[100]);
});

test('枚数・荷物の個数は1以上でないと受け付けない', async () => {
  const zero = await api('POST', '/api/shipping/carton-rules', {
    productId: PRODUCT, quantity: 3, cartonSize: '60', materialQty: 0,
  });
  assert.equal(zero.status, 400);

  const negative = await api('POST', '/api/shipping/carton-rules', {
    productId: PRODUCT, quantity: 3, cartonSize: '60', parcels: -1,
  });
  assert.equal(negative.status, 400);
});

// --- 対応表の一覧 -----------------------------------------------------------

test('対応表の一覧は、外寸から出た区分も返す（手入力との食い違いが分かる）', async () => {
  const { body } = await api('GET', '/api/shipping/carton-rules');
  const two = body.find((r) => r.product_id === PRODUCT && r.quantity === 2);

  assert.equal(two.carton_size, '80', '手入力');
  assert.equal(two.size_from_dimensions, '60', '外寸から');
  assert.equal(two.dimension_sum, 50);
  assert.equal(two.material_qty, 2);
  assert.equal(two.parcels, 1);
  assert.equal(two.material_name, '300ml1本入り段ボール');

  // 外寸が無い行は null（画面はここを見て「未入力」と出す）
  const twelve = body.find((r) => r.product_id === PRODUCT && r.quantity === 12);
  assert.equal(twelve.size_from_dimensions, null);
  assert.equal(twelve.dimension_sum, null);
});

// --- 発送画面の初期値（PR #53 の続き）---------------------------------------

test('発送画面の枚数の初期値に、1組あたりの枚数が掛かる', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-01', customerId: 1, productId: PRODUCT, quantity: 2,
  });
  const orderId = order.body.lines ? order.body.lines[0].id : order.body.id;

  const { body } = await api('GET', `/api/orders/${orderId}/carton-suggestion`);
  // 倍率（2 ÷ 2 = 1）だけ見ていると1枚になる。1本用を2枚使うのが正しい
  assert.equal(body.suggestion.boxes, 2);
  assert.equal(body.suggestion.materialQty, 2);
  assert.equal(body.suggestion.parcels, 1);
  assert.equal(body.suggestion.materialName, '300ml1本入り段ボール');
});
