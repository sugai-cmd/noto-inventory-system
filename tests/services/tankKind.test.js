// タンクを中身で分け、原酒・残渣を浄酎の世界から外すこと。
//
// タンクモニターは68本すべてを出していた。原酒ポリ26本と残渣6本は
// tank_ledger に1行も持たない（原酒は raw_sake_ledger、残渣はどこにも無い）ので、
// 浄酎の画面に必ず 0L で並んでいた。
//
// もっと悪いのが棚卸で、原酒タンクの理論値が 0L と出る（実データでは19本）。
// そのまま保存すると tank_ledger に調整が書かれるが、原酒の残量は
// v_raw_sake_tank_volume から出るので**直らず**、そのうえ浄酎の台帳が汚れる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

// **createHarness より前に src/ を require しないこと。**
// config.js は読み込んだ時点で DB_PATH を評価するため、先に読むと
// 運用中の db/database.sqlite を掴んでしまう（ハーネスが止めてくれる）。
const harness = createHarness('test-tank-kind.sqlite');
const api = harness.api;
const { tankKind } = require('../../src/services/tankService');

let db;

const JOCHU_TANK = 1;    // T-001
const RAW_TANK = 5;      // SP-001
const RESIDUE_TANK = 7;  // U-001

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    const tank = db.prepare(
      `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    // 実データの並びを写す。
    // **SP（原酒ポリ）と JP（出荷用ポリ）は container_type が同じ 'PE'** なので、
    // 種別では区別できない。一斗瓶は容器IDが G- ではなく T- で採番されている。
    const rows = [
      ['T-001', 'ステンレスタンク1', 'ステンレスタンク', 1000, 500],
      ['T-004', '一斗瓶1', '斗瓶', 18, 0],
      ['B-001', '樽1', '木樽', 200, 0],
      ['JP-003', '出荷用ポリタンク3', 'PE', 20, 0],
      ['SP-001', '原酒ポリ1', 'PE', 20, 0],
      ['SP-002', '原酒ポリ2', 'PE', 20, 0],
      ['U-001', '残渣保管タンク1', 'PP', 200, 0],
      ['Q-001', 'テナー1', 'QBテナー', 1000, 0],
    ];
    for (const [code, name, type, max, init] of rows) {
      tank.run(generateUid(db, 'tanks'), code, name, type, max, init);
    }

    // 原酒は原料受払記録にだけ残る（浄酎の台帳には1行も無い）
    db.prepare(
      `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, to_tank_id, quantity)
       VALUES ('R2609-1001', '2026-09-01', '受入', ?, 20)`
    ).run(RAW_TANK);
  }));
});

test.after(async () => {
  await harness.teardown();
});

const monitor = async (query = '') =>
  (await api('GET', `/api/tanks/monitor${query}`)).body;

test('容器IDの接頭辞で3つに分かれる（容器種別では分けられない）', () => {
  assert.equal(tankKind('SP-001'), '原酒');
  assert.equal(tankKind('U-003'), '残渣');
  assert.equal(tankKind('T-001'), '浄酎');
  assert.equal(tankKind('JP-013'), '浄酎');
  // 一斗瓶は T- で採番されているが、中身は浄酎
  assert.equal(tankKind('T-004'), '浄酎');
  assert.equal(tankKind('DISTL-01'), '浄酎');
});

test('kind を付けないと、今までどおり全件返す', async () => {
  const all = await monitor();
  assert.equal(all.length, 8, '既定を変えると、呼んでいない画面が黙って壊れる');
});

test('kind=浄酎 で、原酒ポリと残渣タンクが消える', async () => {
  const rows = await monitor(`?kind=${encodeURIComponent('浄酎')}`);
  const codes = rows.map((r) => r.code);

  assert.deepEqual(codes, ['B-001', 'JP-003', 'Q-001', 'T-001', 'T-004']);
  assert.ok(!codes.some((c) => c.startsWith('SP-')), '原酒ポリが残っています');
  assert.ok(!codes.some((c) => c.startsWith('U-')), '残渣タンクが残っています');
});

test('kind=原酒 / kind=残渣 でも絞れる', async () => {
  const raw = await monitor(`?kind=${encodeURIComponent('原酒')}`);
  assert.deepEqual(raw.map((r) => r.code), ['SP-001', 'SP-002']);

  const residue = await monitor(`?kind=${encodeURIComponent('残渣')}`);
  assert.deepEqual(residue.map((r) => r.code), ['U-001']);
});

test('知らない kind が来ても落とさず、全件返す', async () => {
  const res = await api('GET', '/api/tanks/monitor?kind=' + encodeURIComponent('でたらめ'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 8);
});

test('返す行に kind が入っている', async () => {
  const all = await monitor();
  const byCode = Object.fromEntries(all.map((r) => [r.code, r.kind]));
  assert.equal(byCode['SP-001'], '原酒');
  assert.equal(byCode['U-001'], '残渣');
  assert.equal(byCode['JP-003'], '浄酎');
});

test('原酒タンクを浄酎の棚卸に出すと422で、台帳に1行も増えない', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM tank_ledger').get().c;

  const { status, body } = await api('POST', '/api/stocktaking/tanks', {
    tankId: RAW_TANK,
    actualVolumeL: 20,
  });

  assert.equal(status, 422);
  assert.match(body.message, /原酒タンクです/);
  assert.match(body.message, /原酒タンクの棚卸/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tank_ledger').get().c, before);
});

test('残渣タンクも同じく断る', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM tank_ledger').get().c;

  const { status, body } = await api('POST', '/api/stocktaking/tanks', {
    tankId: RESIDUE_TANK,
    actualVolumeL: 10,
  });

  assert.equal(status, 422);
  assert.match(body.message, /残渣タンクです/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tank_ledger').get().c, before);
});

test('浄酎タンクの棚卸は今までどおり通る', async () => {
  const { status, body } = await api('POST', '/api/stocktaking/tanks', {
    tankId: JOCHU_TANK,
    actualVolumeL: 480,
  });

  assert.equal(status, 201);
  assert.equal(body.theoretical, 500);
  assert.equal(body.diff, -20);
  assert.equal(body.txnType, '欠減');
  assert.equal(body.after.current_volume_l, 480);
});

test('原酒タンクの一覧に、浄酎の容器が混ざらない', async () => {
  // v_raw_sake_tank_volume は tanks.initial_volume_l を起点にするので、
  // 「残量が0より大きい容器」で拾うと、移行時に浄酎が入っていた容器まで
  // 原酒として並ぶ（実データで ステンレスタンク1 84L など5本）。
  const { status, body } = await api('GET', '/api/raw-sake-receipts/tanks');

  assert.equal(status, 200);
  const codes = body.map((r) => r.code);
  assert.deepEqual(codes, ['SP-001', 'SP-002']);
  assert.ok(
    !codes.some((c) => !c.startsWith('SP-')),
    '浄酎の容器が原酒タンクとして出ています（蒸留の投入元にも同じ口を使っている）'
  );
});

test('初期在庫を持つ浄酎タンクがあっても、原酒の一覧には出ない', async () => {
  // T-001 は initial_volume_l = 500。原酒台帳には1行も無い
  const before = db
    .prepare("SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE code = 'T-001'")
    .get();
  assert.equal(before.current_volume_l, 500, 'ビューの計算は変えていない');

  const { body } = await api('GET', '/api/raw-sake-receipts/tanks');
  assert.ok(!body.some((r) => r.code === 'T-001'));
});

// --- 中身の種類を列で持つ（0028） -------------------------------------------
//
// 原酒入荷の受入先と蒸留の投入元は容器IDの接頭辞 SP- で絞っていた。そのため
// 「原酒を入れる別の容器（QBテナー・樽など）」を登録しても、登録はできるのに
// 両画面に一切出てこなかった（よしのやの雲山を使った蒸留が記録できなかった）。

/** マスタからタンクを1本登録する */
const addTank = (body) => api('POST', '/api/tanks', body);

test('中身=原酒で登録すれば、SP- でない容器も原酒入荷の受入先に出る', async () => {
  // 対で見るため、まず中身=浄酎で登録した同種の容器が出ないことを確かめる
  const jochu = await addTank({
    code: 'Q-800', name: 'テナー800', containerType: 'QBテナー',
    contentsKind: '浄酎', maxVolumeL: 1000,
  });
  assert.equal(jochu.status, 201);

  const genshu = await addTank({
    code: 'Q-900', name: 'テナー900', containerType: 'QBテナー',
    contentsKind: '原酒', maxVolumeL: 1000,
  });
  assert.equal(genshu.status, 201);

  const { body } = await api('GET', '/api/raw-sake-receipts/tanks/receivable');
  const codes = body.map((t) => t.code);
  assert.ok(codes.includes('Q-900'), '中身=原酒の容器が受入先に出ていません');
  assert.ok(!codes.includes('Q-800'), '中身=浄酎の容器が受入先に混ざっています');
});

test('その容器に原酒入荷ができ、蒸留の投入元にも出る', async () => {
  const tank = (await api('GET', '/api/tanks')).body.find((t) => t.code === 'Q-900');

  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-10-08', toTankId: tank.id, quantity: 300,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const source = (await api('GET', '/api/raw-sake-receipts/tanks')).body
    .find((t) => t.code === 'Q-900');
  assert.ok(source, '蒸留の投入元に出ていません');
  assert.equal(source.current_volume_l, 300);
});

test('中身=原酒の容器は、浄酎のモニターに出ない', async () => {
  // 原酒の残量は raw_sake_ledger から出るので、浄酎に混ぜると必ず 0L で並ぶ
  const rows = await monitor(`?kind=${encodeURIComponent('浄酎')}`);
  assert.ok(!rows.map((r) => r.code).includes('Q-900'));
  assert.ok(rows.map((r) => r.code).includes('Q-800'), '中身=浄酎の容器は浄酎側に出ること');
});

test('contents_kind が未設定の既存行は、容器IDの接頭辞で扱われる', async () => {
  // 移行ローダー（scripts/loaders/tanks.js）は contents_kind を入れずにタンクを作る。
  // 列だけで絞ると、業務データを入れ直した直後に全容器が画面から消える
  const raw = db.prepare('SELECT contents_kind FROM tanks WHERE code = ?').get('SP-001');
  assert.equal(raw.contents_kind, null, '前提: 試験データは列を持たない');

  const codes = (await api('GET', '/api/raw-sake-receipts/tanks/receivable')).body
    .map((t) => t.code);
  assert.ok(codes.includes('SP-001'), 'SP- の容器が原酒として扱われていません');
  assert.ok(!codes.includes('JP-003'), 'JP- の容器が原酒に混ざっています');
});

test('中身の種類は 浄酎/原酒/残渣 以外を受け付けない', async () => {
  const res = await addTank({
    code: 'Q-901', name: 'テナー901', containerType: 'QBテナー', contentsKind: '原料',
  });
  assert.equal(res.status, 400);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tanks WHERE code = ?').get('Q-901').n,
    0,
    '弾いたのに行が残っています'
  );
});

test('入出庫の記録があると中身の種類は変えられない（無ければ変えられる）', async () => {
  const tanks = (await api('GET', '/api/tanks')).body;
  const used = tanks.find((t) => t.code === 'Q-900');   // 前の試験で原酒を受け入れた
  const unused = tanks.find((t) => t.code === 'Q-800'); // 記録なし

  // 記録が無い容器は直せる（打ち間違いを直す道は残す）
  const ok = await api('PUT', `/api/tanks/${unused.id}`, { contentsKind: '残渣' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.contents_kind, '残渣');

  // 記録がある容器は止める
  const ng = await api('PUT', `/api/tanks/${used.id}`, { contentsKind: '浄酎' });
  assert.equal(ng.status, 422);
  assert.match(ng.body.message, /中身の種類を変えられません/);
  assert.equal(
    db.prepare('SELECT contents_kind FROM tanks WHERE id = ?').get(used.id).contents_kind,
    '原酒',
    '止めたのに列が書き換わっています'
  );
});

test('返却（廃棄）した容器は、受入先と投入元から消える', async () => {
  const tank = (await api('GET', '/api/tanks')).body.find((t) => t.code === 'Q-900');

  // 中身が残っているうちは廃棄できない（原酒は v_tank_monitor では 0L に見える）
  const tooEarly = await api('POST', `/api/tanks/${tank.id}/discard`, { reason: '返却' });
  assert.equal(tooEarly.status, 422);
  assert.match(tooEarly.body.message, /残量/);

  // 空にしてから返却する
  const emptied = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    txnDate: '2026-10-09', tankId: tank.id, actualVolumeL: 0, reason: '蒸留に全量投入',
  });
  assert.equal(emptied.status, 201, JSON.stringify(emptied.body));
  const discarded = await api('POST', `/api/tanks/${tank.id}/discard`, { reason: '返却' });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));

  const receivable = (await api('GET', '/api/raw-sake-receipts/tanks/receivable')).body;
  const source = (await api('GET', '/api/raw-sake-receipts/tanks')).body;
  assert.ok(!receivable.map((t) => t.code).includes('Q-900'), '受入先に残っています');
  assert.ok(!source.map((t) => t.code).includes('Q-900'), '投入元に残っています');
});

// --- 容器IDの採番（入荷ごとに増える容器） -----------------------------------

const nextCode = async (query) =>
  (await api('GET', `/api/tanks/next-code?${new URLSearchParams(query)}`)).body;

test('入荷年月を入れると、その月の連番で採番する', async () => {
  const first = await nextCode({ containerType: 'QBテナー', receivedYm: '2026-10' });
  assert.equal(first.code, 'Q-2610-01');

  await addTank({ code: first.code, name: '雲山テナー1', containerType: 'QBテナー', contentsKind: '原酒' });
  const second = await nextCode({ containerType: 'QBテナー', receivedYm: '2026-10' });
  assert.equal(second.code, 'Q-2610-02');

  // 月が変わったら 01 に戻る（いつ入ってきた器かが容器IDで分かる）
  assert.equal((await nextCode({ containerType: 'QBテナー', receivedYm: '2026-11' })).code, 'Q-2611-01');
});

test('年月入りの採番は、昔の連番（Q-001）と混ざらない', async () => {
  // Q-001 と Q-2610-01 がある状態。両方向を見ないと空振りする
  // 年月なしは昔どおり Q + 連番。既にある Q-900 の次なので Q-901。
  // Q-2610-01 を拾っていたら Q-2611 のような数字になる
  assert.equal(
    (await nextCode({ containerType: 'QBテナー' })).code,
    'Q-901',
    '年月なしの採番が Q-2610-01 を拾っています'
  );
  assert.equal(
    (await nextCode({ containerType: 'QBテナー', receivedYm: '2026-10' })).code,
    'Q-2610-02',
    '年月入りの採番が Q-001 を拾っています'
  );
});

test('採番表に無い容器種別でも、中身の種類から採番できる', async () => {
  // 以前はここで422になり、容器IDを自分で考えるしかなかった
  const res = await api(
    'GET',
    `/api/tanks/next-code?containerType=${encodeURIComponent('ステンレス角タンク')}` +
      `&contentsKind=${encodeURIComponent('原酒')}`
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.prefix, 'SP');
  assert.match(res.body.code, /^SP-\d+$/);

  // 種別も中身も分からないときは、今までどおり断る
  const unknown = await api('GET', '/api/tanks/next-code?containerType=なぞの容器');
  assert.equal(unknown.status, 422);
});
