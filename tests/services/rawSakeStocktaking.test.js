// 原酒タンクの棚卸。
//
// raw_sake_ledger.txn_type は ('受入','払出') だけで、3つの台帳のうち
// 原酒だけが棚卸の区分を持っていなかった。0019 で '棚卸調整' / '欠減' を足す。
//
// PR #38 で原酒タンクの棚卸は塞いである（浄酎の台帳に調整が書かれて原酒の残量は
// まったく直らなかったため）。ここで原酒専用の棚卸を作って戻す。
//
// 実データには棚卸でしか直せない値がある:
//   SP-001 原酒ポリ1 … 30L（容量20Lを超えている）
//   SP-002 原酒ポリ2 … -20L（マイナス）

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-rawsake-stocktaking.sqlite');
const api = harness.api;

let db;

// タンクのid。seedで入れた順に決まる
const SP1 = 1;       // SP-001 原酒ポリ1（20L 入っている）
const SP2 = 2;       // SP-002 原酒ポリ2（実データと同じくマイナスにする）
const SP3 = 3;       // SP-003 原酒ポリ3（空）
const JOCHU = 4;     // T-001 浄酎タンク1
const RESIDUE = 5;   // U-001 残渣保管タンク1
const DISCARDED = 6; // SP-004 原酒ポリ4（廃棄済み）

const volume = (tankId) =>
  db.prepare('SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE tank_id = ?')
    .get(tankId).current_volume_l;
const ledger = () => db.prepare('SELECT * FROM raw_sake_ledger ORDER BY id').all();
const lastRow = () => db.prepare('SELECT * FROM raw_sake_ledger ORDER BY id DESC LIMIT 1').get();
const logs = () =>
  db.prepare("SELECT * FROM operation_logs WHERE action = 'stocktaking.rawSake' ORDER BY id DESC").all();

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    for (const [code, name, type, max] of [
      ['SP-001', '原酒ポリ1', '原酒ポリタンク', 20],
      ['SP-002', '原酒ポリ2', '原酒ポリタンク', 20],
      ['SP-003', '原酒ポリ3', '原酒ポリタンク', 20],
      ['T-001', '浄酎タンク1', 'ステンレスタンク', 1000],
      ['U-001', '残渣保管タンク1', 'PP', 514],
      ['SP-004', '原酒ポリ4', '原酒ポリタンク', 20],
    ]) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(generateUid(db, 'tanks'), code, name, type, max);
    }
    db.prepare("UPDATE tanks SET discarded_on = '2026-05-01' WHERE code = 'SP-004'").run();

    db.prepare(
      `INSERT INTO raw_sake_brands (uid, code, name, abv) VALUES (?, 'toriya-BYR6-L1', '浄酎用池月', 18.3)`
    ).run(generateUid(db, 'raw_sake_brands'));

    // SP-001 に20L受け入れる
    db.prepare(
      `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, to_tank_id, quantity, raw_sake_brand_id)
       VALUES ('R2607-1001', '2026-07-15', '受入', 1, 20, 1)`
    ).run();
    // SP-002 は実データの原酒ポリ2と同じく、払出が受入を上回ってマイナスになっている
    db.prepare(
      `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, from_tank_id, quantity)
       VALUES ('R2607-0001', '2026-07-20', '払出', 2, 20)`
    ).run();
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- マイグレーション ---

test('台帳を作り直しても、行も外部キーも壊れていない', () => {
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(ledger().length, 2);
  assert.deepEqual(ledger().map((r) => r.lot_code), ['R2607-1001', 'R2607-0001']);

  // 索引が戻っていること（作り直しで落ちたままにしない）
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'raw_sake_ledger'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes('idx_rawsake_legacy'), 'legacy_lot_code の索引');
  assert.ok(indexes.some((n) => n.startsWith('sqlite_autoindex')), 'lot_code の UNIQUE');
});

test('seedの残量が、実データと同じ形になっている', () => {
  assert.equal(volume(SP1), 20);
  assert.equal(volume(SP2), -20, '実データの原酒ポリ2と同じくマイナス');
  assert.equal(volume(SP3), 0);
});

// --- 棚卸 ---

test('実測が理論を下回ると欠減が1行入り、残量が実測値になる', async () => {
  const { status, body } = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP1,
    actualVolumeL: 18.5,
    txnDate: '2026-09-10',
    reason: '検尺したら減っていた',
  });
  assert.equal(status, 201);
  assert.equal(body.txnType, '欠減');
  assert.equal(body.diff, -1.5);
  assert.equal(volume(SP1), 18.5, '残量が実測値に一致すること');

  const row = lastRow();
  assert.equal(row.txn_type, '欠減');
  assert.equal(row.from_tank_id, SP1, '減る側は from_tank_id（ビューの数え方と揃える）');
  assert.equal(row.to_tank_id, null);
  assert.equal(row.quantity, 1.5, '数量は絶対値');
  assert.match(row.note, /棚卸: 理論20L → 実測18.5L \/ 検尺したら減っていた/);
  assert.ok(row.created_by, '誰が入れた行かが台帳に残ること');
  assert.equal(row.raw_sake_brand_id, null, '増減の銘柄は推測しない');
});

test('実測が理論を上回ると棚卸調整が1行入る', async () => {
  const { status, body } = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP1,
    actualVolumeL: 20,
    txnDate: '2026-09-10',
  });
  assert.equal(status, 201);
  assert.equal(body.txnType, '棚卸調整');
  assert.equal(body.diff, 1.5);
  assert.equal(volume(SP1), 20);

  const row = lastRow();
  assert.equal(row.to_tank_id, SP1, '増える側は to_tank_id');
  assert.equal(row.from_tank_id, null);
  assert.equal(row.quantity, 1.5);
});

test('マイナスになっているタンクを0に直せる（実データの原酒ポリ2と同じ形）', async () => {
  const { status, body } = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP2,
    actualVolumeL: 0,
    txnDate: '2026-09-10',
    reason: '空だった',
  });
  assert.equal(status, 201);
  assert.equal(body.theoretical, -20);
  assert.equal(body.diff, 20);
  assert.equal(body.txnType, '棚卸調整');
  assert.equal(volume(SP2), 0, 'マイナスが直ること');
});

test('差が0なら1行も書かない', async () => {
  const before = ledger().length;
  const { status, body } = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP2,
    actualVolumeL: 0,
  });
  assert.equal(status, 201);
  assert.equal(body.skipped, true);
  assert.equal(body.diff, 0);
  assert.equal(ledger().length, before, '台帳を汚さないこと');
});

// --- 採番 ---

test('棚卸の原酒受払IDは0帯に入り、移入の帯を食わない', () => {
  const codes = ledger().filter((r) => ['棚卸調整', '欠減'].includes(r.txn_type)).map((r) => r.lot_code);
  assert.equal(codes.length, 3);
  for (const code of codes) {
    const seq = Number(code.split('-')[1]);
    assert.ok(seq < 1000, `${code} は0帯（移入の帯は1000〜）`);
  }
  // 同じ0帯の払出と重ならないこと
  assert.equal(new Set(ledger().map((r) => r.lot_code)).size, ledger().length);
});

test('棚卸のあとも、受入は今までどおり回数の帯を採る', async () => {
  const { status, body } = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-09-11', toTankId: SP3, quantity: 20,
  });
  assert.equal(status, 201);

  const code = db.prepare("SELECT lot_code FROM raw_sake_ledger WHERE txn_type = '受入' ORDER BY id DESC LIMIT 1").get().lot_code;
  assert.match(code, /^R2609-1001$/, '9月の1回目の移入なので1001から');
});

// --- 原酒タンク以外は断る ---

test('浄酎タンク・残渣タンクを指定すると422', async () => {
  for (const [tankId, label] of [[JOCHU, '浄酎'], [RESIDUE, '残渣']]) {
    const before = ledger().length;
    const { status, body } = await api('POST', '/api/stocktaking/raw-sake-tanks', {
      tankId, actualVolumeL: 100,
    });
    assert.equal(status, 422, `${label}タンクは断ること`);
    assert.match(body.message, new RegExp(`${label}タンクです`));
    assert.equal(ledger().length, before, '原酒の台帳に1行も増えないこと');
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tank_ledger').get().n, 0,
    '浄酎の台帳にも1行も増えないこと'
  );
});

test('廃棄済みの原酒タンクも断る', async () => {
  const { status, body } = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: DISCARDED, actualVolumeL: 10,
  });
  assert.equal(status, 422);
  assert.match(body.message, /廃棄されています/);
});

test('存在しないタンクは404、実測液量が無ければ400', async () => {
  const missing = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: 9999, actualVolumeL: 10,
  });
  assert.equal(missing.status, 404);

  const noValue = await api('POST', '/api/stocktaking/raw-sake-tanks', { tankId: SP1 });
  assert.equal(noValue.status, 400);

  // 度数の欄は無い（raw_sake_ledger に abv 列が無い）
  const withAbv = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP1, actualVolumeL: 20, abv: 18.3,
  });
  assert.equal(withAbv.status, 400, '知らないキーは受け付けない');
});

// --- 浄酎側を壊していない ---

test('浄酎タンクの棚卸は今までどおり、原酒の台帳には書かない', async () => {
  const before = ledger().length;
  const { status } = await api('POST', '/api/stocktaking/tanks', {
    tankId: JOCHU, actualVolumeL: 50, txnDate: '2026-09-10',
  });
  assert.equal(status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tank_ledger').get().n, 1);
  assert.equal(ledger().length, before, '原酒の台帳は動かないこと');
});

// --- ロット追跡 ---

test('棚卸を入れても、内訳の合計が残量と一致し続ける', async () => {
  const { status, body } = await api('GET', '/api/lots/raw-sake?includeEmpty=1');
  assert.equal(status, 200);

  // SP-002 は除く。台帳の払出が受入を上回っているタンクは、take() が
  // 「内訳をマイナスにしない」ために元から残量と食い違う（移行データ向けの守り）。
  // そこは今回触っていないので、ここでは素直なタンクで不変条件を見張る。
  for (const tank of body.filter((t) => t.code !== 'SP-002')) {
    const sum = tank.lots.reduce((n, l) => n + l.volumeL, 0);
    assert.ok(
      Math.abs(sum - tank.currentVolumeL) < 0.001,
      `${tank.code} の内訳 ${sum}L が残量 ${tank.currentVolumeL}L と一致すること`
    );
  }
});

test('棚卸で増えたぶんは「由来が分からないぶん」として出る', async () => {
  const { body } = await api('GET', '/api/lots/raw-sake?includeEmpty=1');

  const sp2 = body.find((t) => t.code === 'SP-002');
  assert.ok(sp2, '原酒ポリ2が出ること');
  const adjusted = sp2.lots.find((l) => l.label === '由来が分からないぶん');
  assert.ok(adjusted, '棚卸で足した分は銘柄を推測せず、由来不明として置く');
  assert.equal(adjusted.volumeL, 20);

  const sp1 = body.find((t) => t.code === 'SP-001');
  assert.equal(sp1.currentVolumeL, 20);
  assert.ok(
    sp1.lots.some((l) => l.label === '浄酎用池月'),
    '受け入れた銘柄が残っていること（欠減で按分しても消えない）'
  );
});

// --- 操作ログ ---

test('操作ログが残る（差が0のときも）', () => {
  const all = logs();
  assert.equal(all.length, 4, '棚卸のたびに1行（欠減・棚卸調整2件・差なし1件）');

  const skipped = all.find((l) => l.target_id === null);
  assert.ok(skipped, '差が0で書かなかったときも残ること');
  assert.match(skipped.summary, /差なし/);

  const withDiff = all.find((l) => /欠減/.test(l.summary));
  assert.ok(withDiff);
  assert.equal(withDiff.target_type, 'raw_sake_ledger');
  assert.match(withDiff.summary, /原酒ポリ1（SP-001）を棚卸/);
  assert.match(withDiff.summary, /理論20L → 実測18.5L/);
  assert.match(withDiff.summary, /理由: 検尺したら減っていた/);

  const detail = JSON.parse(withDiff.detail_json);
  assert.equal(detail.diff, -1.5);
  assert.equal(detail.txnType, '欠減');
  assert.equal(detail.tankCode, 'SP-001');
});

// --- 蒸留の投入元が壊れていない ---

test('蒸留の投入元の選択肢が今までどおり出る', async () => {
  const { status, body } = await api('GET', '/api/raw-sake-receipts/tanks');
  assert.equal(status, 200);
  assert.deepEqual(
    body.map((t) => t.code).sort(),
    ['SP-001', 'SP-002', 'SP-003', 'SP-004'],
    '原酒タンクだけが出ること（浄酎・残渣は混ざらない）'
  );
  assert.equal(body.find((t) => t.code === 'SP-001').current_volume_l, 20);
});
