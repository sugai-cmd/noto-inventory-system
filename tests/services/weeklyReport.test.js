// 週次報告の集計（scripts/export-weekly-report.js がスプレッドシートへ送る中身）。
//
// 数字を1つずつ手で出した答えと突き合わせる。集計の条件（取消・委託・前日まで・税）を
// 外すと落ちるように、境目の行をわざと入れてある。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-weekly-report.sqlite');

let buildReport;
let previousWeek;
let taxIncluded;

test.before(async () => {
  await harness.setup((db, generateUid) => {
    const cust = db.prepare('INSERT INTO customers (uid, code, name) VALUES (?, ?, ?)');
    cust.run(generateUid(db, 'customers'), 'C-001', '得意先A');
    cust.run(generateUid(db, 'customers'), 'C-002', '得意先B');
    db.prepare('INSERT INTO products (uid, code, name, volume_ml) VALUES (?, ?, ?, ?)').run(
      generateUid(db, 'products'), 'P-001', '能登浄酎 700ml', 700
    );

    const order = db.prepare(
      `INSERT INTO orders (order_no, line_no, ordered_on, customer_id, product_id, quantity,
                           sales_amount, shipping_fee, payment_due_on, paid_on, sales_method, is_cancelled)
       VALUES (@no, @line, @on, @cust, 1, @qty, @sales, @ship, @due, @paid, @method, @cancelled)`
    );
    const base = { line: 1, ship: 0, due: null, paid: null, method: null, cancelled: 0 };
    // 当月・2明細（1行は入金済）
    order.run({ ...base, no: 'O2610-0001', on: '2026-10-01', cust: 1, qty: 2, sales: 10000, ship: 1000, due: '2026-10-31' });
    order.run({ ...base, no: 'O2610-0001', line: 2, on: '2026-10-01', cust: 1, qty: 1, sales: 5000, due: '2026-10-31', paid: '2026-10-03' });
    // 集計日当日の受注は数えない（朝に集計するので前日まで）
    order.run({ ...base, no: 'O2610-0002', on: '2026-10-05', cust: 1, qty: 9, sales: 99999 });
    // 前月の受注で、入金予定が当月
    order.run({ ...base, no: 'O2609-0003', on: '2026-09-29', cust: 2, qty: 3, sales: 20000, due: '2026-10-20' });
    // 取り消した受注は数えない
    order.run({ ...base, no: 'O2610-0004', on: '2026-10-02', cust: 1, qty: 5, sales: 50000, due: '2026-10-31', cancelled: 1 });
    // 前月の受注で、入金予定を過ぎて未入金
    order.run({ ...base, no: 'O2609-0005', on: '2026-09-10', cust: 2, qty: 1, sales: 7000, due: '2026-09-30' });

    // 委託は報告月で売上に入る
    db.prepare(
      `INSERT INTO consignment_reports (report_no, report_month, customer_id, product_id, quantity,
                                        sales_amount, shipping_fee, payment_due_on)
       VALUES ('C2610-0001', '2026-10', 2, 1, 4, 8000, 0, '2026-11-30')`
    ).run();

    db.prepare("INSERT INTO sales_targets (target_month, target_amount) VALUES ('2026-10', 100000)").run();

    const mat = db.prepare(
      'INSERT INTO materials (uid, code, name, unit, proper_stock_qty, initial_stock) VALUES (?, ?, ?, ?, ?, ?)'
    );
    mat.run(generateUid(db, 'materials'), 'M-001', 'コルク', '個', 100, 30); // 適正を下回る
    mat.run(generateUid(db, 'materials'), 'M-002', '紙箱', '枚', 100, 500); // 足りている
    mat.run(generateUid(db, 'materials'), 'M-003', 'ラベル', '枚', null, 0); // 適正未設定は判定しない
  });

  ({ buildReport, previousWeek, taxIncluded } = require('../../src/services/weeklyReportService'));
});

test.after(() => harness.teardown());

test('前週は月曜〜日曜。日曜に集計しても、その週ではなく前の週を見る', () => {
  assert.deepEqual(previousWeek('2026-10-05'), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(previousWeek('2026-10-04'), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(previousWeek('2026-10-06'), { from: '2026-09-28', to: '2026-10-04' });
});

test('税込は売価にだけ消費税を掛け、送料はそのまま足す', () => {
  assert.equal(taxIncluded(10000, 1000), 12000);
  assert.equal(taxIncluded(0, 0), 0);
});

test('当月の売上（受注日ベース）は前日までの累計で、取消を除き委託を足す', () => {
  const r = buildReport({ asOf: '2026-10-05' });
  assert.equal(r.throughDate, '2026-10-04');
  assert.equal(r.month, '2026-10');
  assert.equal(r.current.ordered.purchaseSales, 15000);
  assert.equal(r.current.ordered.consignmentSales, 8000);
  assert.equal(r.current.ordered.salesExclTax, 23000);
  assert.equal(r.current.ordered.orders, 1);
  assert.equal(r.current.ordered.quantity, 7);
  assert.equal(r.current.ordered.targetAmount, 100000);
  assert.equal(r.current.ordered.progressRate, 23);
});

test('当月の入金予定（入金予定日ベース）を入金済と未入金に分ける', () => {
  const { paymentDue, received } = buildReport({ asOf: '2026-10-05' }).current;
  assert.equal(paymentDue.dueAmount, 39500); // (10000+5000+20000)×1.1 + 送料1000
  assert.equal(paymentDue.paidAmount, 5500);
  assert.equal(paymentDue.unpaidAmount, 34000);
  assert.equal(paymentDue.unpaidLines, 2);
  assert.equal(received.amount, 5500); // 10/3 に入金された1明細
});

test('前週と前月（受注日ベース）。前週の月曜が前月なら前月の締めを報告する', () => {
  const r = buildReport({ asOf: '2026-10-05' });
  assert.equal(r.week.ordered.sales, 35000);
  assert.equal(r.week.ordered.orders, 2);
  assert.equal(r.previousMonth.ordered.month, '2026-09');
  assert.equal(r.previousMonth.ordered.salesExclTax, 27000);
  assert.equal(r.reportPreviousMonth, true);
  assert.equal(buildReport({ asOf: '2026-10-12' }).reportPreviousMonth, false);
});

test('入金遅れは伝票番号ごとにまとめる', () => {
  const { overdue } = buildReport({ asOf: '2026-10-05' });
  assert.equal(overdue.count, 1);
  assert.equal(overdue.items[0].no, 'O2609-0005');
  assert.equal(overdue.amount, 7700);
});

test('得意先別は当月分だけ。委託は報告月で入る', () => {
  const { byCustomer, byProduct } = buildReport({ asOf: '2026-10-05' }).breakdown;
  assert.deepEqual(byCustomer, [
    { name: '得意先A', quantity: 3, salesExclTax: 15000 },
    { name: '得意先B', quantity: 4, salesExclTax: 8000 },
  ]);
  assert.equal(byProduct[0].salesExclTax, 23000);
});

test('要発注資材は適正在庫数を下回ったものだけ（未設定は出さない）', () => {
  const { materialsToOrder } = buildReport({ asOf: '2026-10-05' }).stock;
  assert.deepEqual(materialsToOrder.map((m) => m.name), ['コルク']);
});

test('集計日の形式が違えば止める', () => {
  assert.throws(() => buildReport({ asOf: '2026/10/05' }), /YYYY-MM-DD/);
});

test('送り先がエラーを返したら、送信は失敗として扱う', async () => {
  const { send } = require('../../scripts/export-weekly-report');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { secret } = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(secret === 'ok' ? { ok: true, message: '書き込みました' } : { ok: false, error: '合言葉が一致しません' }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    assert.equal((await send({ asOf: 'x' }, { url, secret: 'ok' })).ok, true);
    await assert.rejects(send({ asOf: 'x' }, { url, secret: 'ng' }), /合言葉が一致しません/);
  } finally {
    server.close();
  }
});
