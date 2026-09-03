// 最新のGAS版READMEとの突合で埋めた差分の検証。
// 複数明細の受注／仕掛品ロット／記録の取り消し／送料計算／
// ダッシュボードの各アラート／マスタのCSV一括登録／タンクの採番と廃棄。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-gas-parity.sqlite');
const { api } = harness;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(`INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day, address)
                VALUES (?, '能登酒店', 0.7, 1, '末日', '石川県金沢市吉原町ヨ87-1')`).run(generateUid(db, 'customers'));
    db.prepare(`INSERT INTO products (uid, name, volume_ml, list_price, initial_product_stock, initial_wip_stock)
                VALUES (?, '浄酎 300ml', 300, 3000, 0, 0)`).run(generateUid(db, 'products'));
    db.prepare(`INSERT INTO products (uid, name, volume_ml, list_price)
                VALUES (?, '浄酎 700ml', 700, 6000)`).run(generateUid(db, 'products'));
    db.prepare(`INSERT INTO materials (uid, name, unit, unit_price, initial_stock)
                VALUES (?, '300ml瓶', '本', 100, 10000)`).run(generateUid(db, 'materials'));
    db.prepare(`INSERT INTO materials (uid, name, unit, unit_price, initial_stock)
                VALUES (?, '化粧箱', '枚', 60, 10000)`).run(generateUid(db, 'materials'));
    db.prepare(`INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
                VALUES (?, 'T-01', '貯蔵タンク1号', 'ステンレスタンク', 1000, 500)`).run(generateUid(db, 'tanks'));
    db.prepare(`INSERT INTO product_recipes (product_id, material_id, qty_required, process)
                VALUES (1, 1, 1, '瓶詰'), (1, 2, 1, '箱詰')`).run();
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 1受注で複数商品（同じ受注番号で複数行） ---

test('1受注で複数商品を頼まれたら、同じ受注番号で複数行になる', async () => {
  const { status, body } = await api('POST', '/api/orders', {
    orderedOn: '2026-09-01',
    customerId: 1,
    items: [
      { productId: 1, quantity: 10 },
      { productId: 2, quantity: 5 },
    ],
    shippingFee: 800,
  });

  assert.equal(status, 201);
  assert.equal(body.lines.length, 2);
  assert.equal(body.lines[0].order_no, body.lines[1].order_no);
  assert.deepEqual(body.lines.map((l) => l.line_no), [1, 2]);

  // 送料は受注単位。1行目にだけ載せて二重計上を防ぐ
  assert.equal(body.lines[0].shipping_fee, 800);
  assert.equal(body.lines[1].shipping_fee, 0);
  assert.equal(body.lines[0].total_amount, 10 * 3000 * 0.7 + 800);
  assert.equal(body.lines[1].total_amount, 5 * 6000 * 0.7);
});

test('単品指定は従来どおり受注1件として登録できる', async () => {
  const { status, body } = await api('POST', '/api/orders', {
    orderedOn: '2026-09-02',
    customerId: 1,
    productId: 1,
    quantity: 3,
  });
  assert.equal(status, 201);
  assert.equal(body.line_no, 1);
  assert.equal(body.lines.length, 1);
});

test('商品も明細も無い受注は400になる', async () => {
  const { status } = await api('POST', '/api/orders', {
    orderedOn: '2026-09-02',
    customerId: 1,
  });
  assert.equal(status, 400);
});

// --- 仕掛品ロット ---

test('瓶詰めごとにロットができ、残量が見える', async () => {
  await api('POST', '/api/bottling', {
    productId: 1, quantity: 100, tankId: 1, volumeL: 30, txnDate: '2026-09-01',
  });
  await api('POST', '/api/bottling', {
    productId: 1, quantity: 50, tankId: 1, volumeL: 15, txnDate: '2026-09-02',
  });

  const { status, body } = await api('GET', '/api/wip-lots?productId=1');
  assert.equal(status, 200);
  assert.equal(body.length, 2);
  assert.equal(body[0].txn_date, '2026-09-01'); // 古い順
  assert.equal(body[0].remaining, 100);
});

test('箱詰めは古いロットから引き当てる（FIFO）', async () => {
  const { body } = await api('POST', '/api/boxing', { productId: 1, quantity: 30 });
  assert.equal(body.allocations.length, 1);
  assert.equal(body.allocations[0].quantity, 30);

  const lots = await api('GET', '/api/wip-lots?productId=1');
  assert.equal(lots.body[0].remaining, 70); // 100 - 30
  assert.equal(lots.body[1].remaining, 50);
});

test('ロットを指定でき、足りない分は次に古いロットから自動で補う', async () => {
  const lots = await api('GET', '/api/wip-lots?productId=1');
  const newerLot = lots.body[1]; // 残50の新しいロット

  // 新しいロットを指定して80本。50本しかないので、残りは古いロットから補われる
  const { status, body } = await api('POST', '/api/boxing', {
    productId: 1,
    quantity: 80,
    lotLedgerId: newerLot.id,
  });
  assert.equal(status, 201);
  assert.equal(body.allocations.length, 2);
  assert.equal(body.allocations[0].bottlingLedgerId, newerLot.id);
  assert.equal(body.allocations[0].quantity, 50);
  assert.equal(body.allocations[1].quantity, 30);

  const after = await api('GET', '/api/wip-lots?productId=1');
  assert.equal(after.body.length, 1);
  assert.equal(after.body[0].remaining, 40); // 70 - 30
});

test('仕掛品の合計を超える箱詰めは断られる', async () => {
  const { status, body } = await api('POST', '/api/boxing', { productId: 1, quantity: 999 });
  assert.equal(status, 422);
  assert.match(body.message, /仕掛品在庫が不足/);
});

// --- 記録の取り消し ---

test('箱詰めを取り消すと、商品在庫・資材・ロット残量が戻る', async () => {
  const before = await api('GET', '/api/products/1/stock');
  const materialBefore = db.prepare('SELECT * FROM v_material_stock WHERE material_id = 2').get();
  const lotsBefore = await api('GET', '/api/wip-lots?productId=1');

  const boxing = await api('POST', '/api/boxing', { productId: 1, quantity: 10 });
  const ledgerId = boxing.body.productLedgerId;

  const cancel = await api('POST', `/api/ledger-cancel/${ledgerId}`, { reason: '本数を間違えた' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.restoredMaterialRows, 1);

  const after = await api('GET', '/api/products/1/stock');
  assert.equal(after.body.product_stock, before.body.product_stock);
  assert.equal(after.body.wip_stock, before.body.wip_stock);

  const materialAfter = db.prepare('SELECT * FROM v_material_stock WHERE material_id = 2').get();
  assert.equal(materialAfter.current_stock, materialBefore.current_stock);

  const lotsAfter = await api('GET', '/api/wip-lots?productId=1');
  assert.deepEqual(
    lotsAfter.body.map((l) => l.remaining),
    lotsBefore.body.map((l) => l.remaining)
  );
});

test('取消理由がないと断られる', async () => {
  const boxing = await api('POST', '/api/boxing', { productId: 1, quantity: 1 });
  const { status } = await api('POST', `/api/ledger-cancel/${boxing.body.productLedgerId}`, { reason: '' });
  assert.equal(status, 400);
});

test('二重の取消は409になる', async () => {
  const boxing = await api('POST', '/api/boxing', { productId: 1, quantity: 1 });
  const id = boxing.body.productLedgerId;
  await api('POST', `/api/ledger-cancel/${id}`, { reason: '誤登録' });
  const { status, body } = await api('POST', `/api/ledger-cancel/${id}`, { reason: 'もう一度' });
  assert.equal(status, 409);
  assert.match(body.message, /既に取消済み/);
});

test('箱詰めで使われている瓶詰めは、先に箱詰めを取り消さないと取り消せない', async () => {
  const bottling = await api('POST', '/api/bottling', {
    productId: 1, quantity: 20, tankId: 1, volumeL: 6, txnDate: '2026-09-05',
  });
  const boxing = await api('POST', '/api/boxing', {
    productId: 1, quantity: 5, lotLedgerId: bottling.body.productLedgerId,
  });

  const blocked = await api('POST', `/api/ledger-cancel/${bottling.body.productLedgerId}`, {
    reason: '瓶詰めの取消',
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /先にその箱詰めを取り消して/);

  await api('POST', `/api/ledger-cancel/${boxing.body.productLedgerId}`, { reason: '順番の確認' });
  const ok = await api('POST', `/api/ledger-cancel/${bottling.body.productLedgerId}`, {
    reason: '瓶詰めの取消',
  });
  assert.equal(ok.status, 200);
});

test('出荷を取り消すと受注が未着手に戻る', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-09-10', customerId: 1, productId: 1, quantity: 2,
  });
  await api('POST', `/api/orders/${order.body.id}/ship`, { deliveredOn: '2026-09-11' });

  const ledger = db
    .prepare("SELECT * FROM product_stock_ledger WHERE order_id = ? AND txn_type = '出荷'")
    .get(order.body.id);

  const cancel = await api('POST', `/api/ledger-cancel/${ledger.id}`, { reason: '誤出荷' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.revertedOrderNo, order.body.order_no);

  const reloaded = await api('GET', `/api/orders/${order.body.id}`);
  assert.equal(reloaded.body.status, '未着手');
  assert.equal(reloaded.body.delivered_on, null);
});

// --- 送料計算 ---

test('地帯も対応表も未登録なら、理由つきで「決まらない」と返る', async () => {
  const { status, body } = await api('POST', '/api/shipping/quote', {
    address: '石川県金沢市吉原町ヨ87-1',
    items: [{ productId: 1, quantity: 12 }],
  });
  assert.equal(status, 200);
  assert.equal(body.prefecture, '石川県');
  assert.equal(body.resolved, false);
  assert.equal(body.fee, null);
  assert.match(body.reasons.join(' '), /地帯が未登録/);
  assert.match(body.reasons.join(' '), /段ボール対応表にありません/);
});

test('地帯・対応表・料金を登録すると送料が確定する', async () => {
  await api('PUT', '/api/shipping/zones', { zones: [{ prefecture: '石川県', zone: '北陸' }] });
  await api('POST', '/api/shipping/rates', { zone: '北陸', cartonSize: '100サイズ', fee: 1200 });
  await api('POST', '/api/shipping/carton-rules', {
    productId: 1, quantity: 12, cartonSize: '100サイズ',
  });

  const { body } = await api('POST', '/api/shipping/quote', {
    address: '〒920-3114 石川県金沢市吉原町ヨ87-1',
    items: [{ productId: 1, quantity: 12 }],
  });
  assert.equal(body.zone, '北陸');
  assert.equal(body.cartonSize, '100サイズ');
  assert.equal(body.fee, 1200);
  assert.equal(body.resolved, true);
  assert.deepEqual(body.reasons, []);
});

test('対応表にない本数は段ボールを選べば計算でき、追加すると次回から自動になる', async () => {
  const first = await api('POST', '/api/shipping/quote', {
    prefecture: '石川県',
    items: [{ productId: 1, quantity: 24 }],
  });
  assert.equal(first.body.resolved, false);
  assert.deepEqual(first.body.cartonOptions, ['100サイズ']);

  // 段ボールを選べばその場で計算できる
  const chosen = await api('POST', '/api/shipping/quote', {
    prefecture: '石川県',
    cartonSize: '100サイズ',
    items: [{ productId: 1, quantity: 24 }],
  });
  assert.equal(chosen.body.fee, 1200);

  // 「対応表に追加」すると、次回は選ばなくても決まる
  await api('POST', '/api/shipping/carton-rules', {
    productId: 1, quantity: 24, cartonSize: '100サイズ',
  });
  const again = await api('POST', '/api/shipping/quote', {
    prefecture: '石川県',
    items: [{ productId: 1, quantity: 24 }],
  });
  assert.equal(again.body.resolved, true);
});

test('住所から都道府県を読み取れなければその旨を返す', async () => {
  const { body } = await api('POST', '/api/shipping/quote', {
    address: '金沢市吉原町ヨ87-1',
    items: [{ productId: 1, quantity: 12 }],
  });
  assert.equal(body.prefecture, null);
  assert.match(body.reasons.join(' '), /都道府県を判定できません/);
});

test('複数商品の受注は段ボールを選ぶよう促される', async () => {
  const { body } = await api('POST', '/api/shipping/quote', {
    prefecture: '石川県',
    items: [{ productId: 1, quantity: 12 }, { productId: 2, quantity: 6 }],
  });
  assert.match(body.reasons.join(' '), /段ボールを選んでください/);
});

// --- ダッシュボード ---

test('入金予定日を過ぎて未入金の受注が拾える', async () => {
  db.prepare(
    `UPDATE orders SET payment_due_on = '2026-08-31', paid_on = NULL WHERE order_no = 'O2609-0002'`
  ).run();

  const { body } = await api('GET', '/api/dashboard/unpaid?asOf=2026-09-15');
  const target = body.find((o) => o.order_no === 'O2609-0002');
  assert.ok(target, '期日超過の受注が出ること');
  assert.equal(target.overdue_days, 15);
});

test('指定日の出荷予定が拾える', async () => {
  await api('POST', '/api/orders', {
    orderedOn: '2026-09-12',
    customerId: 1,
    productId: 1,
    quantity: 4,
    requestedDeliveryOn: '2026-09-20',
  });

  const { body } = await api('GET', '/api/dashboard/shipments-due?onDate=2026-09-20');
  assert.equal(body.length, 1);
  assert.equal(body[0].quantity, 4);
});

test('注文の間隔から次回注文日を予測する', async () => {
  const db2 = db;
  db2.prepare(`INSERT INTO customers (uid, name) VALUES ('predict01', '定期発注商店')`).run();
  const customerId = db2.prepare("SELECT id FROM customers WHERE name = '定期発注商店'").get().id;

  // 30日おきに4回注文している得意先
  for (const [i, date] of ['2026-05-01', '2026-05-31', '2026-06-30', '2026-07-30'].entries()) {
    await api('POST', '/api/orders', {
      orderedOn: date, customerId, productId: 1, quantity: 1 + i,
    });
  }

  const { body } = await api('GET', '/api/dashboard/order-forecast');
  const forecast = body.find((f) => f.customerName === '定期発注商店');
  assert.ok(forecast);
  assert.equal(forecast.averageIntervalDays, 30);
  assert.equal(forecast.predictedNextOn, '2026-08-29');
  assert.equal(forecast.confidence, '高');
});

test('瓶詰めから7日以上たって残っている仕掛品が拾える', async () => {
  // 十分に古い日付で瓶詰めし、箱詰めせずに残しておく
  const old = await api('POST', '/api/bottling', {
    productId: 2, quantity: 7, tankId: 1, volumeL: 5, txnDate: '2026-01-15',
  });
  assert.equal(old.status, 201);

  const { status, body } = await api('GET', '/api/wip-lots/stale');
  assert.equal(status, 200);
  const stale = body.find((lot) => lot.id === old.body.productLedgerId);
  assert.ok(stale, '滞留しているロットが出ること');
  assert.equal(stale.remaining, 7);
  assert.ok(stale.elapsed_days >= 7);

  // しきい値を極端に大きくすれば対象外になる
  const none = await api('GET', '/api/wip-lots/stale?days=100000');
  assert.deepEqual(none.body, []);
});

// --- タンクの採番と廃棄 ---

test('容器種別からプレフィックス付きの容器IDが採番される（GAS版と同じ対応表）', async () => {
  const prefixes = await api('GET', '/api/tanks/prefixes');
  const map = Object.fromEntries(prefixes.body.map((p) => [p.containerType, p.prefix]));
  assert.deepEqual(map, {
    ステンレスタンク: 'T',
    木樽: 'B',
    原酒ポリタンク: 'SP',
    残渣タンク: 'U',
    一斗瓶: 'G',
    出荷用ポリタンク: 'JP',
    QBテナー: 'Q',
    蒸留機: 'DISTL',
  });

  // 既存が T-01 なので、その書き方（2桁）を引き継ぐ
  const next = await api(
    'GET', '/api/tanks/next-code?containerType=' + encodeURIComponent('ステンレスタンク')
  );
  assert.equal(next.body.code, 'T-02');

  // 1件も無い種別は、シートと同じ3桁で始まる
  const fresh = await api('GET', '/api/tanks/next-code?containerType=' + encodeURIComponent('木樽'));
  assert.equal(fresh.body.code, 'B-001');

  const unknown = await api('GET', '/api/tanks/next-code?containerType=なにか');
  assert.equal(unknown.status, 422);
});

test('残量のあるタンクは廃棄できず、空にすれば廃棄でき一覧から消える', async () => {
  const blocked = await api('POST', '/api/tanks/1/discard', { reason: '古いので入れ替え' });
  assert.equal(blocked.status, 422);
  assert.match(blocked.body.message, /残量/);

  const created = await api('POST', '/api/tanks', {
    code: 'T-99', name: '廃棄テストタンク', containerType: 'ステンレスタンク', maxVolumeL: 100,
  });
  const discarded = await api('POST', `/api/tanks/${created.body.id}/discard`, {
    discardedOn: '2026-09-01', reason: '破損',
  });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.discarded_on, '2026-09-01');

  const list = await api('GET', '/api/tanks');
  assert.equal(list.body.some((t) => t.code === 'T-99'), false);

  const all = await api('GET', '/api/tanks?includeDiscarded=1');
  assert.equal(all.body.some((t) => t.code === 'T-99'), true);
});

// --- 営業メモ・商品複製・アラート消込・CSV一括登録 ---

test('得意先に営業メモを追記できる', async () => {
  const added = await api('POST', '/api/customers/1/notes', {
    notedOn: '2026-09-01', body: '新商品の提案。前向きな反応',
  });
  assert.equal(added.status, 201);

  await api('POST', '/api/customers/1/notes', { notedOn: '2026-09-05', body: '見積を送付' });
  const { body } = await api('GET', '/api/customers/1/notes');
  assert.equal(body.length, 2);
  assert.equal(body[0].noted_on, '2026-09-05'); // 新しい順
  assert.equal(body[0].created_by_name, 'テスト管理者');
});

test('商品を複製するとレシピも引き継がれ、在庫の起点は引き継がれない', async () => {
  const { status, body } = await api('POST', '/api/products/1/duplicate', {
    name: '浄酎 300ml（ギフト箱）',
    listPrice: 3500,
  });
  assert.equal(status, 201);
  assert.equal(body.volume_ml, 300);      // 複製元から引き継ぐ
  assert.equal(body.list_price, 3500);    // 指定で上書き
  assert.equal(body.initial_product_stock, 0);

  const recipe = await api('GET', `/api/products/${body.id}/recipe`);
  assert.equal(recipe.body.length, 2);
});

test('24時間超のアラートを処理済みにすると一覧から消える', async () => {
  db.prepare(
    `INSERT INTO distillations (distillation_code, started_on, started_time, status, total_input_l)
     VALUES ('D2609-9999', '2026-01-01', '09:00', '蒸留中', 10)`
  ).run();

  const before = await api('GET', '/api/distillations/alerts');
  const target = before.body.find((d) => d.distillation_code === 'D2609-9999');
  assert.ok(target);

  const ack = await api('POST', `/api/distillations/${target.id}/acknowledge-alert`, {
    note: '実機は停止済み。記録の閉じ忘れ',
  });
  assert.equal(ack.status, 200);

  const after = await api('GET', '/api/distillations/alerts');
  assert.equal(after.body.some((d) => d.distillation_code === 'D2609-9999'), false);
});

test('得意先をCSVで一括登録でき、同名は更新になる', async () => {
  const template = await api('GET', '/api/master-import/template/customers');
  assert.match(template.body.header, /得意先名/);

  const csv = [
    '得意先コード,得意先名,区分,掛率,住所,担当者',
    'C900,テスト酒販,小売,0.65,富山県富山市1-1,菅井',
    'C901,テスト卸,卸,0.6,福井県福井市2-2,山田',
  ].join('\n');

  const dry = await api('POST', '/api/master-import', { kind: 'customers', csv, dryRun: true });
  assert.equal(dry.body.created, 2);
  assert.equal(dry.body.updated, 0);

  const real = await api('POST', '/api/master-import', { kind: 'customers', csv });
  assert.equal(real.body.created, 2);

  const again = await api('POST', '/api/master-import', {
    kind: 'customers',
    csv: '得意先コード,得意先名,区分,掛率,住所,担当者\nC900,テスト酒販,小売,0.55,富山県富山市1-1,菅井',
  });
  assert.equal(again.body.updated, 1);

  const updated = db.prepare("SELECT * FROM customers WHERE name = 'テスト酒販'").get();
  assert.equal(updated.markup_rate, 0.55);
});

test('必須の列が無いCSVは取り込まずに、読み取れた見出しを添えて返す', async () => {
  const { status, body } = await api('POST', '/api/master-import', {
    kind: 'customers',
    csv: '名前,掛率\nどこかの店,0.7',
  });
  assert.equal(status, 422);
  assert.match(body.message, /必須の列がありません: 得意先名/);
  // どう直せばいいか分かるよう、実際に読み取れた見出しを見せる
  assert.match(body.message, /名前・掛率/);
});

test('数値でない掛率は行番号つきで指摘される', async () => {
  const { body } = await api('POST', '/api/master-import', {
    kind: 'customers',
    csv: '得意先名,掛率\nだめな店,ななわり',
  });
  assert.equal(body.created, 0);
  assert.equal(body.errors[0].line, 2);
  assert.match(body.errors[0].message, /数値で入力/);
});
