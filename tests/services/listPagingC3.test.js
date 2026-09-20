// 探しにくい一覧に絞り込みとページ送りを入れる（PR C-3）。
//
// **ここでも「見えていない行」が1件見つかった。**
// サンプル出荷は実データ49件あるのに、画面には47件しか出ていなかった。
// listSampleShipments の商品の結合が内部結合で、販促資料だけを送った行
// （product_id が空）が黙って落ちていた。
// スキーマは最初から「販促資料だけの送付では空」と書いてあり、移行ローダーも
// 商品が無い行を落としていない。結合だけが追いついていなかった。
// 資材の入出庫履歴205件・操作ログと同じ形。
//
// あわせて浄酎容器変動履歴の WHERE の括弧も直している。
//   WHERE l.from_tank_id = @tankId OR l.to_tank_id = @tankId
// これは条件が1つのうちは正しいが、AND を足した途端に A AND B OR C と読まれて、
// **タンクで絞ったつもりが他のタンクの行まで混ざる**。
//
// この案件では「通るのに何も確かめていない試験」を4回書いた。
// ここでは1つずつ、**直しを外すと落ちる**形にしてある（各 test のコメント参照）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-list-paging-c3.sqlite');
const api = harness.api;

let db;

const CUSTOMER_A = 1; // 株式会社NOTO
const CUSTOMER_B = 2; // 能登商店
const PRODUCT_A = 1;
const TANK_A = 1; // 浄酎タンク1
const TANK_B = 2; // 浄酎タンク2

// 実データ49件より少し多く。200件の壁ではなくページ送りの確認が目的
const SAMPLE_ROWS = 60;
const TANK_LEDGER_ROWS = 100;
const DISTILLATION_ROWS = 50;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const cust = db.prepare('INSERT INTO customers (uid, code, name) VALUES (?, ?, ?)');
    cust.run(generateUid(db, 'customers'), 'C-001', '株式会社NOTO');
    cust.run(generateUid(db, 'customers'), 'C-002', '能登商店');

    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, list_price)
       VALUES (?, 'P-001', '浄酎 300ml', 300, 3000)`
    ).run(generateUid(db, 'products'));

    const tank = db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l)
       VALUES (?, ?, ?, ?, 1000)`
    );
    tank.run(generateUid(db, 'tanks'), 'T-01', '浄酎タンク1', 'ステンレスタンク');
    tank.run(generateUid(db, 'tanks'), 'T-02', '浄酎タンク2', 'ステンレスタンク');

    // --- サンプル出荷 ---
    //
    // 仕込みの狙い:
    //   i === 0            商品が空（販促資料のみ）。**内部結合に戻すと落ちる**
    //   i === 1            得意先マスタに無い送付先。名前は備考の「送付先: …」だけ
    //   発送日は2つの月に振り分ける。絞り込みで total が動くことを確かめるため
    const smp = db.prepare(
      `INSERT INTO sample_shipments
         (sample_no, shipped_on, customer_id, contact_name, product_id, quantity, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < SAMPLE_ROWS; i += 1) {
      smp.run(
        `S26-${String(i + 1).padStart(4, '0')}`,
        i % 2 === 0 ? `2026-05-${String((i % 28) + 1).padStart(2, '0')}`
                    : `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
        i === 1 ? null : (i % 2 === 0 ? CUSTOMER_A : CUSTOMER_B),
        i % 3 === 0 ? `担当${i}様` : null,
        i === 0 ? null : PRODUCT_A,
        i === 0 ? null : (i % 5) + 1,
        i === 1 ? '送付先: マスタに無い蔵元' : null
      );
    }

    // --- 浄酎容器変動履歴 ---
    //
    // 仕込みの狙い: 「T-02 の継足」を必ず作る。
    // tankId=T-01 かつ txnType=継足 で引いたときに、括弧が無いと
    // この行が混ざる（A AND B OR C と読まれるため）。
    const led = db.prepare(
      `INSERT INTO tank_ledger (txn_date, from_tank_id, txn_type, to_tank_id, quantity_l, is_cancelled)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < TANK_LEDGER_ROWS; i += 1) {
      const isB = i % 10 === 0; // 10件に1件は T-02 だけの行
      led.run(
        i % 2 === 0 ? `2026-05-${String((i % 28) + 1).padStart(2, '0')}`
                    : `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
        isB ? TANK_B : TANK_A,
        i % 3 === 0 ? '継足' : '容器移動',
        isB ? null : TANK_B,
        10 + i,
        i % 25 === 0 ? 1 : 0
      );
    }

    // --- 蒸留記録 ---
    // 払出先は T-01 と T-02 に振り分け、開始日は2つの月に分ける
    const dist = db.prepare(
      `INSERT INTO distillations
         (distillation_code, started_on, started_time, total_input_l, status, output_l, output_tank_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < DISTILLATION_ROWS; i += 1) {
      dist.run(
        `D26-${String(i + 1).padStart(4, '0')}`,
        i % 2 === 0 ? `2026-05-${String((i % 28) + 1).padStart(2, '0')}`
                    : `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
        '09:00',
        100 + i,
        '完了',
        80 + i,
        // 3件に1件を T-02 に。2件に1件が5月なので、月と払出先がずれて重なりの確認になる
        i % 3 === 0 ? TANK_B : TANK_A
      );
    }
  }));
});

test.after(() => harness.teardown());

// --- サンプル出荷 -----------------------------------------------------------

test('サンプル出荷: 商品が空の行（販促資料のみ）も一覧に出る', async () => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM sample_shipments').get().n;
  const { body } = await api('GET', '/api/shipments/samples?limit=1000');

  // 内部結合に戻すとここが 59 になって落ちる
  assert.equal(body.total, total);
  assert.equal(body.rows.length, total);

  const promoOnly = body.rows.find((r) => r.sample_no === 'S26-0001');
  assert.ok(promoOnly, '販促資料だけの行が一覧に出ていない（商品の結合が内部結合に戻っていないか）');
  assert.equal(promoOnly.product_name, null);
  assert.equal(promoOnly.quantity, null);
});

test('サンプル出荷: 送付先の検索が備考の「送付先: …」にも当たる', async () => {
  // 得意先マスタに無い送付先は customer_id が空で、名前は備考にしかない。
  // c.name だけを見ていると0件になって落ちる
  const { body } = await api('GET', '/api/shipments/samples?customer=' + encodeURIComponent('マスタに無い蔵元'));
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].sample_no, 'S26-0002');
  assert.equal(body.rows[0].customer_name, null);

  // 得意先名でも引けること（両方を見ていることの裏取り）
  const byName = await api('GET', '/api/shipments/samples?customer=' + encodeURIComponent('能登商店'));
  assert.ok(byName.body.total > 0);
  assert.ok(byName.body.rows.every((r) => r.customer_name === '能登商店'));
});

test('サンプル出荷: total は絞り込み後の件数で、ページを送っても重複も抜けも無い', async () => {
  const may = db
    .prepare("SELECT COUNT(*) AS n FROM sample_shipments WHERE shipped_on LIKE '2026-05-%'")
    .get().n;
  assert.ok(may > 0 && may < SAMPLE_ROWS, '仕込みが偏っていて絞り込みの確認にならない');

  const filter = 'from=2026-05-01&to=2026-05-31';
  const first = await api('GET', `/api/shipments/samples?${filter}&limit=10&offset=0`);
  assert.equal(first.body.total, may);

  const seen = new Set();
  for (let offset = 0; offset < may; offset += 10) {
    const { body } = await api('GET', `/api/shipments/samples?${filter}&limit=10&offset=${offset}`);
    assert.equal(body.total, may);
    for (const r of body.rows) {
      assert.ok(!seen.has(r.id), `ページを送ったら同じ行が二度出た (id=${r.id})`);
      seen.add(r.id);
      assert.ok(r.shipped_on.startsWith('2026-05'), '絞り込みの外の行が混ざっている');
    }
  }
  assert.equal(seen.size, may, 'ページを送ると抜ける行がある');
});

test('サンプル出荷: 許可していない並べ替えを送っても壊れず既定順で返る', async () => {
  const { status, body } = await api(
    'GET', "/api/shipments/samples?limit=5&sort=note'); DROP TABLE sample_shipments; --"
  );
  assert.equal(status, 200);
  assert.equal(body.rows.length, 5);
  assert.equal(body.total, SAMPLE_ROWS);
  // 既定は発送日の新しい順
  const dates = body.rows.map((r) => r.shipped_on);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sample_shipments').get().n === SAMPLE_ROWS);
});

// --- 浄酎容器変動履歴 -------------------------------------------------------

test('浄酎容器変動履歴: タンクと受払区分を重ねても、他のタンクの行が混ざらない', async () => {
  // 括弧を外すと `from=T-01 OR to=T-01 AND 継足` ではなく
  // `from=T-01 AND 継足 OR to=T-01` と読まれ、T-02 だけの継足行が混ざる
  const { body } = await api(
    'GET', `/api/tank-operations/ledger?tankId=${TANK_A}&txnType=${encodeURIComponent('継足')}&limit=1000`
  );

  const expected = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tank_ledger
        WHERE (from_tank_id = ? OR to_tank_id = ?) AND txn_type = '継足'`
    )
    .get(TANK_A, TANK_A).n;

  // 括弧を外すとこれが増えて落ちる
  assert.equal(body.total, expected);
  for (const r of body.rows) {
    assert.equal(r.txn_type, '継足');
    assert.ok(
      r.from_tank_id === TANK_A || r.to_tank_id === TANK_A,
      `T-01 と関係ない行が混ざっている (id=${r.id})`
    );
  }

  // 仕込みが効いているか（混ざりうる行が本当にあるか）を裏取りする。
  // ここが0だと、括弧を外しても落ちない＝空振りの試験になる
  const wouldLeak = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tank_ledger
        WHERE from_tank_id <> ? AND (to_tank_id IS NULL OR to_tank_id <> ?) AND txn_type = '継足'`
    )
    .get(TANK_A, TANK_A).n;
  assert.ok(wouldLeak > 0, '混ざりうる行を仕込めていない（この試験は空振りしている）');
});

test('浄酎容器変動履歴: 日付と取消済みで絞れ、total が絞り込み後の件数になる', async () => {
  const all = await api('GET', '/api/tank-operations/ledger?limit=1000');
  assert.equal(all.body.total, TANK_LEDGER_ROWS);

  const may = await api('GET', '/api/tank-operations/ledger?from=2026-05-01&to=2026-05-31&limit=1000');
  assert.ok(may.body.total > 0 && may.body.total < TANK_LEDGER_ROWS);
  assert.ok(may.body.rows.every((r) => r.txn_date.startsWith('2026-05')));

  const cancelled = db.prepare('SELECT COUNT(*) AS n FROM tank_ledger WHERE is_cancelled = 1').get().n;
  assert.ok(cancelled > 0, '取消済みを仕込めていない');
  const onlyCancelled = await api('GET', '/api/tank-operations/ledger?cancelled=1&limit=1000');
  assert.equal(onlyCancelled.body.total, cancelled);

  const notCancelled = await api('GET', '/api/tank-operations/ledger?cancelled=0&limit=1000');
  assert.equal(notCancelled.body.total, TANK_LEDGER_ROWS - cancelled);
});

test('浄酎容器変動履歴: 受払区分の選択肢は実データにある値だけ', async () => {
  const { body } = await api('GET', '/api/tank-operations/ledger/options');
  assert.deepEqual(body.txnTypes, ['容器移動', '継足']);
  // CHECK制約には7種あるが、実データに無いものは出さない
  assert.ok(!body.txnTypes.includes('取消戻し'));
});

test('浄酎容器変動履歴: ページを送っても重複も抜けも無い', async () => {
  const seen = new Set();
  for (let offset = 0; offset < TANK_LEDGER_ROWS; offset += 25) {
    const { body } = await api('GET', `/api/tank-operations/ledger?limit=25&offset=${offset}`);
    assert.equal(body.total, TANK_LEDGER_ROWS);
    for (const r of body.rows) {
      assert.ok(!seen.has(r.id), `ページを送ったら同じ行が二度出た (id=${r.id})`);
      seen.add(r.id);
    }
  }
  assert.equal(seen.size, TANK_LEDGER_ROWS);
});

// --- 蒸留記録 ---------------------------------------------------------------

test('蒸留記録: 開始日と払出先タンクで絞れ、total が絞り込み後の件数になる', async () => {
  const all = await api('GET', '/api/distillations?limit=500');
  assert.equal(all.body.total, DISTILLATION_ROWS);

  const may = await api('GET', '/api/distillations?from=2026-05-01&to=2026-05-31&limit=500');
  assert.ok(may.body.total > 0 && may.body.total < DISTILLATION_ROWS);
  assert.ok(may.body.rows.every((r) => r.started_on.startsWith('2026-05')));

  const toB = db
    .prepare('SELECT COUNT(*) AS n FROM distillations WHERE output_tank_id = ?')
    .get(TANK_B).n;
  assert.ok(toB > 0 && toB < DISTILLATION_ROWS, '払出先を仕込めていない');
  const byTank = await api('GET', `/api/distillations?outputTankId=${TANK_B}&limit=500`);
  assert.equal(byTank.body.total, toB);
  assert.ok(byTank.body.rows.every((r) => r.output_tank_name === '浄酎タンク2'));

  // 重ねたときに両方効くこと（片方しか効いていないと total が合わない）
  const both = await api(
    'GET', `/api/distillations?outputTankId=${TANK_B}&from=2026-05-01&to=2026-05-31&limit=500`
  );
  const expected = db
    .prepare(
      `SELECT COUNT(*) AS n FROM distillations
        WHERE output_tank_id = ? AND started_on BETWEEN '2026-05-01' AND '2026-05-31'`
    )
    .get(TANK_B).n;
  assert.ok(expected > 0 && expected < toB, '重ねがけの確認にならない仕込みになっている');
  assert.equal(both.body.total, expected);
});

test('蒸留記録: 払出先の選択肢は実際に払出先になっているタンクだけ', async () => {
  const { body } = await api('GET', '/api/distillations/options');
  assert.deepEqual(body.outputTanks.map((t) => t.code), ['T-01', 'T-02']);
});

test('蒸留記録: ページを送っても重複も抜けも無く、許可外の並べ替えでも壊れない', async () => {
  const seen = new Set();
  for (let offset = 0; offset < DISTILLATION_ROWS; offset += 15) {
    const { body } = await api('GET', `/api/distillations?limit=15&offset=${offset}&sort=note`);
    assert.equal(body.total, DISTILLATION_ROWS);
    for (const r of body.rows) {
      assert.ok(!seen.has(r.id), `ページを送ったら同じ行が二度出た (id=${r.id})`);
      seen.add(r.id);
    }
  }
  assert.equal(seen.size, DISTILLATION_ROWS);
});
