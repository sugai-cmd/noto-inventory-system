// 無償出荷の区分（サンプル／再発送／販促）。
//
// きっかけは、ふるさと納税の発送でキャップシールを貼り忘れて液漏れし、
// **売上を立てずに再発送した**こと。無償でも製造場からの移出なので酒税はかかる。
//
// この案件では「何も確かめていない試験」を何度も書いたので、**外したら落ちること**を狙う:
//   - 区分を省いたときに既定になることと、一覧に無い区分が通らないことを**対で**見る
//   - 無償を足しても**受注と売上が1つも動かない**こと（件数・売価）
//   - 酒税は**増える**こと。増分が容量×本数×税率と一致すること
//   - 合計 ＝ 有償 ＋ 無償 になること（有償と無償の両方がある状態で見る）

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-free-shipment.sqlite');
const { api } = harness;

let db;

// 300ml × 41度 ＝ 410,000円/kl ＝ 0.41円/ml
const YEN_PER_ML = 0.41;
const VOLUME_ML = 300;
const MONTH = '2026-11';

/** その月の酒税 */
const report = async () => (await api('GET', `/api/liquor-tax/monthly?month=${MONTH}`)).body;

/**
 * 本数ぶんの酒税。**端数を自分で丸めてから比べる**
 * （300×4×0.41 は浮動小数で 491.99999999999994 になり、素のかけ算では一致しない）。
 */
const taxOf = (bottles) => Math.round(VOLUME_ML * bottles * YEN_PER_ML * 1000) / 1000;

/** 区分ごとの内訳から1区分を引く（無い区分は undefined） */
const group = (rep, purpose) => rep.byPurpose.find((g) => g.purpose === purpose);

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO customers (uid, name, markup_rate, payment_term_months, payment_term_day)
       VALUES (?, 'ふるさと納税の送り先', 0.7, 1, '末日')`
    ).run(generateUid(db, 'customers'));

    db.prepare(
      `INSERT INTO products (uid, name, volume_ml, abv, tax_category, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, '浄酎 41度 300ml', ?, 41, 'スピリッツ', 3000, 500, 0)`
    ).run(generateUid(db, 'products'), VOLUME_ML);

    db.prepare(
      `INSERT INTO liquor_tax_rates (category, base_abv, base_yen_per_kl, step_yen_per_kl)
       VALUES ('スピリッツ', 37, 370000, 10000)`
    ).run();
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 登録 -------------------------------------------------------------------

test('区分を省くと「サンプル」になる', async () => {
  const { status, body } = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 1,
    customerId: 1,
    shippedOn: `${MONTH}-02`,
  });
  assert.equal(status, 201);
  assert.equal(body.purpose, 'サンプル');

  const row = db.prepare('SELECT * FROM sample_shipments WHERE id = ?').get(body.sampleId);
  assert.equal(row.purpose, 'サンプル');

  // 備考は今までの文言のまま（過去の履歴と見た目を揃える）
  const ledger = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(body.stockLedgerId);
  assert.equal(ledger.note, `サンプル送付 ${body.sampleNo}`);
});

// 上の試験と対で見る。既定に落ちるだけなら区分を足した意味が無い
test('区分「再発送」で登録でき、台帳の備考にも区分が入る', async () => {
  const { status, body } = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 1,
    customerId: 1,
    shippedOn: `${MONTH}-05`,
    purpose: '再発送',
    note: 'ふるさと納税の再発送（キャップシール貼り忘れで液漏れ）',
  });
  assert.equal(status, 201);
  assert.equal(body.purpose, '再発送');

  const row = db.prepare('SELECT * FROM sample_shipments WHERE id = ?').get(body.sampleId);
  assert.equal(row.purpose, '再発送');

  // 在庫の履歴だけを見た人にも理由が分かること
  const ledger = db
    .prepare('SELECT * FROM product_stock_ledger WHERE id = ?')
    .get(body.stockLedgerId);
  assert.equal(ledger.note, `再発送 ${body.sampleNo}`);
  assert.equal(ledger.txn_type, '出荷');
  assert.equal(ledger.order_id, null, '受注とは紐付かないこと');
});

test('一覧に無い区分は422。一覧にある区分は通る', async () => {
  const bad = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 1,
    shippedOn: `${MONTH}-06`,
    purpose: '贈答',
  });
  assert.equal(bad.status, 422);
  assert.match(bad.body.message, /区分「贈答」は選べません/);

  // 対で見る。全部422なら「通らないこと」を確かめても意味が無い
  const ok = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 1,
    shippedOn: `${MONTH}-06`,
    purpose: '販促',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.purpose, '販促');
});

test('選べる区分の一覧を返す（画面はここから選択肢を作る）', async () => {
  const { status, body } = await api('GET', '/api/shipments/samples/purposes');
  assert.equal(status, 200);
  assert.deepEqual(body.purposes, ['サンプル', '再発送', '販促']);
  assert.equal(body.default, 'サンプル');
});

// --- 一覧 -------------------------------------------------------------------

test('一覧は区分を返し、区分で絞れる', async () => {
  const all = await api('GET', '/api/shipments/samples');
  assert.equal(all.body.total, 3);
  assert.deepEqual(
    all.body.rows.map((r) => r.purpose).sort(),
    ['サンプル', '再発送', '販促']
  );

  const resent = await api('GET', '/api/shipments/samples?purpose=再発送');
  assert.equal(resent.body.total, 1);
  assert.equal(resent.body.rows[0].purpose, '再発送');
  assert.match(resent.body.rows[0].note, /キャップシール/);
});

// 移行ローダー経由で入った行は purpose が空のまま入り得る
test('区分が空の行も「サンプル」として出て、サンプルで絞ると当たる', async () => {
  const id = db
    .prepare(
      `INSERT INTO sample_shipments (sample_no, shipped_on, product_id, quantity, purpose)
       VALUES ('S2611-9999', '${MONTH}-07', 1, 1, NULL)`
    )
    .run().lastInsertRowid;

  const listed = await api('GET', '/api/shipments/samples?purpose=サンプル');
  const row = listed.body.rows.find((r) => r.id === id);
  assert.ok(row, '区分が空の行もサンプルの絞り込みに当たること');
  assert.equal(row.purpose, 'サンプル');

  db.prepare('DELETE FROM sample_shipments WHERE id = ?').run(id);
});

// --- 売上に乗らない ---------------------------------------------------------

test('無償出荷を足しても、受注と売上は1つも動かない', async () => {
  const beforeOrders = await api('GET', '/api/orders');
  const beforeSummary = await api('GET', '/api/orders/summary');

  const { status } = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 3,
    customerId: 1,
    shippedOn: `${MONTH}-08`,
    purpose: '再発送',
  });
  assert.equal(status, 201);

  const afterOrders = await api('GET', '/api/orders');
  const afterSummary = await api('GET', '/api/orders/summary');

  assert.equal(afterOrders.body.total, beforeOrders.body.total, '受注の件数が変わらないこと');
  assert.deepEqual(afterSummary.body, beforeSummary.body, '売上の集計が1つも変わらないこと');
});

// --- 酒税には乗る -----------------------------------------------------------

test('無償出荷の分だけ酒税が増える（増分＝容量×本数×税率）', async () => {
  const before = await report();

  const { status } = await api('POST', '/api/shipments/samples', {
    productId: 1,
    quantity: 4,
    customerId: 1,
    shippedOn: `${MONTH}-09`,
    purpose: '販促',
  });
  assert.equal(status, 201);

  const after = await report();
  const expected = taxOf(4);

  assert.equal(
    after.taxable.totals.taxAmount - before.taxable.totals.taxAmount,
    expected,
    '課税移出の合計が容量×本数×税率だけ増えること'
  );
  assert.equal(
    after.freeTotals.taxAmount - before.freeTotals.taxAmount,
    expected,
    '無償分の合計も同じだけ増えること'
  );
  assert.equal(after.taxable.totals.quantity - before.taxable.totals.quantity, 4);
});

test('有償と無償の両方があるとき、合計＝有償＋無償になる', async () => {
  // 有償の出荷をひとつ作る（受注 → 発送済）
  const order = await api('POST', '/api/orders', {
    orderedOn: `${MONTH}-10`,
    customerId: 1,
    productId: 1,
    quantity: 7,
  });
  assert.equal(order.status, 201);
  const shipped = await api('POST', `/api/orders/${order.body.id}/ship`, {
    deliveredOn: `${MONTH}-11`,
  });
  assert.equal(shipped.status, 200);

  const rep = await report();
  const paid = group(rep, '有償');
  assert.ok(paid, '有償の内訳があること');
  assert.equal(paid.isFree, false);
  assert.equal(paid.totals.quantity, 7, '受注の発送分が有償に入ること');

  const freeSum = rep.byPurpose
    .filter((g) => g.isFree)
    .reduce((t, g) => t + g.totals.taxAmount, 0);
  assert.equal(rep.freeTotals.taxAmount, freeSum, '無償の合計が区分ごとの和と一致すること');

  // ここが区分を足した目的。**合計は有償と無償の和**で、無償も課税されている
  assert.equal(
    rep.taxable.totals.taxAmount,
    paid.totals.taxAmount + rep.freeTotals.taxAmount,
    '合計 ＝ 有償 ＋ 無償'
  );
  assert.equal(
    rep.taxable.totals.quantity,
    paid.totals.quantity + rep.freeTotals.quantity
  );
  assert.ok(rep.freeTotals.taxAmount > 0, '無償分が0でないこと（0なら上の等式は空振りする）');
});

test('区分ごとの内訳が本数と税額で分かれて出る', async () => {
  const rep = await report();

  // サンプル1本・再発送1+3本・販促1+4本
  assert.equal(group(rep, 'サンプル').totals.quantity, 1);
  assert.equal(group(rep, '再発送').totals.quantity, 4);
  assert.equal(group(rep, '販促').totals.quantity, 5);

  assert.equal(group(rep, '再発送').totals.taxAmount, taxOf(4));
  assert.equal(group(rep, '再発送').isFree, true);
});

// --- 区分をあとから直す -----------------------------------------------------

test('区分だけをあとから直せる（数量・商品・日付は変わらない）', async () => {
  const listed = await api('GET', '/api/shipments/samples?purpose=サンプル');
  const target = listed.body.rows[0];
  const before = db.prepare('SELECT * FROM sample_shipments WHERE id = ?').get(target.id);

  const { status, body } = await api('PATCH', `/api/shipments/samples/${target.id}`, {
    purpose: '再発送',
  });
  assert.equal(status, 200);
  assert.equal(body.before, 'サンプル');
  assert.equal(body.purpose, '再発送');

  const after = db.prepare('SELECT * FROM sample_shipments WHERE id = ?').get(target.id);
  assert.equal(after.purpose, '再発送');
  // 在庫と酒税が動く欄は触らない
  assert.equal(after.quantity, before.quantity);
  assert.equal(after.product_id, before.product_id);
  assert.equal(after.shipped_on, before.shipped_on);
  assert.equal(after.customer_id, before.customer_id);
  assert.equal(after.note, before.note);

  // 台帳の備考も書き直す（在庫の履歴に古い区分が残らないように）
  const ledger = db
    .prepare(`SELECT * FROM product_stock_ledger WHERE sample_shipment_id = ? AND txn_type = '出荷'`)
    .get(target.id);
  assert.equal(ledger.note, `再発送 ${after.sample_no}`);

  // 酒税の内訳にも移る。合計は変わらない（どちらも課税移出）
  const rep = await report();
  assert.equal(group(rep, 'サンプル'), undefined, 'サンプルが0件になれば内訳から消えること');
  assert.equal(group(rep, '再発送').totals.quantity, 5);

  // 操作ログに残る
  const log = db
    .prepare(`SELECT * FROM operation_logs WHERE action = 'sample.purpose.update' ORDER BY id DESC LIMIT 1`)
    .get();
  assert.ok(log, '操作ログが残ること');
  assert.match(log.summary, /サンプル → 再発送/);
});

test('一覧に無い区分には直せない。一覧にある区分なら直せる', async () => {
  const listed = await api('GET', '/api/shipments/samples?purpose=販促');
  const id = listed.body.rows[0].id;

  const bad = await api('PATCH', `/api/shipments/samples/${id}`, { purpose: '贈答' });
  assert.equal(bad.status, 422);

  const ok = await api('PATCH', `/api/shipments/samples/${id}`, { purpose: 'サンプル' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.purpose, 'サンプル');
});

// 在庫と酒税が動く欄を、区分を直す口から触れないようにしてある
test('区分を直す口に数量などを混ぜると400（黙って捨てない）', async () => {
  const listed = await api('GET', '/api/shipments/samples');
  const id = listed.body.rows[0].id;

  const { status } = await api('PATCH', `/api/shipments/samples/${id}`, {
    purpose: '再発送',
    quantity: 99,
  });
  assert.equal(status, 400);

  const row = db.prepare('SELECT * FROM sample_shipments WHERE id = ?').get(id);
  assert.notEqual(row.quantity, 99, '数量が書き換わっていないこと');
});

test('無い無償出荷の区分は直せない', async () => {
  const { status } = await api('PATCH', '/api/shipments/samples/99999', { purpose: '再発送' });
  assert.equal(status, 404);
});

// --- CSV --------------------------------------------------------------------

test('酒税CSVに区分の列と「うち無償」の行が出る', async () => {
  const { status, body } = await api('GET', `/api/exports/liquor-tax?month=${MONTH}`);
  assert.equal(status, 200);

  const lines = body.trim().split('\r\n');
  assert.equal(
    lines[0].replace('﻿', ''),
    '区分,商品名称,酒類区分,度数,容量(ml),本数,数量計(L),円/kl,酒税額(円),備考'
  );
  assert.ok(lines.some((l) => l.startsWith('有償,')), '有償の行が出ること');
  assert.ok(lines.some((l) => l.startsWith('再発送,')), '無償の区分の行が出ること');

  const rep = await report();
  const free = lines.find((l) => l.startsWith(',うち無償,'));
  assert.ok(free, 'うち無償の行が出ること');
  assert.ok(
    free.includes(String(rep.freeTotals.taxAmount)),
    'うち無償の税額が酒税タブと一致すること'
  );
});

// --- 移行 -------------------------------------------------------------------

// 既存のサンプル送付49件（実データ）は、すべてサンプル配布として入っている。
// 0031 はその意味をそのまま写すだけで、1件も落とさない。
test('0031: 0030 まで当てたDBの既存行は「サンプル」になる', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const Database = require('better-sqlite3');

  const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-purpose-')), 'test.sqlite');
  const mdb = new Database(file);
  mdb.pragma('foreign_keys = ON');

  const until0030 = (f) => f <= '0030_ship_doc_uploads.sql';
  for (const f of files.filter(until0030)) {
    mdb.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  mdb.prepare("INSERT INTO customers (uid, name) VALUES ('cust0001', '送付先')").run();
  mdb.prepare("INSERT INTO products (uid, name, volume_ml) VALUES ('prod0001', '浄酎', 300)").run();

  // 区分の列はまだ無い（この時点で purpose を書けないことが、移行の前提）
  assert.equal(
    mdb.prepare('PRAGMA table_info(sample_shipments)').all().some((c) => c.name === 'purpose'),
    false,
    '0030 の時点では区分の列が無いこと'
  );

  // 実データと同じく、商品の無い行（販促資料だけの送付）も混ぜる
  mdb.prepare(
    `INSERT INTO sample_shipments (sample_no, shipped_on, customer_id, product_id, quantity)
     VALUES ('S2603-0001', '2026-03-10', 1, 1, 2)`
  ).run();
  mdb.prepare(
    `INSERT INTO sample_shipments (sample_no, shipped_on, customer_id)
     VALUES ('S2603-0002', '2026-03-11', 1)`
  ).run();

  for (const f of files.filter((x) => !until0030(x))) {
    try {
      mdb.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      throw new Error(`${f} で失敗: ${err.message}`);
    }
  }

  const rows = mdb.prepare('SELECT sample_no, purpose FROM sample_shipments ORDER BY id').all();
  assert.equal(rows.length, 2, '1件も落ちていないこと');
  assert.deepEqual(rows.map((r) => r.purpose), ['サンプル', 'サンプル']);

  mdb.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
