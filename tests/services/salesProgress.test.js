// ダッシュボードの売上実績が、どの日付で数えられているか分かること。
//
// これまで画面には「実績 ¥365,790（11件）」としか出ておらず、
// 納品日ベースであることも、納品日が空の受注が入らないことも書いていなかった
// （実データでは受注117件のうち11件が納品日を持たず、実績に出てこない）。
//
// 内訳の明細と、上に出る実績は**同じ配列から**出す。別々に集計すると、
// 開いた内訳の合計と画面の合計が食い違いうる。

// 日本時間で動かす。UTCで前月を出していたバグを確定的に確かめるため。
process.env.TZ = 'Asia/Tokyo';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');
const { currentMonth } = require('../../src/utils/dateUtil');

const harness = createHarness('test-sales-progress.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    for (const [code, name] of [['P001', '浄酎 300ml'], ['P002', '浄酎 700ml']]) {
      db.prepare(
        `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                               initial_product_stock, initial_wip_stock)
         VALUES (?, ?, ?, 300, 35, '本', 3000, 0, 0)`
      ).run(generateUid(db, 'products'), code, name);
    }
    for (const [code, name] of [['C001', '細江酒店'], ['C002', 'カナカン酒類石川']]) {
      db.prepare('INSERT INTO customers (uid, code, name) VALUES (?, ?, ?)')
        .run(generateUid(db, 'customers'), code, name);
    }

    const order = db.prepare(
      `INSERT INTO orders (order_no, line_no, ordered_on, customer_id, product_id, quantity,
                           sales_amount, total_amount, status, delivered_on, invoiced_on,
                           paid_on, payment_due_on, sales_method)
       VALUES (@no, 1, @ordered, @customer, 1, 1, @amount, @amount, '発送済',
               @delivered, @invoiced, @paid, @due, @method)`
    );

    // A: 6月納品・請求済・入金済
    order.run({ no: 'O2606-0001', ordered: '2026-05-20', customer: 1, amount: 10000,
      delivered: '2026-06-10', invoiced: '2026-06-30', paid: '2026-07-31',
      due: '2026-07-31', method: '買取' });
    // B: 6月納品・請求済だが未入金
    order.run({ no: 'O2606-0002', ordered: '2026-06-01', customer: 1, amount: 20000,
      delivered: '2026-06-15', invoiced: '2026-06-30', paid: null,
      due: '2026-07-31', method: '買取' });
    // C: 納品日が無い（納品日ベースではどの月にも入らない）・未請求
    order.run({ no: 'O2606-0003', ordered: '2026-06-05', customer: 2, amount: 30000,
      delivered: null, invoiced: null, paid: null, due: null, method: '買取' });
    // D: 6月受注・7月納品
    order.run({ no: 'O2606-0004', ordered: '2026-06-28', customer: 2, amount: 40000,
      delivered: '2026-07-01', invoiced: null, paid: null, due: null, method: '買取' });
    // E: 委託の受注。買取からは除く
    order.run({ no: 'O2606-0005', ordered: '2026-06-02', customer: 1, amount: 50000,
      delivered: '2026-06-20', invoiced: null, paid: null, due: null, method: '委託' });

    const report = db.prepare(
      `INSERT INTO consignment_reports (report_no, report_month, customer_id, product_id,
                                        quantity, sales_amount, invoiced_on, paid_on)
       VALUES (@no, @month, @customer, 1, 1, @amount, @invoiced, @paid)`
    );
    report.run({ no: 'C2606-0001', month: '2026-06', customer: 1, amount: 5000,
      invoiced: '2026-06-30', paid: '2026-07-31' });
    report.run({ no: 'C2606-0002', month: '2026-06', customer: 2, amount: 7000,
      invoiced: '2026-06-30', paid: null });
    report.run({ no: 'C2607-0001', month: '2026-07', customer: 1, amount: 9000,
      invoiced: null, paid: null });

    db.prepare(
      "INSERT INTO sales_targets (target_month, target_amount) VALUES ('2026-06', 100000)"
    ).run();
  }));
});

test.after(async () => {
  await harness.teardown();
});

const progress = async (query) => (await api('GET', `/api/sales-targets/progress?${query}`)).body;

test('既定は納品日ベースで、それが戻り値に書いてある', async () => {
  const p = await progress('month=2026-06');

  assert.equal(p.basis, 'delivered');
  assert.equal(p.basisLabel, '納品日');
  // A 10000 + B 20000（委託のEは除く、納品日の無いCは入らない）
  assert.equal(p.breakdown.purchase.amount, 30000);
  assert.equal(p.breakdown.purchase.count, 2);
  // 委託は報告月 2026-06 の2件
  assert.equal(p.breakdown.consignment.amount, 12000);
  assert.equal(p.actualAmount, 42000);
  assert.equal(p.progressRate, 42);
});

test('内訳の明細の合計が、上に出る実績と1円まで一致する', async () => {
  for (const basis of ['delivered', 'ordered', 'payment_due']) {
    const p = await progress(`month=2026-06&basis=${basis}`);
    const sum = [...p.breakdown.purchase.rows, ...p.breakdown.consignment.rows]
      .reduce((total, r) => total + r.sales_amount, 0);

    assert.equal(sum, p.actualAmount, `${basis} で内訳の合計と実績が食い違っています`);
    assert.equal(p.breakdown.purchase.rows.length, p.breakdown.purchase.count);
    assert.equal(p.breakdown.consignment.rows.length, p.breakdown.consignment.count);
  }
});

test('受注日ベースにすると、納品日が無い受注も数えられる', async () => {
  const p = await progress('month=2026-06&basis=ordered');

  assert.equal(p.basisLabel, '受注日');
  const codes = p.breakdown.purchase.rows.map((r) => r.order_no);
  // B(6/1) C(6/5) D(6/28)。A は 5/20 受注なので入らない。E は委託なので入らない
  assert.deepEqual(codes, ['O2606-0002', 'O2606-0003', 'O2606-0004']);
  assert.equal(p.breakdown.purchase.amount, 90000);
  assert.ok(codes.includes('O2606-0003'), '納品日が空の受注が数えられていません');
});

test('入金予定日ベースにできる', async () => {
  const p = await progress('month=2026-07&basis=payment_due');

  assert.equal(p.basisLabel, '入金予定日');
  assert.equal(p.breakdown.purchase.amount, 30000); // A と B の入金予定は 7/31
  assert.equal(p.breakdown.purchase.count, 2);
});

test('基準を変えても、委託は報告月のまま数える', async () => {
  const delivered = await progress('month=2026-06&basis=delivered');
  const ordered = await progress('month=2026-06&basis=ordered');
  const due = await progress('month=2026-06&basis=payment_due');

  for (const p of [delivered, ordered, due]) {
    assert.equal(p.breakdown.consignment.amount, 12000);
    assert.equal(p.breakdown.consignment.count, 2);
  }
  // 買取のほうは基準で変わる
  assert.notEqual(delivered.breakdown.purchase.amount, ordered.breakdown.purchase.amount);
});

test('知らない基準が来ても落ちず、納品日ベースで返す', async () => {
  const bad = await api('GET', '/api/sales-targets/progress?month=2026-06&basis=' +
    encodeURIComponent("ordered_on; DROP TABLE orders"));

  assert.equal(bad.status, 200);
  assert.equal(bad.body.basis, 'delivered');
  assert.equal(bad.body.breakdown.purchase.amount, 30000);
  // 表が消えていないこと
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 5);
});

test('請求日・入金日から、回収の状態が出る', async () => {
  const p = await progress('month=2026-06&basis=ordered');
  const byNo = Object.fromEntries(p.breakdown.purchase.rows.map((r) => [r.order_no, r]));

  assert.equal(byNo['O2606-0002'].payment_status, '未入金'); // 請求済・未入金
  assert.equal(byNo['O2606-0003'].payment_status, '未請求');
  assert.equal(byNo['O2606-0002'].invoiced_on, '2026-06-30');
  assert.equal(byNo['O2606-0002'].paid_on, null);

  const delivered = await progress('month=2026-06');
  const a = delivered.breakdown.purchase.rows.find((r) => r.order_no === 'O2606-0001');
  assert.equal(a.payment_status, '入金済');
  assert.equal(a.paid_on, '2026-07-31');

  // 委託にも同じ状態が付く
  const c = delivered.breakdown.consignment.rows;
  assert.equal(c.find((r) => r.report_no === 'C2606-0001').payment_status, '入金済');
  assert.equal(c.find((r) => r.report_no === 'C2606-0002').payment_status, '未入金');
});

test('明細に、画面に出す列がそろっている', async () => {
  const p = await progress('month=2026-06');
  const row = p.breakdown.purchase.rows[0];

  for (const key of ['order_no', 'ordered_on', 'delivered_on', 'customer_name',
                     'product_name', 'quantity', 'sales_amount', 'invoiced_on',
                     'paid_on', 'payment_status']) {
    assert.ok(key in row, `明細に ${key} がありません`);
  }
  assert.equal(row.customer_name, '細江酒店');
});

test('月を指定しないときは、日本時間の当月を出す（UTCで前月にしない）', (t) => {
  // 2026-09-30 17:00 UTC = 2026-10-01 02:00 JST。
  // toISOString() を使うと 2026-09 になり、月初の朝に前月の目標が出ていた。
  //
  // ここはHTTPを通さない。時刻を偽装するとログインのセッション（14日で切れる）も
  // 期限切れになり、401で本題が確かめられなくなるため。
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30, 17, 0, 0) });

  assert.equal(new Date().toISOString().slice(0, 7), '2026-09', 'UTCでは前月');
  assert.equal(currentMonth(), '2026-10', '日本時間では当月');
});

test('月を指定しない要求は、currentMonth() の月を返す', async () => {
  const p = await progress('');
  assert.equal(p.targetMonth, currentMonth());
});

test('対象月の形式が違えば422', async () => {
  const { status } = await api('GET', '/api/sales-targets/progress?month=2026-6');
  assert.equal(status, 422);
});
