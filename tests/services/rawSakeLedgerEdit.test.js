// 原料受払記録を一覧で見られること、取り消し・編集ができること。
//
// この台帳は画面から一切見えず、直す手段も無かった（一覧のAPIはあったが、
// どの画面からも呼ばれていなかった）。#44 で原酒タンクの棚卸を作ったので、
// 入った行を見て、間違えたら直せる必要がある。
//
// いちばん気をつけるのは**蒸留が作った行**。払出はすべて distillation_id を持ち、
// distillation_details からも参照されている。蒸留明細を直すと払出行は取り消して
// 入れ直されるので、ここで直しても蒸留を直した瞬間に食い違う。
// 明細取消の「戻し」受入も distillation_id を持つので、同じ条件で守れる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-rawsake-ledger-edit.sqlite');
const api = harness.api;

let db;

// タンクのid。seedで入れた順に決まる
const SP1 = 1; // SP-001 原酒ポリ1
const SP2 = 2; // SP-002 原酒ポリ2
const SP3 = 3; // SP-003 原酒ポリ3（マイナスにする）
const JOCHU = 4; // T-001 浄酎タンク1

const volume = (tankId) =>
  db.prepare('SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(tankId)
    .current_volume_l;
const row = (id) => db.prepare('SELECT * FROM raw_sake_ledger WHERE id = ?').get(id);
const byLot = (lot) => db.prepare('SELECT * FROM raw_sake_ledger WHERE lot_code = ?').get(lot);
const logs = (action) =>
  db.prepare('SELECT * FROM operation_logs WHERE action = ? ORDER BY id DESC').all(action);

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    for (const [code, name, type, max] of [
      ['SP-001', '原酒ポリ1', '原酒ポリタンク', 200],
      ['SP-002', '原酒ポリ2', '原酒ポリタンク', 200],
      ['SP-003', '原酒ポリ3', '原酒ポリタンク', 200],
      ['T-001', '浄酎タンク1', 'ステンレスタンク', 1000],
    ]) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(generateUid(db, 'tanks'), code, name, type, max);
    }
    db.prepare(
      `INSERT INTO raw_sake_brands (uid, code, name, abv) VALUES (?, 'toriya-BYR6-L1', '浄酎用池月', 18.3)`
    ).run(generateUid(db, 'raw_sake_brands'));
    db.prepare(
      `INSERT INTO raw_sake_brands (uid, code, name, abv) VALUES (?, 'toriya-BYR6-L2', '別の銘柄', 18.8)`
    ).run(generateUid(db, 'raw_sake_brands'));
  }));

  // 原酒入荷（受入）を2件。SP-003 は蒸留に使って払出を作る
  await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-01', toTankId: SP1, quantity: 100, rawSakeBrandId: 1, supplier: '鳥屋酒造',
  });
  await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-01', toTankId: SP3, quantity: 60, rawSakeBrandId: 1,
  });
  await api('POST', '/api/distillations', {
    startedOn: '2026-07-02', startedTime: '09:00', items: [{ tankId: SP3, volumeL: 60 }],
  });
});

test.after(async () => {
  await harness.teardown();
});

// --- 一覧 ---

test('一覧が見られる。区分・タンク・取消済みで絞れる', async () => {
  const all = await api('GET', '/api/raw-sake-receipts');
  assert.equal(all.status, 200);
  assert.equal(all.body.length, 3, '受入2件＋払出1件');
  assert.ok(all.body[0].to_tank_name || all.body[0].from_tank_name, 'タンク名が出ること');

  const receipts = await api('GET', '/api/raw-sake-receipts?txnType=受入');
  assert.equal(receipts.body.length, 2);

  const byTank = await api('GET', `/api/raw-sake-receipts?tankId=${SP3}`);
  assert.equal(byTank.body.length, 2, 'SP-003 の受入と払出');

  const alive = await api('GET', '/api/raw-sake-receipts?cancelled=false');
  assert.equal(alive.body.length, 3);
});

// --- 蒸留が作った行は触らせない ---

test('蒸留の払出は編集も取消も422で、蒸留IDを教える', async () => {
  const payout = db.prepare("SELECT * FROM raw_sake_ledger WHERE txn_type = '払出'").get();
  const before = row(payout.id);

  const patch = await api('PATCH', `/api/raw-sake-receipts/ledger/${payout.id}`, { quantity: 30 });
  assert.equal(patch.status, 422);
  assert.match(patch.body.message, /蒸留 D/, 'どの蒸留か分かること');
  assert.match(patch.body.message, /蒸留タブ/);

  const cancel = await api('POST', `/api/raw-sake-receipts/ledger/${payout.id}/cancel`, {
    reason: '間違い',
  });
  assert.equal(cancel.status, 422);
  assert.deepEqual(row(payout.id), before, '行が1文字も変わっていないこと');
});

test('蒸留明細を取り消したときの「戻し」受入も触らせない', async () => {
  const detail = db.prepare('SELECT * FROM distillation_details LIMIT 1').get();
  const cancelled = await api('POST', `/api/distillations/details/${detail.id}/cancel`, {
    reason: '入れ間違い',
  });
  assert.equal(cancelled.status, 200);

  const restore = db
    .prepare("SELECT * FROM raw_sake_ledger WHERE txn_type = '受入' AND distillation_id IS NOT NULL")
    .get();
  assert.ok(restore, '戻しの受入が入ること');

  const { status, body } = await api('PATCH', `/api/raw-sake-receipts/ledger/${restore.id}`, {
    quantity: 10,
  });
  assert.equal(status, 422, '戻しの受入も蒸留の記録なので触らせない');
  assert.match(body.message, /蒸留/);
});

// --- 原酒入荷の編集 ---

test('受入の数量を直すと残量が動き、原酒受払IDは変わらない', async () => {
  const receipt = byLot('R2607-1001');
  assert.equal(volume(SP1), 100);

  const { status, body } = await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, {
    quantity: 80,
  });
  assert.equal(status, 200);
  assert.equal(volume(SP1), 80);
  assert.equal(row(receipt.id).lot_code, 'R2607-1001', '番号は台帳の名前なので動かさない');
  assert.deepEqual(Object.keys(body.changes), ['quantity']);
});

test('月をまたぐ日付に直しても原酒受払IDはそのまま', async () => {
  const receipt = byLot('R2607-1001');
  const { status } = await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, {
    txnDate: '2026-09-02',
  });
  assert.equal(status, 200);
  assert.equal(row(receipt.id).txn_date, '2026-09-02');
  assert.equal(row(receipt.id).lot_code, 'R2607-1001');
});

test('受入は銘柄・スペック・受入元も直せる', async () => {
  const receipt = byLot('R2607-1001');
  const { status } = await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, {
    brandId: 2,
    specNote: 'BYR6 別ロット',
    sourceRef: '鳥屋酒造（2便目）',
    note: '受入元を直した',
  });
  assert.equal(status, 200);

  const after = row(receipt.id);
  assert.equal(after.raw_sake_brand_id, 2);
  assert.equal(after.spec_note, 'BYR6 別ロット');
  assert.equal(after.source_ref, '鳥屋酒造（2便目）');
  assert.equal(after.note, '受入元を直した');
});

test('タンク・区分・原酒受払IDを送ると400', async () => {
  const receipt = byLot('R2607-1001');
  for (const payload of [{ toTankId: 2 }, { txnType: '払出' }, { lotCode: 'R9999-0001' }]) {
    const { status } = await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, payload);
    assert.equal(status, 400, `${JSON.stringify(payload)} は受け付けないこと`);
  }
});

test('直す項目が無ければ400、数量を0以下にはできない', async () => {
  const receipt = byLot('R2607-1001');
  assert.equal((await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, {})).status, 400);
  for (const quantity of [0, -5]) {
    const { status } = await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, { quantity });
    assert.equal(status, 400);
  }
});

// --- 棚卸の行 ---

test('棚卸で入った行を直せる。数量を直すと備考に跡が足される', async () => {
  const st = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP1, actualVolumeL: 70, txnDate: '2026-09-10', reason: '検尺',
  });
  assert.equal(st.status, 201);
  assert.equal(st.body.txnType, '欠減');

  const { status } = await api('PATCH', `/api/raw-sake-receipts/ledger/${st.body.ledgerId}`, {
    quantity: 5,
  });
  assert.equal(status, 200);

  const after = row(st.body.ledgerId);
  assert.equal(after.quantity, 5);
  assert.match(after.note, /棚卸: 理論80L → 実測70L/, '元の備考は消さない');
  assert.match(after.note, /編集: 数量 10 → 5/, '備考と数量を食い違わせない');
  assert.equal(volume(SP1), 75, '80 - 5');
});

test('棚卸の行に銘柄・スペック・受入元は付けられない', async () => {
  const st = db.prepare("SELECT * FROM raw_sake_ledger WHERE txn_type = '欠減'").get();
  const { status, body } = await api('PATCH', `/api/raw-sake-receipts/ledger/${st.id}`, {
    brandId: 1,
  });
  assert.equal(status, 422);
  assert.match(body.message, /受入にだけ付きます/);
});

// --- 残量の守り ---

test('残量を前より悪くマイナスにする編集は422で、台帳は変わらない', async () => {
  // SP-002 を、台帳のうえでマイナスにしておく（実データの原酒ポリ2と同じ形）
  db.prepare(
    `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, from_tank_id, quantity)
     VALUES ('R2609-0090', '2026-09-11', '欠減', ?, 20)`
  ).run(SP2);
  assert.equal(volume(SP2), -20);

  const target = byLot('R2609-0090');
  const before = row(target.id);
  const { status, body } = await api('PATCH', `/api/raw-sake-receipts/ledger/${target.id}`, {
    quantity: 500,
  });
  assert.equal(status, 422);
  assert.match(body.message, /原酒ポリ2の残量/);
  assert.deepEqual(row(target.id), before, '断ったなら1文字も書き換わっていないこと');
  assert.equal(volume(SP2), -20);
});

// --- 取り消し ---

test('蒸留に引き当てられている受入は取り消せない', async () => {
  // R2607-1002 の60Lは蒸留に払い出されている。明細を取り消しても払出の行は残り
  // （液体は一度出て、戻しの受入として入り直す）、引当はそのまま生きている
  const used = byLot('R2607-1002');
  const before = row(used.id);

  const { status, body } = await api('POST', `/api/raw-sake-receipts/ledger/${used.id}/cancel`, {
    reason: '間違いだった',
  });
  assert.equal(status, 409);
  assert.match(body.message, /引き当てられています/);
  assert.match(body.message, /D2607-0001/, 'どの蒸留か分かること');
  assert.deepEqual(row(used.id), before, '行が1文字も変わっていないこと');
});

test('引き当てられていない受入を取り消すと残量が戻り、数量の値は書き換わらない', async () => {
  // 使っていない受入を1件入れて、それを取り消す
  const added = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-01', toTankId: SP2, quantity: 40,
  });
  assert.equal(added.status, 201);
  const receipt = db.prepare('SELECT * FROM raw_sake_ledger ORDER BY id DESC LIMIT 1').get();
  assert.equal(receipt.lot_code, 'R2607-1003');

  const before = volume(SP2);
  const { status, body } = await api('POST', `/api/raw-sake-receipts/ledger/${receipt.id}/cancel`, {
    reason: '二重に登録していた',
  });
  assert.equal(status, 200);
  assert.equal(volume(SP2), before - 40);

  const after = row(receipt.id);
  assert.equal(after.is_cancelled, 1);
  assert.equal(after.cancel_reason, '二重に登録していた');
  assert.ok(after.cancelled_at);
  assert.equal(after.quantity, 40, '数量は書き戻さない（ビューが取消済みを0として数える）');
  assert.equal(body.volume.current_volume_l, volume(SP2));
});

test('取消理由が無ければ400／二重取消は409／取消済みの編集も409／存在しないidは404', async () => {
  const receipt = byLot('R2607-1003');

  for (const payload of [{}, { reason: '' }]) {
    const { status } = await api('POST', `/api/raw-sake-receipts/ledger/${receipt.id}/cancel`, payload);
    assert.equal(status, 400);
  }

  const again = await api('POST', `/api/raw-sake-receipts/ledger/${receipt.id}/cancel`, {
    reason: 'もう一度',
  });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /既に取消済み/);

  const patch = await api('PATCH', `/api/raw-sake-receipts/ledger/${receipt.id}`, { quantity: 10 });
  assert.equal(patch.status, 409);

  assert.equal((await api('GET', '/api/raw-sake-receipts/ledger/9999')).status, 404);
  assert.equal((await api('PATCH', '/api/raw-sake-receipts/ledger/9999', { quantity: 1 })).status, 404);
  assert.equal(
    (await api('POST', '/api/raw-sake-receipts/ledger/9999/cancel', { reason: 'x' })).status,
    404
  );
});

// --- 採番（ここを間違えると INSERT が落ちる） ---

test('取り消した行の原酒受払IDは、次の採番で再利用されない', async () => {
  assert.equal(byLot('R2607-1003').is_cancelled, 1, '前提: R2607-1003 は取消済み');

  // 同じ月・同じ日付に受け入れると、取消済みの番号を飛ばした続きになる。
  // lot_code は UNIQUE なので、取消済みを採番から外すと INSERT が落ちる
  const { status } = await api('POST', '/api/raw-sake-receipts', {
    txnDate: '2026-07-01', toTankId: SP2, quantity: 20,
  });
  assert.equal(status, 201);

  const fresh = db.prepare('SELECT lot_code FROM raw_sake_ledger ORDER BY id DESC LIMIT 1').get();
  assert.notEqual(fresh.lot_code, 'R2607-1003', '取り消した番号を採り直さないこと');
  assert.equal(fresh.lot_code, 'R2607-1004');
});

// --- 取消済みの扱い（絞る／絞らない の仕分け） ---

test('取消済みは残量から外れるが、一覧には状態つきで出る', async () => {
  const list = await api('GET', '/api/raw-sake-receipts?cancelled=true');
  assert.ok(list.body.length >= 1, '取消済みだけを引ける');
  assert.ok(list.body.every((r) => r.is_cancelled === 1));
  assert.ok(list.body[0].cancel_reason, '理由も出ること');
});

test('「直近の受入」に取消済みが出ない', async () => {
  const { status, body } = await api('GET', `/api/raw-sake-receipts/tanks/${SP3}/receipt-check`);
  assert.equal(status, 200);
  assert.notEqual(body.lastReceipt?.lot_code, 'R2607-1002', '取消した受入を直近と言わない');
});

test('ロット追跡の内訳の合計が、全タンクで残量と一致し続ける', async () => {
  const { status, body } = await api('GET', '/api/lots/raw-sake?includeEmpty=1');
  assert.equal(status, 200);

  // 台帳の払出が受入を上回っているタンクは、take() が内訳をマイナスにしない守りのため
  // 元から食い違う（#44 と同じ理由）。素直なタンクで不変条件を見張る
  for (const tank of body.filter((t) => t.currentVolumeL >= 0)) {
    const sum = tank.lots.reduce((n, l) => n + l.volumeL, 0);
    assert.ok(
      Math.abs(sum - tank.currentVolumeL) < 0.001,
      `${tank.code} の内訳 ${sum}L が残量 ${tank.currentVolumeL}L と一致すること`
    );
  }
});

// --- 修正履歴と操作ログ ---

test('取り消した原酒の行が、修正履歴に出る', async () => {
  const { status, body } = await api('GET', '/api/corrections');
  assert.equal(status, 200);

  const found = body.find((r) => r.target_code === 'R2607-1003');
  assert.ok(found, '原料受払記録の取消として出ること');
  assert.equal(found.target_type, '原料受払記録');
  assert.equal(found.reason, '二重に登録していた');
  assert.match(found.action, /受入 40(\.0)?L を取消/);
});

test('操作ログに、変える前と後の値が残る', () => {
  const update = logs('rawSake.ledger.update').at(-1); // いちばん古い＝最初の数量の編集
  assert.ok(update);
  assert.equal(update.target_type, 'raw_sake_ledger');
  assert.match(update.summary, /R2607-1001/);

  const detail = JSON.parse(update.detail_json);
  assert.equal(detail.changes.quantity.from, 100);
  assert.equal(detail.changes.quantity.to, 80);
  assert.equal(detail.volumeBefore, 100);
  assert.equal(detail.volumeAfter, 80);

  const cancel = logs('rawSake.ledger.cancel')[0];
  assert.ok(cancel);
  assert.match(cancel.summary, /理由: 二重に登録していた/);
});
