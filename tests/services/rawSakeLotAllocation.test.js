// 原酒の受入ロット ↔ 蒸留への払出の引き当て。
//
// 瓶詰め→箱詰めは wip_lot_allocations で「どの瓶詰めロットの何本をどの箱詰めに
// 使ったか」を持っているが、原酒には同じものが無かった。払出行は投入元タンクを
// 持つだけで、**そのタンクの中のどの受入ロットを使ったかは記録に無い**
// （lotTraceService が銘柄別に按分して推定しているだけ）。
//
// 実データの原酒ポリは「空にしてから次を入れる」運用なので、古い順に引き当てれば
// ほとんどが一意に決まる（払出79件のうち73件が受入ロット1件で決まった）。
// ただし**引き当てようがない行が実在する**（投入元タンクが空欄の R2606-1001 /
// R2606-1002）。そこで止めると蒸留の登録そのものができなくなるので、
// 引けたぶんだけ引いて残りは「未紐付け」として画面に出す。ここを試す。
//
// 原酒受払IDは決め打ちにしない。採番は帯（千の位＝その月の何回目の移入か）で
// 決まるので、試験の中で日付を足すと番号が動く。登録が返したidで引く。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-rawsake-lot-allocation.sqlite');
const api = harness.api;

let db;

// タンクのid。seedで入れた順に決まる
const SP1 = 1; // SP-001 古い順の引き当てを見る
const SP2 = 2; // SP-002 複数ロットにまたがる払出／明細取消のあとの引き当て
const SP3 = 3; // SP-003 在庫が足りない払出を見る

const row = (id) => db.prepare('SELECT * FROM raw_sake_ledger WHERE id = ?').get(id);

/** 払出1件の引当内訳（引当元の行のidと量） */
const allocationsOf = (payoutId) =>
  db
    .prepare(
      `SELECT a.receipt_ledger_id AS receiptId, a.quantity
         FROM raw_sake_lot_allocations a
         JOIN raw_sake_ledger r ON r.id = a.receipt_ledger_id
        WHERE a.payout_ledger_id = ?
        ORDER BY r.txn_date, r.id`
    )
    .all(payoutId);

const allocationCount = () =>
  db.prepare('SELECT COUNT(*) AS n FROM raw_sake_lot_allocations').get().n;

/** その蒸留が作った払出の行 */
const payoutOf = (distillationCode) =>
  db
    .prepare(
      `SELECT l.* FROM raw_sake_ledger l
         JOIN distillations d ON d.id = l.distillation_id
        WHERE d.distillation_code = ? AND l.txn_type = '払出'
        ORDER BY l.id`
    )
    .all(distillationCode);

/** 原酒入荷を1件入れて、その台帳のidを返す */
async function receive(tankId, quantity, txnDate) {
  const res = await api('POST', '/api/raw-sake-receipts', {
    txnDate, toTankId: tankId, quantity, rawSakeBrandId: 1,
  });
  assert.equal(res.status, 201, `原酒入荷が入ること (${txnDate} ${quantity}L)`);
  return res.body.rawSakeLedgerId;
}

/** 蒸留を1件はじめて、その払出の行を返す */
async function distill(tankId, volumeL, startedOn, startedTime = '09:00') {
  const res = await api('POST', '/api/distillations', {
    startedOn, startedTime, items: [{ tankId, volumeL }],
  });
  assert.equal(res.status, 201, `蒸留が登録できること (${startedOn} ${volumeL}L)`);
  const payouts = payoutOf(res.body.distillationCode);
  assert.equal(payouts.length, 1);
  return { distillation: res.body, payout: payouts[0] };
}

// 試験どうしで使い回す行のid
let sp1Old;
let sp1New;
let orphanId;
let legacyId;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    for (const [code, name, max] of [
      ['SP-001', '原酒ポリ1', 200],
      ['SP-002', '原酒ポリ2', 200],
      ['SP-003', '原酒ポリ3', 200],
    ]) {
      db.prepare(
        `INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l)
         VALUES (?, ?, ?, '原酒ポリタンク', ?, 0)`
      ).run(generateUid(db, 'tanks'), code, name, max);
    }
    db.prepare(
      `INSERT INTO raw_sake_brands (uid, code, name, abv) VALUES (?, 'toriya-BYR6-L1', '浄酎用池月', 18.3)`
    ).run(generateUid(db, 'raw_sake_brands'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

// --- 古い順に引き当てる（実データと同じ形: 受入20L → 払出10L×2） ---

test('新しい蒸留は、古い受入ロットから順に自動で引き当てられる', async () => {
  // 実データの SP-008 と同じ時系列。原酒ポリは「空にしてから次を入れる」運用なので、
  // 画面からは前の原酒が残っているタンクに入れられない（使用中で弾かれる）
  sp1Old = await receive(SP1, 20, '2026-03-19');

  // 10Lずつ2回出す。どちらも古いロットから引かれる
  const d1 = await distill(SP1, 10, '2026-07-01', '09:00');
  const d2 = await distill(SP1, 10, '2026-07-01', '13:00');

  assert.deepEqual(allocationsOf(d1.payout.id), [{ receiptId: sp1Old, quantity: 10 }]);
  assert.deepEqual(allocationsOf(d2.payout.id), [{ receiptId: sp1Old, quantity: 10 }],
    '同じ受入ロットから、残っているぶんだけ引かれること');

  // 空になったので次のロットを入れられる。以降はそちらから引かれる
  sp1New = await receive(SP1, 20, '2026-06-25');
  const d3 = await distill(SP1, 5, '2026-07-02');
  assert.deepEqual(allocationsOf(d3.payout.id), [{ receiptId: sp1New, quantity: 5 }],
    '尽きた古いロットではなく、残っているロットから引くこと');
});

test('1つの払出が複数の受入ロットにまたがっても、合計は払出量と一致する', async () => {
  // 1つのタンクに2つの受入ロットが同時にある形は、画面からは作れない（使用中で弾かれる）。
  // 移行した実データにはこの形が2件あるので、同じように台帳へ直に入れる
  const insert = db.prepare(
    `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, quantity, to_tank_id, raw_sake_brand_id)
     VALUES (?, ?, '受入', ?, ?, 1)`
  );
  const first = Number(insert.run('R2603-8001', '2026-03-01', 12, SP2).lastInsertRowid);
  const second = Number(insert.run('R2603-8002', '2026-03-02', 18, SP2).lastInsertRowid);

  // 15L 出す。**古い12Lを使い切ってから、新しいほうから3L**でなければならない。
  // 30L（＝両方まるごと）にすると、どちらから引いても内訳が同じになって
  // 古い順かどうかを確かめられない
  const { payout } = await distill(SP2, 15, '2026-07-03');
  const rows = allocationsOf(payout.id);

  assert.equal(rows.length, 2, '2本のロットにまたがること');
  assert.deepEqual(rows, [
    { receiptId: first, quantity: 12 },
    { receiptId: second, quantity: 3 },
  ], '古いロットを使い切ってから、新しいロットに手を付けること');
  assert.equal(rows.reduce((s, r) => s + r.quantity, 0), 15, '合計が払出量と一致すること');

  // 残りは新しいロットの15L。次の払出はそこから全部引ける
  const next = await distill(SP2, 15, '2026-07-04');
  assert.deepEqual(allocationsOf(next.payout.id), [{ receiptId: second, quantity: 15 }]);
});

// --- 引き当てられないときも蒸留は止めない ---

test('在庫が足りないときは引けるぶんだけ引き当て、蒸留は止めない', async () => {
  // 受入10Lしか無いタンクを棚卸で15Lに直してから、15L出す。
  // 棚卸調整は受入ロットではないので、引き当てられるのは10Lまで
  const receipt = await receive(SP3, 10, '2026-07-04');
  const st = await api('POST', '/api/stocktaking/raw-sake-tanks', {
    tankId: SP3, actualVolumeL: 15, txnDate: '2026-07-05',
  });
  assert.equal(st.status, 201, '棚卸で15Lに直す');

  const { payout } = await distill(SP3, 15, '2026-07-06');
  assert.deepEqual(allocationsOf(payout.id), [{ receiptId: receipt, quantity: 10 }],
    '受入ロットのぶんだけ引けること');

  // 足りなかったぶんは未紐付けとして画面に出る
  const unlinked = await api('GET', '/api/raw-sake-receipts/ledger/unlinked');
  assert.equal(unlinked.status, 200);
  const target = unlinked.body.find((r) => r.id === payout.id);
  assert.ok(target, '足りなかった払出が未紐付けに出ること');
  assert.equal(target.remaining, 5, '残り5Lが未引当であること');
});

test('投入元タンクが空欄の払出は引き当てず、未紐付けとして残る', async () => {
  // 実データの R2606-1001 / R2606-1002 と同じ形。APIからは作れないので直に入れる
  orphanId = Number(
    db
      .prepare(
        `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, quantity, from_tank_id)
         VALUES ('R2606-9001', '2026-06-10', '払出', 7, NULL)`
      )
      .run().lastInsertRowid
  );

  const unlinked = await api('GET', '/api/raw-sake-receipts/ledger/unlinked');
  const orphan = unlinked.body.find((r) => r.id === orphanId);
  assert.ok(orphan, '未紐付けに出ること');
  assert.equal(orphan.from_tank_id, null);
  assert.deepEqual(orphan.suggestion, [], '引き当ての候補が出ないこと');
  assert.equal(orphan.shortage, 7);
});

// --- まとめて引き当てる（過去分の埋め込み） ---

test('backfill は未紐付けだけを埋め、埋められなかった件数を返す。2回押しても二重にならない', async () => {
  // 移行で入った形（引当行が無い払出）を作る。SP-001 の新しいロットに残りがある
  legacyId = Number(
    db
      .prepare(
        `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, quantity, from_tank_id)
         VALUES ('R2606-9002', '2026-06-26', '払出', 4, ?)`
      )
      .run(SP1).lastInsertRowid
  );

  const before = allocationCount();
  const first = await api('POST', '/api/raw-sake-receipts/ledger/backfill-allocations', {});
  assert.equal(first.status, 200);
  assert.ok(first.body.linked >= 1, '埋められる行が引き当てられること');

  const skippedOrphan = first.body.skipped.find((s) => s.lotCode === 'R2606-9001');
  assert.ok(skippedOrphan, '投入元タンクが空欄の行は、埋めずに残ること');
  assert.equal(skippedOrphan.reason, '投入元タンクが空欄');
  assert.equal(allocationsOf(orphanId).length, 0, '引き当てようがない行に何も入らないこと');

  assert.deepEqual(allocationsOf(legacyId), [{ receiptId: sp1New, quantity: 4 }],
    '移行で入った払出が、残っている受入ロットから引き当てられること');

  const afterFirst = allocationCount();
  assert.ok(afterFirst > before, '引当行が増えていること');

  // 2回目。埋まっている行には手を付けない
  const second = await api('POST', '/api/raw-sake-receipts/ledger/backfill-allocations', {});
  assert.equal(second.status, 200);
  assert.equal(allocationCount(), afterFirst, '2回押しても引当行が増えないこと');
  assert.deepEqual(allocationsOf(legacyId), [{ receiptId: sp1New, quantity: 4 }]);
});

// --- 手で直す（置き換え） ---

test('引き当ては足すのではなく置き換わる。同じ内容を2回送っても二重にならない', async () => {
  const body = { items: [{ receiptLedgerId: sp1New, quantity: 4 }] };

  const first = await api('PUT', `/api/raw-sake-receipts/ledger/${legacyId}/allocations`, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.allocations.length, 1);

  const second = await api('PUT', `/api/raw-sake-receipts/ledger/${legacyId}/allocations`, body);
  assert.equal(second.status, 200);
  assert.equal(second.body.allocations.length, 1, '2回送っても1件のままであること');
  assert.deepEqual(allocationsOf(legacyId), [{ receiptId: sp1New, quantity: 4 }]);
});

test('引当量の合計が払出量を超えたら422', async () => {
  const res = await api('PUT', `/api/raw-sake-receipts/ledger/${legacyId}/allocations`, {
    items: [{ receiptLedgerId: sp1New, quantity: 9 }],
  });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /払出量/);
  assert.deepEqual(allocationsOf(legacyId), [{ receiptId: sp1New, quantity: 4 }],
    '断られたら引当は元のままであること');
});

test('別のタンクの受入は引当元にできない', async () => {
  // SP-002 の受入を、SP-001 からの払出に当てようとする
  const otherTank = db
    .prepare(`SELECT id FROM raw_sake_ledger WHERE to_tank_id = ? AND txn_type = '受入' LIMIT 1`)
    .get(SP2);

  const res = await api('PUT', `/api/raw-sake-receipts/ledger/${legacyId}/allocations`, {
    items: [{ receiptLedgerId: otherTank.id, quantity: 1 }],
  });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /別のタンク/);
});

test('引き当てを直せるのは払出だけ。受入を指すと409', async () => {
  const res = await api('PUT', `/api/raw-sake-receipts/ledger/${sp1New}/allocations`, { items: [] });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /払出だけ/);
});

// --- 取消・編集との噛み合わせ ---

test('引き当てられている受入は取り消せない（409）', async () => {
  // sp1Old は蒸留2件に20L全部引き当て済み
  const res = await api('POST', `/api/raw-sake-receipts/ledger/${sp1Old}/cancel`, {
    reason: '入れ間違い',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /引き当てられています/);
  assert.equal(row(sp1Old).is_cancelled, 0, '行が変わっていないこと');
});

test('引当量より少ない数量には減らせない（422）', async () => {
  const res = await api('PATCH', `/api/raw-sake-receipts/ledger/${sp1Old}`, { quantity: 10 });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /引き当てられています/);
  assert.equal(row(sp1Old).quantity, 20, '数量が変わっていないこと');
});

test('引き当てられていない受入は取り消せる。取消済みは引当元の候補に出ない', async () => {
  const fresh = await receive(SP2, 25, '2026-07-20');

  const res = await api('POST', `/api/raw-sake-receipts/ledger/${fresh}/cancel`, {
    reason: '入れ間違い',
  });
  assert.equal(res.status, 200);
  assert.equal(row(fresh).is_cancelled, 1);
  assert.equal(row(fresh).quantity, 25, '数量は書き戻さないこと');

  const freshLot = row(fresh).lot_code;
  const unlinked = await api('GET', '/api/raw-sake-receipts/ledger/unlinked');
  for (const r of unlinked.body) {
    assert.ok(
      !r.suggestion.some((s) => s.lotCode === freshLot),
      '取消済みの受入が候補に出ないこと'
    );
  }
});

test('払出を取り消すと、その払出が握っていた引当も外れる', async () => {
  assert.equal(allocationsOf(legacyId).length, 1, '前提: 引当が1件ある');

  const res = await api('POST', `/api/raw-sake-receipts/ledger/${legacyId}/cancel`, {
    reason: '二重計上',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.releasedAllocations, 1, '解除した件数が返ること');
  assert.equal(allocationsOf(legacyId).length, 0, '引当行が消えていること');

  // 取り消した払出は未紐付けの一覧にも出ない
  const unlinked = await api('GET', '/api/raw-sake-receipts/ledger/unlinked');
  assert.ok(!unlinked.body.some((r) => r.id === legacyId));
});

test('蒸留明細を取り消しても引当行は残り、戻しの受入が次の引き当てに使える', async () => {
  // SP-002 を空にしてから20L入れて、まるごと蒸留に出す
  const remaining = db
    .prepare('SELECT current_volume_l FROM v_raw_sake_tank_volume WHERE tank_id = ?')
    .get(SP2).current_volume_l;
  if (remaining > 0) await distill(SP2, remaining, '2026-07-31');

  await receive(SP2, 20, '2026-08-01');
  const { payout } = await distill(SP2, 20, '2026-08-02');
  const allocated = allocationsOf(payout.id);
  assert.equal(allocated.length, 1, '引き当てられていること');

  const detail = db
    .prepare('SELECT * FROM distillation_details WHERE raw_sake_ledger_id = ?')
    .get(payout.id);
  assert.ok(detail, '明細から払出行が参照されていること');

  const cancelled = await api('POST', `/api/distillations/details/${detail.id}/cancel`, {
    reason: 'タンクを間違えた',
  });
  assert.equal(cancelled.status, 200);

  // 払出は残り、引当もそのまま（液体はもう動いている）
  assert.equal(row(payout.id).is_cancelled, 0, '払出の行は取り消されないこと');
  assert.deepEqual(allocationsOf(payout.id), allocated, '引当行が残っていること');

  // 戻しの受入が新しいロットとして入り、次の引き当てに使える
  const restore = db
    .prepare(
      `SELECT * FROM raw_sake_ledger
        WHERE to_tank_id = ? AND txn_type = '受入' AND distillation_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get(SP2);
  assert.ok(restore, '戻しの受入が入っていること');
  assert.equal(restore.quantity, 20);

  const next = await distill(SP2, 20, '2026-08-03');
  assert.deepEqual(
    allocationsOf(next.payout.id),
    [{ receiptId: restore.id, quantity: 20 }],
    '戻しの受入から引き当てられること'
  );
});

// --- 一覧に引当が出る ---

test('一覧に引当元・引当先が出る', async () => {
  const res = await api('GET', `/api/raw-sake-receipts?tankId=${SP1}`);
  assert.equal(res.status, 200);

  const receipt = res.body.find((r) => r.id === sp1Old);
  assert.equal(receipt.allocated_out, 20, '受入は引き当てた合計が出ること');
  assert.match(receipt.allocated_to_labels, /^D/, '引当先は蒸留ロット番号で出ること');

  const payout = res.body.find((r) => r.txn_type === '払出' && r.allocated_in > 0);
  assert.match(payout.allocated_from_labels, /^R/, '引当元は原酒受払IDで出ること');
});

test('取り消した払出のぶんは、受入の引当済みから外れて次に使える', async () => {
  // legacyId（4L）を取り消したので、sp1New の残りが4L戻っているはず
  const res = await api('GET', `/api/raw-sake-receipts?tankId=${SP1}`);
  const receipt = res.body.find((r) => r.id === sp1New);
  const expected = db
    .prepare(
      `SELECT COALESCE(SUM(a.quantity), 0) AS n FROM raw_sake_lot_allocations a
         JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
        WHERE a.receipt_ledger_id = ? AND p.is_cancelled = 0`
    )
    .get(sp1New).n;
  assert.equal(receipt.allocated_out, expected, '取消済みの払出を数えないこと');
  assert.ok(
    receipt.allocated_out < row(sp1New).quantity,
    '受入に引き当てられる残りがあること'
  );
});

test('取消済みの払出に引当行が残っていても、受入の残りを食わない', async () => {
  // 画面からこの状態は作れない（払出を取り消すと引当行も消える）。
  // それでも引当を数える側は取消済みを外している。**外しても試験が落ちないと
  // 気づけないので、状態のほうを直に作って確かめる**
  // （移行や将来の別経路で、取消済みの払出に引当行が残ることはありうる）。
  assert.equal(row(legacyId).is_cancelled, 1, '前提: legacyId は取消済みの払出');

  const beforeOut = (await api('GET', `/api/raw-sake-receipts?tankId=${SP1}`))
    .body.find((r) => r.id === sp1New).allocated_out;

  db.prepare(
    `INSERT INTO raw_sake_lot_allocations (payout_ledger_id, receipt_ledger_id, quantity)
     VALUES (?, ?, 4)`
  ).run(legacyId, sp1New);

  const afterOut = (await api('GET', `/api/raw-sake-receipts?tankId=${SP1}`))
    .body.find((r) => r.id === sp1New).allocated_out;
  assert.equal(afterOut, beforeOut, '一覧の引当済みが増えないこと');

  // 引当元の候補としても、その4Lは食われていない。
  // **残り全部を要求する払出**でないと差が出ない。4Lだけ頼むと、取消済みを
  // 数えてしまっていても残りが足りるので同じ答えになる
  const activeAllocated = db
    .prepare(
      `SELECT COALESCE(SUM(a.quantity), 0) AS n FROM raw_sake_lot_allocations a
         JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
        WHERE a.receipt_ledger_id = ? AND p.is_cancelled = 0`
    )
    .get(sp1New).n;
  const remaining = row(sp1New).quantity - activeAllocated;
  assert.ok(remaining > 4, '前提: 取消済みの4Lより多くの残りがある');

  const payoutId = Number(
    db
      .prepare(
        `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, quantity, from_tank_id)
         VALUES ('R2609-9003', '2026-09-01', '払出', ?, ?)`
      )
      .run(remaining, SP1).lastInsertRowid
  );
  const unlinked = await api('GET', '/api/raw-sake-receipts/ledger/unlinked');
  const target = unlinked.body.find((r) => r.id === payoutId);
  assert.ok(target, '新しい払出が未紐付けに出ること');
  assert.deepEqual(
    target.suggestion.map((s) => s.quantity),
    [remaining],
    '取消済みの引当に食われず、残り全部を引き当てられること'
  );
  assert.equal(target.shortage, 0, '取消済みのぶんが足りなくなっていないこと');
});
