// 1つの受注番号に別のお客様が混ざったものを分ける修正スクリプトの試験。
//
// 実データの形をそのまま写す（O2606-0017）:
//   1行目 ナオライEC   41 710ml ×1   在庫台帳の出荷がこの行の id を指している
//   2行目 カナカン     35 300ml ×12
// 6月の最大番号は O2606-0041 なので、2行目は O2606-0042 から振られる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { planSplit, applySplit } = require('../../scripts/split-mixed-customer-orders');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'db', 'migrations');

function freshDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db', 'test.sqlite');
  fs.mkdirSync(path.dirname(file));

  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }

  db.prepare("INSERT INTO customers (id, uid, name) VALUES (57, 'cust0057', 'ナオライEC')").run();
  db.prepare("INSERT INTO customers (id, uid, name) VALUES (8, 'cust0008', 'カナカン酒類石川')").run();
  db.prepare("INSERT INTO products (id, uid, name, volume_ml) VALUES (1, 'prod0001', '35 300ml', 300)").run();
  db.prepare("INSERT INTO products (id, uid, name, volume_ml) VALUES (4, 'prod0004', '41 710ml', 710)").run();

  const order = db.prepare(
    `INSERT INTO orders (order_no, line_no, ordered_on, customer_id, product_id, quantity, total_amount, legacy_order_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const keepId = order.run('O2606-0017', 1, '2026-06-05', 57, 4, 1, 9935, 'D2606-0017').lastInsertRowid;
  order.run('O2606-0017', 2, '2026-06-08', 8, 1, 12, 30492, 'D2606-0017');
  order.run('O2606-0041', 1, '2026-06-30', 57, 1, 1, 2695, null);
  db.prepare(
    `INSERT INTO product_stock_ledger (txn_date, product_id, txn_type, quantity, order_id)
     VALUES ('2026-06-10', 4, '出荷', -1, ?)`
  ).run(keepId);

  return { db, file, keepId };
}

const rows = (db) =>
  db.prepare('SELECT id, order_no, line_no, customer_id, legacy_order_no FROM orders ORDER BY id').all();

test('2行目に新しい番号を振り、1行目と在庫台帳のつながりはそのまま', (t) => {
  const { db, keepId } = freshDb(t);

  const plan = planSplit(db);
  assert.equal(plan.problems.length, 0);
  assert.deepEqual(plan.moves.map((m) => [m.orderNo, m.newOrderNo]), [['O2606-0017', 'O2606-0042']]);

  applySplit(db, plan);

  const after = rows(db);
  assert.deepEqual(after.find((r) => r.id === Number(keepId)), {
    id: Number(keepId), order_no: 'O2606-0017', line_no: 1, customer_id: 57, legacy_order_no: 'D2606-0017',
  });
  assert.deepEqual(after.find((r) => r.customer_id === 8), {
    id: Number(keepId) + 1, order_no: 'O2606-0042', line_no: 1, customer_id: 8, legacy_order_no: 'D2606-0017',
  });
  assert.equal(db.prepare('SELECT order_id FROM product_stock_ledger').get().order_id, Number(keepId));
  assert.equal(planSplit(db).moves.length, 0);
});

test('同じ月に複数あれば、番号を1つずつ進める', (t) => {
  const { db } = freshDb(t);
  const order = db.prepare(
    `INSERT INTO orders (order_no, line_no, ordered_on, customer_id, product_id, quantity) VALUES (?, ?, ?, ?, 1, 1)`
  );
  order.run('O2606-0027', 1, '2026-06-12', 57);
  order.run('O2606-0027', 2, '2026-06-17', 8);

  const plan = planSplit(db);
  assert.deepEqual(plan.moves.map((m) => m.newOrderNo), ['O2606-0042', 'O2606-0043']);
  applySplit(db, plan);
  assert.equal(planSplit(db).moves.length, 0);
});

test('3行ある受注番号は分けずに止まる', (t) => {
  const { db } = freshDb(t);
  db.prepare(
    `INSERT INTO orders (order_no, line_no, ordered_on, customer_id, product_id, quantity)
     VALUES ('O2606-0017', 3, '2026-06-09', 8, 1, 1)`
  ).run();

  const before = rows(db);
  const plan = planSplit(db);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.problems.length, 1);
  assert.throws(() => applySplit(db, plan), /書き換えません/);
  assert.deepEqual(rows(db), before);
});

test('何も付けずに流すと dry-run で、DBは変わらない', (t) => {
  const { db, file } = freshDb(t);
  const before = rows(db);
  db.close();

  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'split-mixed-customer-orders.js')], {
    cwd: ROOT, env: { ...process.env, DB_PATH: file }, encoding: 'utf8',
  });
  assert.match(out, /2行目 → O2606-0042/);
  assert.match(out, /dry-run なので何も書き換えていません/);

  const again = new Database(file, { readonly: true });
  t.after(() => again.close());
  assert.deepEqual(rows(again), before);
});

test('--apply ではバックアップを取ってから書き換える', (t) => {
  const { db, file } = freshDb(t);
  db.close();

  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'split-mixed-customer-orders.js'), '--apply'], {
    cwd: ROOT, env: { ...process.env, DB_PATH: file }, encoding: 'utf8',
  });
  assert.match(out, /1件の2行目に新しい受注番号を振りました/);

  const backups = fs.readdirSync(path.join(path.dirname(file), '..', 'backups'));
  assert.equal(backups.filter((f) => f.startsWith('before-split-orders-')).length, 1);

  const again = new Database(file, { readonly: true });
  t.after(() => again.close());
  assert.equal(rows(again).find((r) => r.customer_id === 8).order_no, 'O2606-0042');
});
