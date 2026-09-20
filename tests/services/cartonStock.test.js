// 出荷で段ボール（外装）を減らす（PR D-1）。
//
// **段ボール7種（materials.category = '外箱'）は資材台帳に1行も記録が無かった。**
// 画面の数字は移行したときの初期在庫のまま止まっていて、実態を表していない。
// 箱詰めのレシピで減るのは化粧箱・桐箱・プラケース（category = '箱'）という個装で、
// 出荷に使う外装の段ボールはどこでも減っていなかった。
//
// 繋ぎに足りなかったのは carton_rules.material_id の1列だけ。
//
// 二重減算の罠が1つある。対応表の「桐箱一本用」を資材の「桐箱(710ml)」に繋ぐと、
// **箱詰めで既に減らしているので二重に減る**。分類が「外箱」のものだけ通すガードで塞ぐ。
//
// この案件では「通るのに何も確かめていない試験」を4回書いた。
// ここでは1つずつ、**直しを外すと落ちる**形にしてある。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-carton-stock.sqlite');
const api = harness.api;

let db;

const PRODUCT = 1;         // 浄酎 300ml
const SERVICE_PRODUCT = 2; // 委託生産料（物でない商品。対応表に行が無い）
const CUSTOMER = 1;
const BOX_12 = 1;       // 300ml12本入り段ボール（外箱）
const BOX_1 = 2;        // 300ml1本入り段ボール（外箱）
const KIRIBAKO = 3;     // 桐箱（個装。箱詰めで減る）

/** その資材のいまの在庫 */
const stockOf = (materialId) =>
  db.prepare('SELECT current_stock FROM v_material_stock WHERE material_id = ?').get(materialId)
    .current_stock;

/** 受注を1件作って id を返す */
async function newOrder(quantity, extra = {}) {
  const res = await api('POST', '/api/orders', {
    orderedOn: '2026-08-01',
    customerId: CUSTOMER,
    productId: PRODUCT,
    quantity,
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.lines ? res.body.lines[0].id : res.body.id;
}

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare('INSERT INTO customers (uid, code, name) VALUES (?, ?, ?)')
      .run(generateUid(db, 'customers'), 'C-001', '株式会社NOTO');

    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, list_price)
       VALUES (?, 'P-001', '浄酎 300ml', 300, 3000)`
    ).run(generateUid(db, 'products'));

    // 物でない商品（実データの「委託生産料」「調査委託事業費」に当たる）。
    // 対応表に行が無いので、箱は決まらないし使わない
    db.prepare(
      `INSERT INTO products (uid, code, name, unit) VALUES (?, 'P-002', '委託生産料', '式')`
    ).run(generateUid(db, 'products'));

    // 分類が効いているかを確かめたいので、外箱2件と個装（箱）1件を入れる
    const mat = db.prepare(
      `INSERT INTO materials (uid, code, name, category, unit, initial_stock)
       VALUES (?, ?, ?, ?, '枚', ?)`
    );
    mat.run(generateUid(db, 'materials'), 'MAT-025', '300ml12本入り段ボール', '外箱', 39);
    mat.run(generateUid(db, 'materials'), 'MAT-029', '300ml1本入り段ボール', '外箱', 58);
    mat.run(generateUid(db, 'materials'), 'MAT-020', '桐箱(710ml)', '箱', 12);

    // 対応表。12本用には資材を設定し、1本用は**わざと未設定**にする
    // （資材が無いときに推奨が出ないことを確かめるため）
    const rule = db.prepare(
      `INSERT INTO carton_rules (product_id, quantity, carton_size, box_name, material_id)
       VALUES (?, ?, ?, ?, ?)`
    );
    rule.run(PRODUCT, 12, '100', '300ml12本用', BOX_12);
    rule.run(PRODUCT, 1, '60', '300ml一本用', null);
  }));
});

test.after(() => harness.teardown());

// --- 推奨 -------------------------------------------------------------------

test('推奨: 24本は「12本用×2箱」。割り算で箱数が出る', async () => {
  const orderId = await newOrder(24);
  const { status, body } = await api('GET', `/api/orders/${orderId}/carton-suggestion`);
  assert.equal(status, 200);
  assert.equal(body.reason, null);
  assert.equal(body.suggestion.materialId, BOX_12);
  assert.equal(body.suggestion.ruleQuantity, 12);
  assert.equal(body.suggestion.boxes, 2, '24 ÷ 12 = 2箱');

  // 完全一致しか見ていないと、ここが null になって落ちる
  const exact = db
    .prepare('SELECT COUNT(*) AS n FROM carton_rules WHERE product_id = ? AND quantity = 24')
    .get(PRODUCT).n;
  assert.equal(exact, 0, '24本の行がある状態だと、割り算を確かめたことにならない');
});

test('推奨: 対応表に行が無い商品では出ない（委託生産料などの物でない商品）', async () => {
  const res = await api('POST', '/api/orders', {
    orderedOn: '2026-08-01', customerId: CUSTOMER, productId: SERVICE_PRODUCT, quantity: 1,
  });
  const orderId = res.body.lines ? res.body.lines[0].id : res.body.id;

  const { body } = await api('GET', `/api/orders/${orderId}/carton-suggestion`);
  assert.equal(body.suggestion, null);
  assert.match(body.reason, /段ボール対応表にありません/);

  // 本当に1行も無いことを裏取りする（行があると別の理由で通ってしまう）
  const rules = db
    .prepare('SELECT COUNT(*) AS n FROM carton_rules WHERE product_id = ?')
    .get(SERVICE_PRODUCT).n;
  assert.equal(rules, 0);
});

test('推奨: 対応表に資材が設定されていないと、その理由が返る', async () => {
  // 1本用の行は material_id が空。12では割り切れないので1本用が選ばれる
  const orderId = await newOrder(7);
  const { body } = await api('GET', `/api/orders/${orderId}/carton-suggestion`);
  assert.equal(body.suggestion, null);
  assert.match(body.reason, /段ボールの資材が設定されていません/);
});

test('推奨: 選択肢は分類が「外箱」の資材だけ（桐箱は出さない）', async () => {
  const orderId = await newOrder(12);
  const { body } = await api('GET', `/api/orders/${orderId}/carton-suggestion`);
  const names = body.options.map((o) => o.name);
  assert.deepEqual(names.sort(), ['300ml12本入り段ボール', '300ml1本入り段ボール'].sort());
  assert.ok(!names.includes('桐箱(710ml)'), '個装の桐箱が選択肢に混ざっている');
  // 現在庫も返していること（画面で残りが見える）
  assert.equal(body.options.find((o) => o.id === BOX_12).current_stock, stockOf(BOX_12));
});

test('推奨: 複数明細の受注では出ない', async () => {
  // 1明細だけなら出ることを先に確かめる（この裏取りが無いと空振りになる）
  const single = await newOrder(12);
  const before = await api('GET', `/api/orders/${single}/carton-suggestion`);
  assert.equal(before.body.suggestion.boxes, 1, '1明細なら推奨が出る前提');

  const multi = await api('POST', '/api/orders', {
    orderedOn: '2026-08-02',
    customerId: CUSTOMER,
    items: [{ productId: PRODUCT, quantity: 12 }, { productId: PRODUCT, quantity: 1 }],
  });
  assert.equal(multi.status, 201);
  const { body } = await api('GET', `/api/orders/${multi.body.lines[0].id}/carton-suggestion`);
  assert.equal(body.suggestion, null);
  assert.match(body.reason, /複数明細/);
});

// --- 発送で減る -------------------------------------------------------------

test('発送で段ボールが減り、資材在庫が箱数ぶん下がる', async () => {
  const orderId = await newOrder(24);
  const before = stockOf(BOX_12);

  const { status, body } = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-10',
    cartons: [{ materialId: BOX_12, quantity: 2 }],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.cartons.length, 1);
  assert.equal(body.cartons[0].quantity, 2);
  assert.equal(stockOf(BOX_12), before - 2);

  // 出荷行に紐付いていること。これが取消の連鎖と、あとからの追跡のキー
  const row = db
    .prepare('SELECT * FROM material_stock_ledger WHERE id = ?')
    .get(body.cartons[0].ledgerId);
  assert.equal(row.product_ledger_id, body.stockLedgerId);
  assert.equal(row.txn_type, '消費');
  assert.equal(row.note, '出荷による自動消費');
  assert.equal(row.txn_date, '2026-08-10');
  assert.ok(row.history_code.startsWith('M2608-'), '資材履歴IDが採番されていない');
});

test('段ボールを選ばなければ減らさず、操作ログに理由が残る', async () => {
  const orderId = await newOrder(13);
  const before = stockOf(BOX_12);

  const { body } = await api('POST', `/api/orders/${orderId}/ship`, { deliveredOn: '2026-08-11' });
  assert.deepEqual(body.cartons, []);
  assert.equal(stockOf(BOX_12), before, '選んでいないのに減っている');

  const log = db
    .prepare("SELECT * FROM operation_logs WHERE action = 'order.ship' ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(log.summary, /段ボールは減らしていません/);
});

test('段ボールを使った発送は、操作ログにも何を何枚使ったかが残る', async () => {
  const orderId = await newOrder(12);
  await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-12',
    cartons: [{ materialId: BOX_12, quantity: 1 }],
  });
  const log = db
    .prepare("SELECT * FROM operation_logs WHERE action = 'order.ship' ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(log.summary, /段ボール: 300ml12本入り段ボール1枚/);
});

// --- 二重減算のガード -------------------------------------------------------

test('個装（桐箱）を段ボールとして指定すると422で止まる', async () => {
  const orderId = await newOrder(12);
  const before = stockOf(KIRIBAKO);

  const { status, body } = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-13',
    cartons: [{ materialId: KIRIBAKO, quantity: 1 }],
  });
  assert.equal(status, 422, '分類のガードが外れている（箱詰めと二重に減る）');
  assert.match(body.message, /出荷用の段ボールではありません/);
  assert.match(body.message, /二重/);

  // 止まったので在庫も受注も動いていないこと（トランザクションが巻き戻っている）
  assert.equal(stockOf(KIRIBAKO), before);
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  assert.equal(order.status, '未着手', '例外なのに発送済になっている');
  const shipped = db
    .prepare("SELECT COUNT(*) AS n FROM product_stock_ledger WHERE order_id = ? AND txn_type = '出荷'")
    .get(orderId).n;
  assert.equal(shipped, 0, '例外なのに出荷行が残っている');
});

test('対応表にも個装は登録できない', async () => {
  const { status, body } = await api('POST', '/api/shipping/carton-rules', {
    productId: PRODUCT,
    quantity: 6,
    cartonSize: '100',
    materialId: KIRIBAKO,
  });
  assert.equal(status, 422);
  assert.match(body.message, /出荷用の段ボールではありません/);
});

// --- 取消で戻る -------------------------------------------------------------

test('出荷を取り消すと段ボールも戻る（既存の連鎖に乗っている）', async () => {
  const orderId = await newOrder(24);
  const before = stockOf(BOX_12);

  const ship = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-14',
    cartons: [{ materialId: BOX_12, quantity: 2 }],
  });
  assert.equal(stockOf(BOX_12), before - 2);

  // ledgerCancelService は product_ledger_id で資材行を連動取消する。
  // txn_type を見ていないので、紐付けさえしてあれば**無改修で戻る**
  const cancel = await api('POST', `/api/ledger-cancel/${ship.body.stockLedgerId}`, {
    reason: '誤って発送済にした',
  });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(cancel.body.restoredMaterialRows, 1, '資材行が連動して取り消されていない');
  assert.equal(stockOf(BOX_12), before, '取り消したのに段ボールが減ったまま');

  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  assert.equal(order.status, '未着手');
});

// --- 止めない ---------------------------------------------------------------

test('段ボールの在庫が足りなくても発送は止まらない（在庫監査が後で拾う）', async () => {
  const orderId = await newOrder(12);
  const before = stockOf(BOX_1);

  const { status } = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-15',
    cartons: [{ materialId: BOX_1, quantity: before + 5 }],
  });
  assert.equal(status, 200, '在庫不足で止めてしまっている（既存の方針と違う）');
  assert.equal(stockOf(BOX_1), -5, 'マイナスのまま残ること');

  const audit = await api('GET', '/api/audit');
  const negative = JSON.stringify(audit.body);
  assert.match(negative, /300ml1本入り段ボール/, '在庫監査がマイナスを拾えていない');
});

// --- 対応表が呼び名と資材を覚える -------------------------------------------

test('対応表に登録すると、呼び名と資材も保存される', async () => {
  const { status, body } = await api('POST', '/api/shipping/carton-rules', {
    productId: PRODUCT,
    quantity: 6,
    cartonSize: '100',
    boxName: '300ml6本用',
    materialId: BOX_1,
  });
  assert.equal(status, 201, JSON.stringify(body));
  // 以前は carton_size しか書いていなかったので、ここが null になって落ちる
  assert.equal(body.box_name, '300ml6本用');
  assert.equal(body.material_id, BOX_1);

  const listed = (await api('GET', '/api/shipping/carton-rules')).body
    .find((r) => r.product_id === PRODUCT && r.quantity === 6);
  assert.equal(listed.material_name, '300ml1本入り段ボール');

  // 登録したら推奨に回ること（これが「対応表に覚えさせる」の目的）
  const orderId = await newOrder(6);
  const { body: sug } = await api('GET', `/api/orders/${orderId}/carton-suggestion`);
  assert.equal(sug.suggestion.materialId, BOX_1);
  assert.equal(sug.suggestion.boxes, 1);
});

// --- ゆうパックCSV（D-2）-----------------------------------------------------
//
// 63列目のサイズを確かめている試験は1件も無かった。そこを押さえる。

const iconv = require('iconv-lite');

/** ゆうパックCSVを取って、1行ぶんのセル配列にする */
async function yupackCells(query) {
  const res = await harness.rawFetch(`/api/exports/yupack?${query}`, {
    headers: { Cookie: harness.state.cookie },
  });
  const text = iconv.decode(Buffer.from(await res.arrayBuffer()), 'Shift_JIS');
  const lines = text.trim().split('\r\n').filter(Boolean);
  return {
    res,
    lines,
    cells: lines.map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, ''))),
  };
}

test('ゆうパックCSV: 63列目に段ボールのサイズが入る', async () => {
  const orderId = await newOrder(12, { deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様' });
  const { cells } = await yupackCells(`orderIds=${orderId}`);
  assert.equal(cells.length, 1);
  // 対応表の 12本用 = 100サイズ。3桁に左0詰め
  assert.equal(cells[0][62], '100');
});

test('ゆうパックCSV: 63列目は発送画面と同じ引き方（24本は12本用で100サイズ）', async () => {
  // 完全一致だけだと 24本の行が無いので空欄になり、画面は「12本用×2箱」と言うのに
  // CSVは「対応表にありません」と出る、という食い違いが起きる
  const orderId = await newOrder(24, { deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様' });
  const { cells } = await yupackCells(`orderIds=${orderId}`);
  assert.equal(cells[0][62], '100');

  const exact = db
    .prepare('SELECT COUNT(*) AS n FROM carton_rules WHERE product_id = ? AND quantity = 24')
    .get(PRODUCT).n;
  assert.equal(exact, 0, '24本の行がある状態だと、割り算を確かめたことにならない');
});

test('ゆうパックCSV: サイズが決まらない受注は、黙って空欄にせず要確認で知らせる', async () => {
  // 対応表に1行も無い商品（委託生産料などの物でない商品）
  const res0 = await api('POST', '/api/orders', {
    orderedOn: '2026-08-19', customerId: CUSTOMER, productId: SERVICE_PRODUCT, quantity: 1,
    deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様',
  });
  const orderId = res0.body.lines ? res0.body.lines[0].id : res0.body.id;
  const { res, cells } = await yupackCells(`orderIds=${orderId}`);

  assert.equal(cells[0][62], '', '決まらないので空欄なのは従来どおり');
  // 以前はここで何も知らせていなかった
  const unresolved = JSON.parse(decodeURIComponent(res.headers.get('x-unresolved')));
  const found = unresolved.find((u) => /対応表にありません/.test(u.reason ?? ''));
  assert.ok(found, '段ボールが決まらないことを知らせていない');
  assert.equal(res.headers.get('x-unresolved-count'), String(unresolved.length));
});

test('ゆうパックCSV: 複数明細は1行目のサイズで代用しない', async () => {
  const multi = await api('POST', '/api/orders', {
    orderedOn: '2026-08-20',
    customerId: CUSTOMER,
    items: [{ productId: PRODUCT, quantity: 12 }, { productId: PRODUCT, quantity: 3 }],
    deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様',
  });
  const ids = multi.body.lines.map((l) => l.id).join(',');
  const { res, cells } = await yupackCells(`orderIds=${ids}`);

  assert.equal(cells.length, 1, '2明細でも荷物1件＝1行');
  // 1行目（12本）の 100 をそのまま使っていたのが以前の挙動。
  // 12本用の箱に15本は入らないので、決まらないと返すのが正しい
  assert.equal(cells[0][62], '', '1行目のサイズで代用してしまっている');
  const unresolved = JSON.parse(decodeURIComponent(res.headers.get('x-unresolved')));
  assert.ok(unresolved.some((u) => /複数明細/.test(u.reason ?? '')));
});

test('ゆうパックCSV: 個数は実際に使った段ボールの箱数になる', async () => {
  const orderId = await newOrder(24, { deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様' });

  // 発送前は箱数が分からないので 1（従来どおり）
  const before = await yupackCells(`orderIds=${orderId}`);
  assert.equal(before.cells[0][36], '1');

  await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-21',
    cartons: [{ materialId: BOX_12, quantity: 2 }],
  });

  const after = await yupackCells(`orderIds=${orderId}`);
  assert.equal(after.cells[0][36], '2', '実際に使った箱数が個数に出ていない');
});

test('ゆうパックCSV: 取り消した段ボールは個数に数えない', async () => {
  const orderId = await newOrder(24, { deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様' });
  const ship = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-22',
    cartons: [{ materialId: BOX_12, quantity: 2 }],
  });
  assert.equal((await yupackCells(`orderIds=${orderId}`)).cells[0][36], '2');

  await api('POST', `/api/ledger-cancel/${ship.body.stockLedgerId}`, { reason: '入れ直し' });
  // 取消済みを数えていると 2 のままになる
  assert.equal((await yupackCells(`orderIds=${orderId}`)).cells[0][36], '1');
});

test('段ボールの行は資材タブから単独では取り消せない（受注タブへ案内する）', async () => {
  const orderId = await newOrder(12, { deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様' });
  const ship = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-23',
    cartons: [{ materialId: BOX_12, quantity: 1 }],
  });

  const res = await api(
    'POST', `/api/materials/ledger/${ship.body.cartons[0].ledgerId}/cancel`, { reason: '箱を変えた' }
  );
  assert.equal(res.status, 422);
  // 瓶詰め・箱詰めタブに案内すると、利用者は無いものを探しに行く
  assert.match(res.body.message, /受注タブ/);
  assert.ok(!/瓶詰め・箱詰めタブ/.test(res.body.message));
});

test('ゆうパックCSV: 段ボールの行が取消済みなら個数に数えない', async () => {
  // 資材タブからは単独で取り消せない（上の試験）が、瓶詰め側の編集などで
  // 資材行だけが取消済みになることはある。出荷側の取消フラグでは拾えないので、
  // 資材側の取消も見ていないと、使っていない箱を数え続ける
  const orderId = await newOrder(24, { deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 山田太郎様' });
  const ship = await api('POST', `/api/orders/${orderId}/ship`, {
    deliveredOn: '2026-08-24',
    cartons: [{ materialId: BOX_12, quantity: 2 }],
  });
  assert.equal((await yupackCells(`orderIds=${orderId}`)).cells[0][36], '2');

  db.prepare('UPDATE material_stock_ledger SET is_cancelled = 1 WHERE id = ?')
    .run(ship.body.cartons[0].ledgerId);

  // 出荷行は生きたままなので、ml.is_cancelled を見ていないと 2 のまま
  const shipRow = db
    .prepare('SELECT is_cancelled FROM product_stock_ledger WHERE id = ?')
    .get(ship.body.stockLedgerId);
  assert.equal(shipRow.is_cancelled, 0, '出荷まで取り消されていて、この試験の意味がない');
  assert.equal((await yupackCells(`orderIds=${orderId}`)).cells[0][36], '1');
});
