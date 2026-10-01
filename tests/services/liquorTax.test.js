// 酒税の月次算出（PR G）。
//
// この案件では「何も確かめていない試験」を何度も書いた（割り切れない本数のはずが
// 割り切れていた、月の絞り込みのはずが条件が常に真だった）。
// なので**外したら落ちること**を狙って書く。特に:
//   - 境目は1つずつ（35・36・37・38度）。加算額を大きくしても基準以下が動かないこと
//   - 未納税移出・返品を足しても課税額が**変わらない**こと（増えも減りもしない）
//   - 税率が引けない商品が**黙って0円にならない**こと

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-liquor-tax.sqlite');
const { api } = harness;

let db;

/** 出荷・返品・未納税移出の行を直接入れる（画面の操作を経ずに月をまたいだ形を作る） */
function ledger({ productId, txnType = '出荷', quantity, txnDate, cancelled = 0 }) {
  db.prepare(
    `INSERT INTO product_stock_ledger
       (txn_date, product_id, txn_type, quantity, is_cancelled, data_kind)
     VALUES (@txnDate, @productId, @txnType, @quantity, @cancelled, '過去（遡り入力）')`
  ).run({ txnDate, productId, txnType, quantity, cancelled });
}

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 41度・35度・37度。境目（37度）と、その上下を持つ
    const products = [
      ['浄酎 41度 300ml', 300, 41, 'スピリッツ'],
      ['浄酎 35度 500ml', 500, 35, 'スピリッツ'],
      ['浄酎 37度 720ml', 720, 37, 'スピリッツ'],
      // 区分が未設定。名指しで出るべき商品
      ['区分なしの酒 300ml', 300, 40, null],
      // 区分はあるが税率が登録されていない
      ['焼酎 25度 720ml', 720, 25, '単式蒸留焼酎'],
      // 容量が空。これも計算できない
      ['容量不明 何か', null, 40, 'スピリッツ'],
    ];
    for (const [name, volumeMl, abv, taxCategory] of products) {
      db.prepare(
        `INSERT INTO products (uid, name, volume_ml, abv, tax_category,
                               initial_product_stock, initial_wip_stock)
         VALUES (?, ?, ?, ?, ?, 0, 0)`
      ).run(generateUid(db, 'products'), name, volumeMl, abv, taxCategory);
    }
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 税率の登録 -------------------------------------------------------------

test('税率が未登録のうちは、酒税を計算せず商品を名指しで返す', async () => {
  ledger({ productId: 1, quantity: 10, txnDate: '2026-08-05' });

  const { status, body } = await api('GET', '/api/liquor-tax/monthly?month=2026-08');
  assert.equal(status, 200);
  assert.equal(body.taxable.rows.length, 0, '税率が無いのに金額を出さないこと');
  assert.equal(body.taxable.totals.taxAmount, 0);
  assert.equal(body.unresolved.length, 1);
  assert.equal(body.unresolved[0].productName, '浄酎 41度 300ml');
  assert.match(body.unresolved[0].reason, /税率が登録されていません/);
  // 何本抜けているかは分からないと直せない
  assert.equal(body.unresolved[0].quantity, 10);
});

test('酒類区分と税率を登録できる', async () => {
  const { status, body } = await api('POST', '/api/liquor-tax/rates', {
    category: 'スピリッツ',
    baseAbv: 37,
    baseYenPerKl: 370000,
    stepYenPerKl: 10000,
    note: '酒税法 スピリッツ',
  });
  assert.equal(status, 201);
  assert.equal(body.base_abv, 37);
  assert.equal(body.base_yen_per_kl, 370000);

  const categories = await api('GET', '/api/liquor-tax/categories');
  assert.deepEqual(categories.body, ['スピリッツ'], '商品マスタのプルダウンに出ること');
});

test('同じ区分・同じ適用開始日で登録すると上書きになる（行が増えない）', async () => {
  const before = await api('GET', '/api/liquor-tax/rates');
  await api('POST', '/api/liquor-tax/rates', {
    category: 'スピリッツ', baseAbv: 37, baseYenPerKl: 370000, stepYenPerKl: 10000,
    note: '酒税法第23条',
  });
  const after = await api('GET', '/api/liquor-tax/rates');
  assert.equal(after.body.length, before.body.length);
  assert.equal(after.body[0].note, '酒税法第23条');
});

// --- 税率の段（ここが本題） -------------------------------------------------

test('基準度数(37度)以下はどこでも基準税額のまま', async () => {
  // 35度・36度・37度がいずれも 370,000円/kl。利用者と確認した振る舞い
  const cases = [
    ['2026-09-01', 2, 500, 35], // 35度 500ml
    ['2026-09-02', 3, 720, 37], // 37度 720ml
  ];
  for (const [date, productId] of cases) {
    ledger({ productId, quantity: 1, txnDate: date });
  }

  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-09');
  const byName = new Map(body.taxable.rows.map((r) => [r.productName, r]));

  assert.equal(byName.get('浄酎 35度 500ml').yenPerKl, 370000, '35度が基準税額のまま');
  assert.equal(byName.get('浄酎 37度 720ml').yenPerKl, 370000, '37度も基準税額のまま');
  // 0.37円/ml。利用者が旧マスタで覚えていた数字と一致する
  assert.equal(byName.get('浄酎 35度 500ml').taxAmount, 185);   // 500ml × 0.37
  assert.equal(byName.get('浄酎 37度 720ml').taxAmount, 266.4); // 720ml × 0.37
});

test('36度も基準税額のまま（加算額を10倍にしても動かない）', async () => {
  // 「基準以下は一定」が本当に max(0, …) で作られているかを確かめる。
  // 段が1度ずれていたら、加算額を大きくしたときに36度が動いてしまう
  const rates = await api('GET', '/api/liquor-tax/rates');
  const original = rates.body.find((r) => r.category === 'スピリッツ' && !r.effective_from);

  db.prepare('UPDATE products SET abv = 36 WHERE id = 2').run();
  await api('POST', '/api/liquor-tax/rates', {
    category: 'スピリッツ', baseAbv: 37, baseYenPerKl: 370000, stepYenPerKl: 100000,
  });

  try {
    const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-09');
    const row = body.taxable.rows.find((r) => r.productName === '浄酎 35度 500ml');
    assert.equal(row.abv, 36);
    assert.equal(row.yenPerKl, 370000, '36度は加算の対象にならないこと');

    // 同じ税率で、38度なら加算が乗る（加算額そのものは効いている）
    db.prepare('UPDATE products SET abv = 38 WHERE id = 2').run();
    const after = await api('GET', '/api/liquor-tax/monthly?month=2026-09');
    const stepped = after.body.taxable.rows.find((r) => r.productName === '浄酎 35度 500ml');
    assert.equal(stepped.yenPerKl, 470000, '38度は1度分の加算が乗ること');
  } finally {
    db.prepare('UPDATE products SET abv = 35 WHERE id = 2').run();
    await api('POST', '/api/liquor-tax/rates', {
      category: 'スピリッツ',
      baseAbv: original.base_abv,
      baseYenPerKl: original.base_yen_per_kl,
      stepYenPerKl: original.step_yen_per_kl,
      note: original.note ?? undefined,
    });
  }
});

test('38度から1度ごとに加算が乗り、41度は0.41円/mlになる', async () => {
  ledger({ productId: 1, quantity: 1, txnDate: '2026-10-10' }); // 41度 300ml
  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-10');
  const row = body.taxable.rows[0];
  assert.equal(row.yenPerKl, 410000, '370,000 + 4度 × 10,000');
  assert.equal(row.taxAmount, 123); // 300ml × 0.41
});

test('度数の端数は切り捨て（41.5度は41度と同じ税率）', async () => {
  db.prepare('UPDATE products SET abv = 41.5 WHERE id = 1').run();
  try {
    const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-10');
    assert.equal(body.taxable.rows[0].yenPerKl, 410000);
  } finally {
    db.prepare('UPDATE products SET abv = 41 WHERE id = 1').run();
  }
});

// --- 金額の桁 ---------------------------------------------------------------

test('酒税は容量×本数×税率で出る（1本あたりの課税額×本数ではない）', async () => {
  ledger({ productId: 1, quantity: 12, txnDate: '2026-11-03' }); // 300ml 41度
  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-11');

  const row = body.taxable.rows[0];
  assert.equal(row.totalVolumeMl, 3600);
  assert.equal(row.totalVolumeL, 3.6);
  // 3,600ml × 0.41 = 1,476円。**容量を掛け忘れると 4.92円になる**
  assert.equal(row.taxAmount, 1476);
  assert.equal(body.taxable.totals.taxAmount, 1476);
});

// --- 何を数え、何を数えないか -----------------------------------------------

test('未納税移出は課税額に入らず、参考にだけ出る', async () => {
  const before = await api('GET', '/api/liquor-tax/monthly?month=2026-11');

  ledger({ productId: 1, txnType: '未納税移出', quantity: 100, txnDate: '2026-11-04' });

  const after = await api('GET', '/api/liquor-tax/monthly?month=2026-11');
  assert.equal(
    after.body.taxable.totals.taxAmount,
    before.body.taxable.totals.taxAmount,
    '課税額が変わらないこと'
  );
  assert.equal(after.body.reference['未納税移出'].totals.quantity, 100);
  assert.equal(before.body.reference['未納税移出'].totals.quantity, 0);
});

test('返品は控除しない（課税額が減らない）が、参考には出る', async () => {
  const before = await api('GET', '/api/liquor-tax/monthly?month=2026-11');

  ledger({ productId: 1, txnType: '返品', quantity: 5, txnDate: '2026-11-05' });

  const after = await api('GET', '/api/liquor-tax/monthly?month=2026-11');
  assert.equal(
    after.body.taxable.totals.taxAmount,
    before.body.taxable.totals.taxAmount,
    '返品で課税額が減らないこと'
  );
  const ref = after.body.reference['返品'];
  assert.equal(ref.totals.quantity, 5);
  // あとで控除するか決められるように、相当する金額も出しておく
  assert.equal(ref.rows[0].taxAmount, 615); // 300ml × 5本 × 0.41
});

test('取り消した出荷は課税額に入らない', async () => {
  const before = await api('GET', '/api/liquor-tax/monthly?month=2026-11');
  ledger({ productId: 1, quantity: 8, txnDate: '2026-11-06', cancelled: 1 });
  const after = await api('GET', '/api/liquor-tax/monthly?month=2026-11');
  assert.equal(after.body.taxable.totals.taxAmount, before.body.taxable.totals.taxAmount);

  // 取消でない同じ行なら増える（上の比較が「そもそも増えない条件」ではないこと）
  ledger({ productId: 1, quantity: 8, txnDate: '2026-11-06' });
  const live = await api('GET', '/api/liquor-tax/monthly?month=2026-11');
  assert.equal(
    live.body.taxable.totals.taxAmount,
    before.body.taxable.totals.taxAmount + 984 // 300ml × 8本 × 0.41
  );
});

test('対象月だけを数える（前月・翌月の出荷は入らない）', async () => {
  // 3か月に同じ本数を入れ、真ん中の月だけが出ることを確かめる
  ledger({ productId: 3, quantity: 7, txnDate: '2026-12-31' }); // 720ml 37度
  ledger({ productId: 3, quantity: 7, txnDate: '2027-01-15' });
  ledger({ productId: 3, quantity: 7, txnDate: '2027-02-01' });

  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2027-01');
  assert.equal(body.month, '2027-01');
  assert.equal(body.taxable.rows.length, 1);
  assert.equal(body.taxable.totals.quantity, 7, '3か月ぶん(21本)にならないこと');
  assert.equal(body.taxable.totals.taxAmount, 1864.8); // 720ml × 7本 × 0.37
});

// --- 計算できないものを黙って0円にしない -----------------------------------

test('区分が未設定・税率が無い・容量が空の商品は、合計に混ぜず名指しで返る', async () => {
  ledger({ productId: 4, quantity: 3, txnDate: '2027-03-02' }); // 区分なし
  ledger({ productId: 5, quantity: 4, txnDate: '2027-03-03' }); // 単式蒸留焼酎の税率が無い
  ledger({ productId: 6, quantity: 5, txnDate: '2027-03-04' }); // 容量が空
  ledger({ productId: 1, quantity: 2, txnDate: '2027-03-05' }); // これは計算できる

  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2027-03');

  assert.equal(body.taxable.rows.length, 1, '計算できた商品だけが内訳に出ること');
  assert.equal(body.taxable.totals.taxAmount, 246); // 300ml × 2本 × 0.41

  const reasons = new Map(body.unresolved.map((r) => [r.productName, r.reason]));
  assert.equal(reasons.size, 3);
  assert.match(reasons.get('区分なしの酒 300ml'), /酒類区分が未設定/);
  assert.match(reasons.get('焼酎 25度 720ml'), /単式蒸留焼酎.*税率が登録されていません/);
  assert.match(reasons.get('容量不明 何か'), /容量\(ml\)が未設定/);

  // 0円の行として内訳に混ざっていないこと（申告額が過少になる）
  for (const name of reasons.keys()) {
    assert.equal(body.taxable.rows.find((r) => r.productName === name), undefined);
  }
});

// --- 改正をまたぐ -----------------------------------------------------------

test('適用開始日のある税率は、その月から効く（過去の月は古い率のまま）', async () => {
  await api('POST', '/api/liquor-tax/rates', {
    category: 'スピリッツ',
    baseAbv: 37,
    baseYenPerKl: 400000,
    stepYenPerKl: 10000,
    effectiveFrom: '2027-05-01',
    note: '改正後',
  });

  ledger({ productId: 3, quantity: 1, txnDate: '2027-04-10' }); // 720ml 37度
  ledger({ productId: 3, quantity: 1, txnDate: '2027-05-10' });

  const april = await api('GET', '/api/liquor-tax/monthly?month=2027-04');
  assert.equal(april.body.taxable.rows[0].yenPerKl, 370000, '改正前の月は古い率');
  assert.equal(april.body.taxable.rows[0].taxAmount, 266.4); // 720ml × 0.37

  const may = await api('GET', '/api/liquor-tax/monthly?month=2027-05');
  assert.equal(may.body.taxable.rows[0].yenPerKl, 400000, '改正後の月は新しい率');
  assert.equal(may.body.taxable.rows[0].taxAmount, 288); // 720ml × 0.40
});

test('月の指定が無ければ前月を返す（月初に前月分を申告するため）', async () => {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  const expected = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const { body } = await api('GET', '/api/liquor-tax/monthly');
  assert.equal(body.month, expected);
});

test('対象月の形式が違えば422で断る', async () => {
  const { status } = await api('GET', '/api/liquor-tax/monthly?month=2027/06');
  assert.equal(status, 422);
});

// --- 出荷したときに台帳へ入る課税額 -----------------------------------------

test('発送するとその場で容量×本数×税率が台帳に入る', async () => {
  db.prepare(
    `INSERT INTO customers (uid, name, markup_rate) VALUES (?, '酒税テスト商店', 0.7)`
  ).run('lqtax001');

  // 改正（2027-05-01から）より前の日付を使う。混ぜると期待値がどの率のものか読めなくなる
  const order = await api('POST', '/api/orders', {
    customerId: 1, productId: 1, quantity: 6, orderedOn: '2026-06-01', unitPrice: 3000,
  });
  assert.equal(order.status, 201);

  const shipped = await api('POST', `/api/orders/${order.body.id}/ship`, {
    deliveredOn: '2026-06-02',
  });
  assert.equal(shipped.status, 200);

  const row = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(shipped.body.stockLedgerId);
  assert.equal(row.volume_ml, 1800);
  // 1,800ml × 0.41 = 738円。**tax_per_unit(300円)×6本 = 1,800円ではない**
  assert.equal(row.tax_amount, 738);

  // 月次にもそのまま出る
  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-06');
  assert.equal(body.taxable.totals.taxAmount, 738);
});

test('税率が引けない商品でも発送そのものは止めない（課税額だけ空になる）', async () => {
  const order = await api('POST', '/api/orders', {
    customerId: 1, productId: 4, quantity: 2, orderedOn: '2026-07-01', unitPrice: 3000,
  });
  const shipped = await api('POST', `/api/orders/${order.body.id}/ship`, {
    deliveredOn: '2026-07-02',
  });
  assert.equal(shipped.status, 200, '在庫が動いた事実は記録する');

  const row = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(shipped.body.stockLedgerId);
  assert.equal(row.tax_amount, null);

  // 黙って0円にせず、酒税タブで名指しされる
  const { body } = await api('GET', '/api/liquor-tax/monthly?month=2026-07');
  assert.equal(body.unresolved.length, 1);
  assert.equal(body.unresolved[0].productName, '区分なしの酒 300ml');
});

// --- 過去分の入れ直し -------------------------------------------------------

test('入れ直しは、まず何件どう変わるかだけを返す', async () => {
  // 移行時の形（容量を掛けていない課税額）を作る
  db.prepare(
    `UPDATE product_stock_ledger SET tax_amount = 0.41 * quantity
      WHERE txn_type = '出荷' AND is_cancelled = 0 AND product_id = 1`
  ).run();

  const { status, body } = await api('POST', '/api/liquor-tax/backfill', {});
  assert.equal(status, 200);
  assert.equal(body.applied, false);
  assert.ok(body.changedCount > 0, '直す対象があること');

  const sample = body.changes[0];
  assert.ok(sample.after > sample.before, '容量を掛けるので必ず増える');

  // 書き換わっていないこと
  const row = db
    .prepare(
      `SELECT tax_amount, quantity FROM product_stock_ledger
        WHERE id = ?`
    )
    .get(sample.ledgerId);
  assert.equal(row.tax_amount, 0.41 * row.quantity, 'まだ直っていないこと');
});

test('入れ直すと、その出荷日の税率で課税額が入る', async () => {
  const preview = await api('POST', '/api/liquor-tax/backfill', {});
  // 容量と率が分かっている商品の行を狙う（他の商品だと期待値が別の容量になる）
  const target = preview.body.changes.find((c) => c.productName === '浄酎 41度 300ml');

  const { body } = await api('POST', '/api/liquor-tax/backfill', { apply: true });
  assert.equal(body.applied, true);
  assert.equal(body.changedCount, preview.body.changedCount);

  const row = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(target.ledgerId);
  assert.equal(row.tax_amount, target.after);
  // 300ml × 本数 × 0.41。移行時の「0.41 × 本数」から容量ぶん増えている
  assert.equal(row.tax_amount, Math.round(row.quantity * 300 * 0.41 * 100) / 100);

  // もう一度やることはない
  const again = await api('POST', '/api/liquor-tax/backfill', {});
  assert.equal(again.body.changedCount, 0);
});

test('入れ直しで税率が引けなかった行は、飛ばして名指しで返る', async () => {
  const { body } = await api('POST', '/api/liquor-tax/backfill', {});
  const names = body.skipped.map((s) => s.productName);
  assert.ok(names.includes('区分なしの酒 300ml'), '飛ばした商品が分かること');
  // 飛ばした行の課税額は空のまま（0円にしていない）
  const row = db
    .prepare(
      `SELECT tax_amount FROM product_stock_ledger
        WHERE product_id = 4 AND txn_type = '出荷' LIMIT 1`
    )
    .get();
  assert.equal(row.tax_amount, null);
});

// --- 商品マスタの酒類区分 ---------------------------------------------------

test('商品の酒類区分は登録・変更でき、空に戻せる', async () => {
  const created = await api('POST', '/api/products', {
    name: '区分を付け外しする酒', volumeMl: 200, abv: 40, taxCategory: 'スピリッツ',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.tax_category, 'スピリッツ');

  const cleared = await api('PUT', `/api/products/${created.body.id}`, { taxCategory: '' });
  assert.equal(cleared.body.tax_category, null, '間違えた区分を空に戻せること');

  const reset = await api('PUT', `/api/products/${created.body.id}`, { taxCategory: 'スピリッツ' });
  assert.equal(reset.body.tax_category, 'スピリッツ');

  // 区分を触らない更新では消えない
  const untouched = await api('PUT', `/api/products/${created.body.id}`, { listPrice: 2000 });
  assert.equal(untouched.body.tax_category, 'スピリッツ');
});

test('複製した商品は酒類区分を引き継ぐ', async () => {
  const dup = await api('POST', '/api/products/1/duplicate', { name: '浄酎 41度 180ml', volumeMl: 180 });
  assert.equal(dup.status, 201);
  assert.equal(dup.body.tax_category, 'スピリッツ');
});

// --- CSV --------------------------------------------------------------------

test('酒税の内訳をCSVで出せる（合計行と要確認つき）', async () => {
  const { status, body } = await api('GET', '/api/exports/liquor-tax?month=2027-03');
  assert.equal(status, 200);

  const lines = body.trim().split('\r\n');
  assert.equal(
    lines[0].replace('﻿', ''),
    '商品名称,酒類区分,度数,容量(ml),本数,数量計(L),円/kl,酒税額(円),備考'
  );
  assert.ok(lines.some((l) => l.startsWith('合計,')), '合計行があること');
  // 税率が引けなかった商品も同じ表に出す（別ファイルだと転記で見落とす）
  assert.ok(
    lines.some((l) => l.includes('区分なしの酒 300ml') && l.includes('要確認')),
    '要確認の商品が理由つきで出ること'
  );
});

test('税率の削除は操作ログに残る', async () => {
  const rates = await api('GET', '/api/liquor-tax/rates');
  const target = rates.body.find((r) => r.effective_from === '2027-05-01');

  const { status } = await api('DELETE', `/api/liquor-tax/rates/${target.id}`);
  assert.equal(status, 200);

  const log = db
    .prepare(
      `SELECT * FROM operation_logs WHERE action = 'liquor_tax_rate.delete'
        ORDER BY id DESC LIMIT 1`
    )
    .get();
  assert.ok(log, '操作ログが残ること');
  assert.match(log.summary, /2027-05-01/);

  const after = await api('GET', '/api/liquor-tax/rates');
  assert.equal(after.body.find((r) => r.id === target.id), undefined);
});
