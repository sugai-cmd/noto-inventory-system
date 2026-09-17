// 一覧の件数選択・ページ送り・項目別の絞り込み（PR C-1）。
//
// **使い勝手の前に、見えていない行があるのを直すのが本題。**
// 実データで2つ見つかった:
//   資材の入出庫履歴 … 205件あるのに既定200で切れ、5件が画面に出ていなかった
//                      （サービスの既定値・APIの既定値・画面がlimitを送っていないこと、
//                        の3つが重なっていた。瓶詰めタブで起きたのと同じ形）
//   操作ログ         … 画面が ?limit=100 を決め打ちで送っており、古いログは
//                      一切見られなかった。ログは消さずに増え続けるので、
//                      いちばん遡れないと困る一覧がここだった
//
// どちらも一覧の取得に試験が無く、それが見逃した理由なので、ここで押さえる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-list-paging.sqlite');
const api = harness.api;

let db;

const MATERIAL_A = 1; // 300mlガラス瓶
const MATERIAL_B = 2; // コルクキャップ

/** 実データと同じ規模（205件）を作る。200件の壁を越えることを確かめたい */
const LEDGER_ROWS = 205;

// C-2 で足した一覧の分
const CUSTOMER_A = 1;
const CUSTOMER_B = 2;
const PRODUCT_A = 1;
const PRODUCT_B = 2;
const ORDER_ROWS = 120;   // 実データ117件より少し多く
const SP1 = 1;            // 原酒ポリ1
const SP2 = 2;            // 原酒ポリ2
const RAW_ROWS = 160;     // 実データ158件より少し多く

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const ins = db.prepare(
      `INSERT INTO materials (uid, code, name, unit, unit_price, lot_size)
       VALUES (?, ?, ?, '本', 281, 1)`
    );
    ins.run(generateUid(db, 'materials'), 'MT-001', '300mlガラス瓶');
    ins.run(generateUid(db, 'materials'), 'MT-002', 'コルクキャップ');

    const led = db.prepare(
      `INSERT INTO material_stock_ledger
         (history_code, txn_date, material_id, txn_type, quantity, counterparty, is_cancelled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    // 日付は2026-01-01から1日ずつ。並べ替えの確認に使う
    for (let i = 0; i < LEDGER_ROWS; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      led.run(
        `M-${String(i + 1).padStart(4, '0')}`,
        day,
        i % 2 === 0 ? MATERIAL_A : MATERIAL_B,
        i % 5 === 0 ? '入荷' : '消費',
        i + 1,
        i % 3 === 0 ? '酒井硝子' : 'ナオライ神石高原',
        i % 50 === 0 ? 1 : 0
      );
    }

    // --- 受注（C-2） ---
    const cus = db.prepare(
      `INSERT INTO customers (uid, code, name, markup_rate) VALUES (?, ?, ?, 0.7)`
    );
    cus.run(generateUid(db, 'customers'), 'C-001', 'カナカン');
    cus.run(generateUid(db, 'customers'), 'C-002', '酒のかわしま');

    const prd = db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, list_price) VALUES (?, ?, ?, 300, 3000)`
    );
    prd.run(generateUid(db, 'products'), 'P-001', '浄酎 山田錦');
    prd.run(generateUid(db, 'products'), 'P-002', '浄酎 池月');

    const ord = db.prepare(
      `INSERT INTO orders
         (order_no, line_no, ordered_on, customer_id, product_id, quantity,
          unit_price, total_amount, status, delivered_on, payment_due_on)
       VALUES (?, 1, ?, ?, ?, ?, 3000, ?, ?, ?, ?)`
    );
    for (let i = 0; i < ORDER_ROWS; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const delivered = new Date(Date.UTC(2026, 0, 8 + i)).toISOString().slice(0, 10);
      const due = new Date(Date.UTC(2026, 1, 1 + i)).toISOString().slice(0, 10);
      ord.run(
        `O-${String(i + 1).padStart(4, '0')}`,
        day,
        i % 2 === 0 ? CUSTOMER_A : CUSTOMER_B,
        i % 3 === 0 ? PRODUCT_A : PRODUCT_B,
        i + 1,
        (i + 1) * 3000,
        i % 4 === 0 ? '発送済' : '未着手',
        delivered,
        due
      );
    }

    // --- 原料受払記録（C-2） ---
    const tnk = db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, ?, ?, '原酒ポリタンク', 200, 0)`
    );
    tnk.run(generateUid(db, 'tanks'), 'SP-001', '原酒ポリ1');
    tnk.run(generateUid(db, 'tanks'), 'SP-002', '原酒ポリ2');

    const raw = db.prepare(
      `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, quantity, to_tank_id, is_cancelled)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < RAW_ROWS; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      raw.run(
        `R-${String(i + 1).padStart(4, '0')}`,
        day,
        i % 4 === 0 ? '棚卸調整' : '受入',
        i + 1,
        i % 2 === 0 ? SP1 : SP2,
        i % 40 === 0 ? 1 : 0
      );
    }
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 資材の入出庫履歴 ---

test('205件すべて見られる。既定の200件で切れない', async () => {
  const first = await api('GET', '/api/materials/ledger?limit=200&offset=0');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, LEDGER_ROWS, '総件数が返ること');
  assert.equal(first.body.rows.length, 200);

  // ここが以前は見られなかった5件
  const rest = await api('GET', '/api/materials/ledger?limit=50&offset=200');
  assert.equal(rest.body.total, LEDGER_ROWS);
  assert.equal(rest.body.rows.length, 5, '201〜205件目が取れること');

  // 1件も重なっていない・抜けていないこと
  const ids = new Set([...first.body.rows, ...rest.body.rows].map((r) => r.id));
  assert.equal(ids.size, LEDGER_ROWS, '重複も抜けもないこと');
});

test('ページを送っても、同じ行が2度出たり抜けたりしない', async () => {
  const seen = [];
  for (let offset = 0; offset < LEDGER_ROWS; offset += 50) {
    const res = await api('GET', `/api/materials/ledger?limit=50&offset=${offset}`);
    seen.push(...res.body.rows.map((r) => r.id));
  }
  assert.equal(seen.length, LEDGER_ROWS);
  assert.equal(new Set(seen).size, LEDGER_ROWS);
});

test('絞り込むと total もその条件の件数になる', async () => {
  const res = await api('GET', '/api/materials/ledger?txnType=入荷&limit=10');
  assert.equal(res.status, 200);
  const expected = db
    .prepare("SELECT COUNT(*) n FROM material_stock_ledger WHERE txn_type = '入荷'")
    .get().n;
  assert.equal(res.body.total, expected, '全件数ではなく、絞ったあとの件数であること');
  assert.ok(res.body.rows.every((r) => r.txn_type === '入荷'));
  assert.equal(res.body.rows.length, 10, 'limitは効いたままであること');
});

test('資材・相手先・日付・取消済みで絞れる', async () => {
  const byMaterial = await api('GET', `/api/materials/ledger?materialId=${MATERIAL_B}`);
  assert.ok(byMaterial.body.rows.every((r) => r.material_id === MATERIAL_B));
  assert.equal(
    byMaterial.body.total,
    db.prepare('SELECT COUNT(*) n FROM material_stock_ledger WHERE material_id = ?').get(MATERIAL_B).n
  );

  // 相手先は一部でも当たる
  const byCounterparty = await api('GET', '/api/materials/ledger?counterparty=酒井');
  assert.ok(byCounterparty.body.total > 0);
  assert.ok(byCounterparty.body.rows.every((r) => r.counterparty.includes('酒井')));

  const byDate = await api('GET', '/api/materials/ledger?from=2026-03-01&to=2026-03-31');
  assert.ok(byDate.body.rows.every((r) => r.txn_date >= '2026-03-01' && r.txn_date <= '2026-03-31'));
  assert.equal(
    byDate.body.total,
    db.prepare("SELECT COUNT(*) n FROM material_stock_ledger WHERE txn_date BETWEEN '2026-03-01' AND '2026-03-31'").get().n
  );

  const alive = await api('GET', '/api/materials/ledger?cancelled=false');
  assert.ok(alive.body.rows.every((r) => !r.is_cancelled));
  const cancelled = await api('GET', '/api/materials/ledger?cancelled=true');
  assert.ok(cancelled.body.total > 0, '取消済みの行があること');
  assert.ok(cancelled.body.rows.every((r) => r.is_cancelled));
  assert.equal(alive.body.total + cancelled.body.total, LEDGER_ROWS);
});

test('絞り込みを重ねられる', async () => {
  const res = await api(
    'GET',
    `/api/materials/ledger?materialId=${MATERIAL_A}&txnType=入荷&cancelled=false`
  );
  assert.ok(res.body.rows.every(
    (r) => r.material_id === MATERIAL_A && r.txn_type === '入荷' && !r.is_cancelled
  ));
  assert.equal(
    res.body.total,
    db.prepare(
      `SELECT COUNT(*) n FROM material_stock_ledger
        WHERE material_id = ? AND txn_type = '入荷' AND is_cancelled = 0`
    ).get(MATERIAL_A).n
  );
});

test('見出しで並べ替えられる。昇順・降順が効く', async () => {
  const asc = await api('GET', '/api/materials/ledger?sort=txn_date&order=asc&limit=5');
  const dates = asc.body.rows.map((r) => r.txn_date);
  assert.deepEqual(dates, [...dates].sort(), '古い順であること');
  assert.equal(dates[0], '2026-01-01');

  const desc = await api('GET', '/api/materials/ledger?sort=txn_date&order=desc&limit=5');
  assert.equal(desc.body.rows[0].txn_date, '2026-07-24', '新しい順であること（205日目）');

  const byQty = await api('GET', '/api/materials/ledger?sort=quantity&order=asc&limit=3');
  assert.deepEqual(byQty.body.rows.map((r) => r.quantity), [1, 2, 3]);
});

// **ここが要**。画面から来た文字列をそのままORDER BYに入れていないこと
test('許可していない並べ替えを送っても、壊れずに既定の順で返る', async () => {
  const attempts = [
    'quantity; DROP TABLE materials',
    "(SELECT 1)",
    'l.id',            // 実在する列でも、許可リストに無ければ通さない
    'material_id',
    '',
  ];
  const expected = (await api('GET', '/api/materials/ledger?limit=5')).body.rows.map((r) => r.id);

  for (const sort of attempts) {
    const res = await api('GET', `/api/materials/ledger?sort=${encodeURIComponent(sort)}&limit=5`);
    assert.equal(res.status, 200, `"${sort}" で落ちないこと`);
    assert.deepEqual(res.body.rows.map((r) => r.id), expected, `"${sort}" は既定の順に落ちること`);
  }

  // 表が消えていないこと（SQLが実行されていない裏取り）
  assert.ok(db.prepare('SELECT COUNT(*) n FROM materials').get().n > 0);
});

test('order に変な値を送っても降順に落ちる', async () => {
  const res = await api('GET', '/api/materials/ledger?sort=txn_date&order=ASC);DROP&limit=3');
  assert.equal(res.status, 200);
  const dates = res.body.rows.map((r) => r.txn_date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('offset に負の数を送っても先頭から返る', async () => {
  const res = await api('GET', '/api/materials/ledger?offset=-10&limit=3');
  assert.equal(res.status, 200);
  const head = await api('GET', '/api/materials/ledger?offset=0&limit=3');
  assert.deepEqual(res.body.rows.map((r) => r.id), head.body.rows.map((r) => r.id));
});

test('取り消したあとも、開いていたページの位置で読み直せる', async () => {
  const page = await api('GET', '/api/materials/ledger?limit=10&offset=50&cancelled=false');
  const target = page.body.rows[0];

  const res = await api('POST', `/api/materials/ledger/${target.id}/cancel`, { reason: '入れ間違い' });
  assert.equal(res.status, 200);

  // 同じ条件で読み直すと、取消済みが1件減って詰まる（画面はoffsetを保つ）
  const after = await api('GET', '/api/materials/ledger?limit=10&offset=50&cancelled=false');
  assert.equal(after.status, 200);
  assert.equal(after.body.total, page.body.total - 1, '有効な件数が1件減ること');
  assert.ok(!after.body.rows.some((r) => r.id === target.id), '取り消した行が出てこないこと');
});

// --- 操作ログ ---

test('操作ログが100件を超えて遡れる', async () => {
  // 取消を1件やったので、そのぶんのログはある。数を揃えるため直に足す
  const ins = db.prepare(
    `INSERT INTO operation_logs (occurred_at, user_id, action, target_type, target_id, summary)
     VALUES (?, NULL, ?, 'material_stock_ledger', ?, ?)`
  );
  for (let i = 0; i < 150; i += 1) {
    const at = `2026-02-${String((i % 28) + 1).padStart(2, '0')} 09:00:00`;
    ins.run(at, i % 2 === 0 ? 'material.receipt' : 'material.ledger.cancel', i, `テスト${i}`);
  }

  const total = db.prepare('SELECT COUNT(*) n FROM operation_logs').get().n;
  assert.ok(total > 100, '100件を超えていること');

  const first = await api('GET', '/api/auth/operation-logs?limit=100&offset=0');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, total);
  assert.equal(first.body.rows.length, 100);

  // 以前はここから先が一切見られなかった
  const second = await api('GET', `/api/auth/operation-logs?limit=100&offset=100`);
  assert.ok(second.body.rows.length > 0, '101件目以降が取れること');

  const ids = new Set([...first.body.rows, ...second.body.rows].map((r) => r.id));
  assert.equal(ids.size, first.body.rows.length + second.body.rows.length, '重複しないこと');
});

test('操作ログを操作の種類・日付で絞れる', async () => {
  const byAction = await api('GET', '/api/auth/operation-logs?action=material.ledger.cancel');
  assert.ok(byAction.body.total > 0);
  assert.ok(byAction.body.rows.every((r) => r.action.startsWith('material.ledger.cancel')));

  // 前方一致なので、まとめて絞れる
  const byPrefix = await api('GET', '/api/auth/operation-logs?action=material');
  assert.ok(byPrefix.body.total >= byAction.body.total, '前方一致でまとめて絞れること');
  assert.ok(byPrefix.body.rows.every((r) => r.action.startsWith('material')));

  const byDate = await api('GET', '/api/auth/operation-logs?from=2026-02-01&to=2026-02-05');
  assert.ok(byDate.body.rows.every((r) => r.occurred_at >= '2026-02-01' && r.occurred_at <= '2026-02-06'));
});

test('操作ログの並べ替えも、許可した列だけ通る', async () => {
  const expected = (await api('GET', '/api/auth/operation-logs?limit=5')).body.rows.map((r) => r.id);
  for (const sort of ['summary', 'l.id; DELETE FROM users', 'target_id']) {
    const res = await api('GET', `/api/auth/operation-logs?sort=${encodeURIComponent(sort)}&limit=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows.map((r) => r.id), expected);
  }
  assert.ok(db.prepare('SELECT COUNT(*) n FROM users').get().n > 0, 'usersが消えていないこと');

  const asc = await api('GET', '/api/auth/operation-logs?sort=occurred_at&order=asc&limit=5');
  const at = asc.body.rows.map((r) => r.occurred_at);
  assert.deepEqual(at, [...at].sort());
});

test('絞り込みの選択肢は、実データにある値だけが出る', async () => {
  const res = await api('GET', '/api/auth/operation-logs/options');
  assert.equal(res.status, 200);

  const actual = db
    .prepare('SELECT DISTINCT action FROM operation_logs ORDER BY action')
    .all()
    .map((r) => r.action);
  assert.deepEqual(res.body.actions, actual, '実データのactionと一致すること');
  assert.ok(res.body.actions.includes('material.ledger.cancel'));
  // 固定リストではないので、まだ使われていない操作は出ない
  assert.ok(!res.body.actions.includes('rawSake.ledger.cancel'));
});

// --- 受注一覧（C-2） ---
//
// 以前は offset も総件数も無く、ORDER BY も固定だった。
// 実データ117件でまだ既定200には当たっていないが、増え続けるので同じ形に揃える。

test('受注一覧が {rows, total} を返し、ページを送れる', async () => {
  const first = await api('GET', '/api/orders?limit=50&offset=0');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, ORDER_ROWS);
  assert.equal(first.body.rows.length, 50);

  const seen = [];
  for (let offset = 0; offset < ORDER_ROWS; offset += 50) {
    const res = await api('GET', `/api/orders?limit=50&offset=${offset}`);
    seen.push(...res.body.rows.map((r) => r.id));
  }
  assert.equal(seen.length, ORDER_ROWS);
  assert.equal(new Set(seen).size, ORDER_ROWS, '重複も抜けもないこと');
});

test('受注を得意先・商品・ステータスで絞れる', async () => {
  const byCustomer = await api('GET', `/api/orders?customerId=${CUSTOMER_A}`);
  assert.ok(byCustomer.body.rows.every((r) => r.customer_id === CUSTOMER_A));
  assert.equal(
    byCustomer.body.total,
    db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id = ?').get(CUSTOMER_A).n
  );

  const byProduct = await api('GET', `/api/orders?productId=${PRODUCT_A}`);
  assert.ok(byProduct.body.rows.every((r) => r.product_id === PRODUCT_A));

  const byStatus = await api('GET', '/api/orders?status=発送済');
  assert.ok(byStatus.body.rows.every((r) => r.status === '発送済'));

  // 重ねられる
  const both = await api('GET', `/api/orders?customerId=${CUSTOMER_A}&status=発送済`);
  assert.equal(
    both.body.total,
    db.prepare("SELECT COUNT(*) n FROM orders WHERE customer_id = ? AND status = '発送済'")
      .get(CUSTOMER_A).n
  );
});

// 日付が3種類あるので、どれで絞るかを選べる。ここを間違えると
// 「納品日で絞ったつもりが受注日で絞られていた」が起きる
test('絞る日付を 受注日／納品日／入金予定日 から選べる', async () => {
  const byOrdered = await api('GET', '/api/orders?dateField=ordered_on&from=2026-01-01&to=2026-01-31');
  assert.ok(byOrdered.body.rows.every((r) => r.ordered_on >= '2026-01-01' && r.ordered_on <= '2026-01-31'));
  assert.equal(
    byOrdered.body.total,
    db.prepare("SELECT COUNT(*) n FROM orders WHERE ordered_on BETWEEN '2026-01-01' AND '2026-01-31'").get().n
  );

  const byDelivered = await api('GET', '/api/orders?dateField=delivered_on&from=2026-01-01&to=2026-01-31');
  assert.ok(byDelivered.body.rows.every((r) => r.delivered_on >= '2026-01-01' && r.delivered_on <= '2026-01-31'));
  assert.notEqual(byDelivered.body.total, byOrdered.body.total, '受注日とは別の件数になること');

  const byDue = await api('GET', '/api/orders?dateField=payment_due_on&from=2026-02-01&to=2026-02-28');
  assert.ok(byDue.body.rows.every((r) => r.payment_due_on >= '2026-02-01' && r.payment_due_on <= '2026-02-28'));

  // 知らない日付の名前は受注日に落ちる（列名をSQLに直接入れていない裏取り）
  const bogus = await api('GET', '/api/orders?dateField=note;DROP&from=2026-01-01&to=2026-01-31');
  assert.equal(bogus.status, 200);
  assert.equal(bogus.body.total, byOrdered.body.total, '受注日で絞ったのと同じになること');
});

test('受注の並べ替えは許可した列だけ通る', async () => {
  const expected = (await api('GET', '/api/orders?limit=5')).body.rows.map((r) => r.id);
  for (const sort of ['note', 'o.id; DROP TABLE orders', 'customer_id', '']) {
    const res = await api('GET', `/api/orders?sort=${encodeURIComponent(sort)}&limit=5`);
    assert.equal(res.status, 200, `"${sort}" で落ちないこと`);
    assert.deepEqual(res.body.rows.map((r) => r.id), expected, `"${sort}" は既定の順に落ちること`);
  }
  assert.ok(db.prepare('SELECT COUNT(*) n FROM orders').get().n > 0, 'ordersが消えていないこと');

  const asc = await api('GET', '/api/orders?sort=ordered_on&order=asc&limit=3');
  const dates = asc.body.rows.map((r) => r.ordered_on);
  assert.deepEqual(dates, [...dates].sort());
  assert.equal(dates[0], '2026-01-01');

  const byAmount = await api('GET', '/api/orders?sort=total_amount&order=desc&limit=1');
  assert.equal(byAmount.body.rows[0].total_amount, ORDER_ROWS * 3000, 'いちばん大きい金額が先頭に来ること');
});

// CSV出力は一覧と同じ絞り込みを使う。画面のボタンが
// 「上の絞り込み条件で出力」と言っているので、片方だけ絞れると嘘になる
test('CSV出力も、一覧と同じ絞り込みが効く', async () => {
  // ゆうパックCSVは**ヘッダー行なし**（郵便局の取込書式）。1行＝1受注
  const count = (body) => String(body).trim().split('\r\n').filter(Boolean).length;

  // 未着手は両方の得意先にまたがるので、得意先で絞ると減る＝絞り込みが効いている
  const wider = await api('GET', '/api/exports/yupack?status=未着手');
  assert.equal(wider.status, 200);
  assert.equal(
    count(wider.body),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status = '未着手'").get().n
  );

  const narrow = await api('GET', `/api/exports/yupack?customerId=${CUSTOMER_A}&status=未着手`);
  assert.equal(
    count(narrow.body),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE customer_id = ? AND status = '未着手'")
      .get(CUSTOMER_A).n,
    '一覧の絞り込みと同じ件数が出ること'
  );
  assert.ok(count(narrow.body) < count(wider.body), '得意先で絞ると減ること');

  // 商品でも絞れる
  const byProduct = await api('GET', `/api/exports/yupack?productId=${PRODUCT_A}&status=未着手`);
  assert.equal(
    count(byProduct.body),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE product_id = ? AND status = '未着手'")
      .get(PRODUCT_A).n
  );

  // 絞る日付も一覧と揃う（納品日で絞ると受注日とは別の件数になる）
  const byDelivered = await api('GET', '/api/exports/yupack?dateField=delivered_on&from=2026-01-01&to=2026-01-31');
  assert.equal(
    count(byDelivered.body),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE delivered_on BETWEEN '2026-01-01' AND '2026-01-31'").get().n
  );
});

// --- 原料受払記録（C-2） ---

test('原料受払記録が {rows, total} を返し、日付でも絞れる', async () => {
  const all = await api('GET', '/api/raw-sake-receipts?limit=50');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, RAW_ROWS);
  assert.equal(all.body.rows.length, 50);

  const seen = [];
  for (let offset = 0; offset < RAW_ROWS; offset += 50) {
    const res = await api('GET', `/api/raw-sake-receipts?limit=50&offset=${offset}`);
    seen.push(...res.body.rows.map((r) => r.id));
  }
  assert.equal(new Set(seen).size, RAW_ROWS, '重複も抜けもないこと');

  const byDate = await api('GET', '/api/raw-sake-receipts?from=2026-02-01&to=2026-02-28');
  assert.ok(byDate.body.rows.every((r) => r.txn_date >= '2026-02-01' && r.txn_date <= '2026-02-28'));
  assert.equal(
    byDate.body.total,
    db.prepare("SELECT COUNT(*) n FROM raw_sake_ledger WHERE txn_date BETWEEN '2026-02-01' AND '2026-02-28'").get().n
  );

  // 区分と重ねられる
  const both = await api('GET', '/api/raw-sake-receipts?txnType=棚卸調整&from=2026-02-01&to=2026-02-28');
  assert.ok(both.body.rows.every((r) => r.txn_type === '棚卸調整'));
  assert.ok(both.body.total < byDate.body.total);
});

test('原料受払記録の並べ替えも、許可した列だけ通る', async () => {
  const expected = (await api('GET', '/api/raw-sake-receipts?limit=5')).body.rows.map((r) => r.id);
  for (const sort of ['note', 'l.id; DROP TABLE tanks', 'to_tank_id']) {
    const res = await api('GET', `/api/raw-sake-receipts?sort=${encodeURIComponent(sort)}&limit=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows.map((r) => r.id), expected);
  }
  assert.ok(db.prepare('SELECT COUNT(*) n FROM tanks').get().n > 0, 'tanksが消えていないこと');

  const asc = await api('GET', '/api/raw-sake-receipts?sort=quantity&order=asc&limit=3');
  assert.deepEqual(asc.body.rows.map((r) => r.quantity), [1, 2, 3]);
});

// --- 修正履歴（C-2） ---

test('修正履歴が {rows, total} を返し、対象種別・実施者で絞れる', async () => {
  // 取消済みの行に日時と理由を入れて、修正履歴に出る形にする。
  // **月を2つに分ける** — 全部同じ日付だと、日付で絞っても件数が変わらず
  // 「絞り込みが効いているか」を確かめられない
  db.prepare(
    `UPDATE material_stock_ledger
        SET cancelled_at = CASE WHEN id % 2 = 0 THEN '2026-05-01 09:00:00'
                                ELSE '2026-06-01 09:00:00' END,
            cancel_reason = '確認用の取消'
      WHERE is_cancelled = 1`
  ).run();

  // 日時を持たない枝（蒸留明細の取消）も1件作る。
  // あの枝は取消の日時を残さないので occurred_at が NULL になる
  const rawId = db.prepare('SELECT id FROM raw_sake_ledger LIMIT 1').get().id;
  const distId = db
    .prepare(
      `INSERT INTO distillations (distillation_code, started_on, started_time, status)
       VALUES ('D-9001', '2026-05-10', '09:00', '完了')`
    )
    .run().lastInsertRowid;
  db.prepare(
    `INSERT INTO distillation_details
       (detail_code, distillation_id, raw_sake_ledger_id, input_l, source_tank_id, is_cancelled, note)
     VALUES ('DTL-9001', ?, ?, 20, ?, 1, '確認用の取消')`
  ).run(distId, rawId, SP1);

  const res = await api('GET', '/api/corrections?limit=2');
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 1, '取消した行が出ること');
  assert.ok(res.body.rows.length <= 2, 'limitが効くこと');

  const byType = await api('GET', '/api/corrections?targetType=資材在庫変動履歴');
  assert.ok(byType.body.total > 0);
  assert.ok(byType.body.rows.every((r) => r.target_type === '資材在庫変動履歴'));
  assert.ok(byType.body.total < res.body.total, '絞ると total も減ること（蒸留明細のぶん）');
  assert.equal(
    byType.body.total,
    db.prepare('SELECT COUNT(*) n FROM material_stock_ledger WHERE is_cancelled = 1').get().n
  );

  // 実データにある値だけが選択肢に出る
  const options = await api('GET', '/api/corrections/options');
  assert.equal(options.status, 200);
  assert.ok(options.body.targetTypes.includes('資材在庫変動履歴'));
  assert.ok(options.body.targetTypes.includes('蒸留明細'));
  assert.ok(!options.body.targetTypes.includes('浄酎容器変動履歴'), '使われていない種別は出ないこと');
});

// 蒸留明細の枝は取消の日時を持たない（理由を備考に残すだけの作り）。
// 日付で絞るとその行が落ちるので、画面でも断りを出している
test('修正履歴を日付で絞ると、その月のぶんだけになる（日時を持たない行は落ちる）', async () => {
  const all = await api('GET', '/api/corrections?limit=1000');
  const inRange = all.body.rows.filter(
    (r) => r.occurred_at && r.occurred_at >= '2026-05-01' && r.occurred_at <= '2026-05-31 23:59:59'
  ).length;
  assert.ok(inRange > 0, '前提: 5月に取消がある');
  assert.ok(inRange < all.body.total, '前提: 5月以外にも行がある');
  assert.ok(all.body.rows.some((r) => !r.occurred_at), '前提: 日時を持たない行がある');

  const byDate = await api('GET', '/api/corrections?from=2026-05-01&to=2026-05-31&limit=1000');
  assert.ok(byDate.body.rows.every((r) => r.occurred_at), '日時を持つ行だけになること');
  assert.equal(byDate.body.total, inRange, 'total も絞ったあとの件数であること');
  assert.equal(byDate.body.rows.length, inRange);

  // 6月で絞ると別の件数になる
  const june = await api('GET', '/api/corrections?from=2026-06-01&to=2026-06-30&limit=1000');
  assert.ok(june.body.total > 0);
  assert.equal(june.body.total + inRange + 1, all.body.total, '5月＋6月＋日時なし1件で全部');
});

test('修正履歴の並べ替えも、許可した列だけ通る', async () => {
  const expected = (await api('GET', '/api/corrections?limit=5')).body.rows.map((r) => r.target_code);
  for (const sort of ['action', 'reason; DROP TABLE materials', 'detail']) {
    const res = await api('GET', `/api/corrections?sort=${encodeURIComponent(sort)}&limit=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows.map((r) => r.target_code), expected);
  }
  assert.ok(db.prepare('SELECT COUNT(*) n FROM materials').get().n > 0, 'materialsが消えていないこと');
});

test('修正履歴もページを送れて、日時を持たない行は最後に来る', async () => {
  const all = await api('GET', '/api/corrections?limit=1000');
  const total = all.body.total;
  assert.ok(total >= 4, '前提: ページを分けられるだけの件数がある');

  // 2件ずつ送って、重複も抜けもないこと
  const seen = [];
  for (let offset = 0; offset < total; offset += 2) {
    const page = await api('GET', `/api/corrections?limit=2&offset=${offset}`);
    assert.ok(page.body.rows.length > 0, `offset=${offset} で行が返ること`);
    seen.push(...page.body.rows.map((r) => `${r.target_type}/${r.target_code}/${r.occurred_at}`));
  }
  assert.equal(seen.length, total, '全件を拾えること');
  assert.equal(new Set(seen).size, total, '同じ行が2度出ないこと');

  // 日時を持たない行（蒸留明細）は、昇順でも降順でも最後
  for (const order of ['desc', 'asc']) {
    const sorted = await api('GET', `/api/corrections?sort=occurred_at&order=${order}&limit=1000`);
    const withoutDate = sorted.body.rows.findIndex((r) => !r.occurred_at);
    assert.ok(withoutDate >= 0, '日時を持たない行があること');
    assert.equal(
      withoutDate,
      sorted.body.rows.length - 1,
      `${order} でも、日時を持たない行は最後に来ること`
    );
  }
});

// --- 版が食い違ったときに、原因が分かる形で止まること ---
//
// 利用者の環境で「Cannot read properties of undefined (reading 'length')」が
// 4画面に同時に出た。原因は **git pull したあとサーバーを再起動していなかった**こと。
// public/ はディスクから毎回読まれるので画面だけが新しくなり、src/ は起動時の
// ものが動き続ける。古いサーバーは行の配列を返すので、{rows, total} に分解すると
// rows が undefined になり、利用者には原因の分からない赤い帯だけが出ていた。
//
// 存在しないAPIには src/app.js が同じ趣旨の案内を404で返していたが、
// **形が変わっただけの場合は404にならず素通りしていた**。
// asListResult()（public/assets/js/app.js）で塞いだので、その動きを押さえる。

test('一覧APIは、画面が期待する {rows, total} の形で返る', async () => {
  // ここが配列に戻ると、画面側が分解した瞬間に undefined になる
  for (const path of [
    '/api/materials/ledger?limit=1',
    '/api/auth/operation-logs?limit=1',
    '/api/orders?limit=1',
    '/api/raw-sake-receipts?limit=1',
    '/api/corrections?limit=1',
  ]) {
    const res = await api('GET', path);
    assert.equal(res.status, 200, path);
    assert.ok(!Array.isArray(res.body), `${path} が配列で返っていないこと`);
    assert.ok(Array.isArray(res.body.rows), `${path} の rows が配列であること`);
    assert.equal(typeof res.body.total, 'number', `${path} の total が数であること`);
  }
});

test('画面のヘルパは、古い形（配列）を原因の分かるメッセージで断る', () => {
  // public/assets/js/app.js は素のスクリプト。試験からは読み込んで評価する
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../public/assets/js/app.js'),
    'utf8'
  );
  const asListResult = new Function(`${src}; return asListResult;`)();

  // 新しい形はそのまま通る
  const ok = asListResult({ rows: [1, 2], total: 2 }, '資材の入出庫履歴');
  assert.deepEqual(ok, { rows: [1, 2], total: 2 });

  // 古い形は、何をすればよいかが書かれたメッセージで止まる
  assert.throws(
    () => asListResult([1, 2], '資材の入出庫履歴'),
    (err) => {
      assert.match(err.message, /資材の入出庫履歴/, 'どの一覧かが分かること');
      assert.match(err.message, /再起動/, '何をすればよいかが書いてあること');
      return true;
    }
  );
});
