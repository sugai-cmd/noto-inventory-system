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
