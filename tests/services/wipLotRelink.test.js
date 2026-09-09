// 仕掛品ロットの紐付けを、あとから直せること。
//
// 移行で入った箱詰めには引当行（wip_lot_allocations）が1件も無い。
// 旧シートは「どの瓶詰めロットを使ったか」を受入元/払出先の欄に**文字**
// （L2607-0072 のような商品履歴ID）で書いていただけで、移行はそれを
// counterparty にそのまま入れる。IDでの紐付けは作られない。
// 実データでは箱詰め33行すべてが引当なしで、うち5行が counterparty に
// ロットコードを持っていた。
//
// これまで引当を作れるのは「箱詰めを新規登録する」ときだけで、
// UPDATE も DELETE も無かった。直すには取り消して入れ直すしかなかった。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-wip-relink.sqlite');
const api = harness.api;

let db;

/** 瓶詰め・箱詰めの行を直接入れる（移行で入った記録と同じ形にするため） */
function ledger(db, { code, date, productId, type, quantity, counterparty = null }) {
  return db
    .prepare(
      `INSERT INTO product_stock_ledger (history_code, txn_date, product_id, txn_type, quantity, counterparty)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(code, date, productId, type, quantity, counterparty).lastInsertRowid;
}

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'P001', '浄酎 300ml', 300, 35, '本', 3000, 0, 0)`
    ).run(generateUid(db, 'products'));
    db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, unit, list_price,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, 'P002', '浄酎 700ml', 700, 35, '本', 7000, 0, 0)`
    ).run(generateUid(db, 'products'));

    // 瓶詰めロット（id 1,2 が商品1、id 3 が商品2）
    ledger(db, { code: 'L2607-0072', date: '2026-07-10', productId: 1, type: '瓶詰', quantity: 100 });
    ledger(db, { code: 'L2607-0080', date: '2026-07-15', productId: 1, type: '瓶詰', quantity: 60 });
    ledger(db, { code: 'L2607-0099', date: '2026-07-16', productId: 2, type: '瓶詰', quantity: 40 });

    // 移行で入った箱詰め。引当は無く、ロット番号は counterparty に文字で入っている
    ledger(db, {
      code: 'L2608-0027', date: '2026-08-01', productId: 1, type: '箱詰', quantity: 30,
      counterparty: 'L2607-0072',
    });
    // ロット番号ではない文字が入っている箱詰め（実データには棚卸し過剰分・得意先も混ざる）
    ledger(db, {
      code: 'L2608-0031', date: '2026-08-02', productId: 1, type: '箱詰', quantity: 20,
      counterparty: '棚卸し過剰分',
    });
    // 取消済みの箱詰め
    const cancelled = ledger(db, {
      code: 'L2608-0040', date: '2026-08-03', productId: 1, type: '箱詰', quantity: 10,
    });
    db.prepare('UPDATE product_stock_ledger SET is_cancelled = 1 WHERE id = ?').run(cancelled);

    // 残量チェック用の小さいロット（5本）
    ledger(db, { code: 'L2607-0090', date: '2026-07-20', productId: 1, type: '瓶詰', quantity: 5 });
  }));
});

test.after(async () => {
  await harness.teardown();
});

const BOXING_WITH_HINT = 4;   // L2608-0027（counterparty = L2607-0072）
const BOXING_NO_HINT = 5;     // L2608-0031（counterparty = 棚卸し過剰分）
const CANCELLED_BOXING = 6;
const LOT_A = 1;              // L2607-0072（100本）
const LOT_B = 2;              // L2607-0080（60本）
const OTHER_PRODUCT_LOT = 3;  // L2607-0099（別商品）
const SMALL_LOT = 7;          // L2607-0090（5本）

test('引当が足りていない箱詰めが一覧に出る', async () => {
  const { status, body } = await api('GET', '/api/wip-lots/unlinked');

  assert.equal(status, 200);
  const codes = body.map((r) => r.history_code);
  assert.ok(codes.includes('L2608-0027'));
  assert.ok(codes.includes('L2608-0031'));
  // 取消済みは直す必要がない
  assert.ok(!codes.includes('L2608-0040'), '取消済みの箱詰めが出ています');
});

test('シートに書かれていたロット番号を、候補として添える', async () => {
  const { body } = await api('GET', '/api/wip-lots/unlinked');

  const withHint = body.find((r) => r.history_code === 'L2608-0027');
  assert.equal(withHint.counterparty, 'L2607-0072');
  assert.equal(withHint.hint_ledger_id, LOT_A);
  assert.equal(withHint.hint_history_code, 'L2607-0072');
  assert.equal(withHint.unallocated, 30);

  // ロット番号でない文字には候補を付けない（機械で当てると別のロットに繋がる）
  const noHint = body.find((r) => r.history_code === 'L2608-0031');
  assert.equal(noHint.counterparty, '棚卸し過剰分');
  assert.equal(noHint.hint_ledger_id, null);
});

test('紐付けを保存すると、ロット追跡に出る', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, {
    items: [{ bottlingLedgerId: LOT_A, quantity: 30 }],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.allocations.length, 1);
  assert.equal(res.body.allocations[0].bottling_history_code, 'L2607-0072');

  // 引当のぶんロットの残量が減る
  const lots = await api('GET', '/api/wip-lots?productId=1');
  const lotA = lots.body.find((l) => l.history_code === 'L2607-0072');
  assert.equal(lotA.allocated, 30);
  assert.equal(lotA.remaining, 70);

  // 一覧からも消える
  const unlinked = await api('GET', '/api/wip-lots/unlinked');
  assert.ok(!unlinked.body.map((r) => r.history_code).includes('L2608-0027'));
});

test('2回送っても二重に積まれない（足すのではなく置き換え）', async () => {
  await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, {
    items: [{ bottlingLedgerId: LOT_A, quantity: 30 }],
  });

  const { body } = await api('GET', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`);
  assert.equal(body.length, 1);
  assert.equal(body[0].quantity, 30);

  const lots = await api('GET', '/api/wip-lots?productId=1');
  assert.equal(lots.body.find((l) => l.history_code === 'L2607-0072').allocated, 30);
});

test('複数のロットに分けて割り当てられる', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, {
    items: [
      { bottlingLedgerId: LOT_A, quantity: 20 },
      { bottlingLedgerId: LOT_B, quantity: 10 },
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.allocations.length, 2);

  const lots = await api('GET', '/api/wip-lots?productId=1');
  assert.equal(lots.body.find((l) => l.history_code === 'L2607-0072').allocated, 20);
  assert.equal(lots.body.find((l) => l.history_code === 'L2607-0080').allocated, 10);
});

test('箱詰めの本数を超える割り当ては断る', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, {
    items: [{ bottlingLedgerId: LOT_A, quantity: 31 }],
  });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /箱詰めの本数 30 本を超えて/);

  // 断ったのだから、前の内訳が残っていること
  const { body } = await api('GET', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`);
  assert.equal(body.length, 2);
});

test('ロットの残量を超える割り当ては断る', async () => {
  // 箱詰めは20本なのでそちらの上限には当たらない。ロット側が5本しかない
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_NO_HINT}`, {
    items: [{ bottlingLedgerId: SMALL_LOT, quantity: 10 }],
  });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /残量は 5 本です/);
});

test('別の箱詰めが使っているぶんは、残量から引いて数える', async () => {
  // まず5本すべてを BOXING_NO_HINT に割り当てる
  const ok = await api('PUT', `/api/wip-lots/allocations/${BOXING_NO_HINT}`, {
    items: [{ bottlingLedgerId: SMALL_LOT, quantity: 5 }],
  });
  assert.equal(ok.status, 200);

  // 別の箱詰めからは、もう1本も取れない
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, {
    items: [{ bottlingLedgerId: SMALL_LOT, quantity: 1 }],
  });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /残量は 0 本です/);

  // 自分自身のぶんは残量から除くので、同じ内容の入れ直しは通る
  const again = await api('PUT', `/api/wip-lots/allocations/${BOXING_NO_HINT}`, {
    items: [{ bottlingLedgerId: SMALL_LOT, quantity: 5 }],
  });
  assert.equal(again.status, 200);
});

test('別の商品の瓶詰めロットは選べない', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_NO_HINT}`, {
    items: [{ bottlingLedgerId: OTHER_PRODUCT_LOT, quantity: 5 }],
  });

  assert.equal(res.status, 422);
  assert.match(res.body.message, /別の商品の瓶詰め/);
});

test('取消済みの箱詰めは直せない', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${CANCELLED_BOXING}`, {
    items: [{ bottlingLedgerId: LOT_A, quantity: 5 }],
  });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /取消済み/);
});

test('同じロットを2行に分けたら断る', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_NO_HINT}`, {
    items: [
      { bottlingLedgerId: LOT_A, quantity: 5 },
      { bottlingLedgerId: LOT_A, quantity: 5 },
    ],
  });

  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /同じ瓶詰めロット/);
});

test('空の内訳を送ると、紐付けを外せる', async () => {
  const res = await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, { items: [] });

  assert.equal(res.status, 200);
  assert.equal(res.body.allocations.length, 0);

  // 一覧に戻ってくる
  const unlinked = await api('GET', '/api/wip-lots/unlinked');
  assert.ok(unlinked.body.map((r) => r.history_code).includes('L2608-0027'));
});

test('直した記録が、前後の内訳つきで操作ログに残る', async () => {
  await api('PUT', `/api/wip-lots/allocations/${BOXING_WITH_HINT}`, {
    items: [{ bottlingLedgerId: LOT_A, quantity: 30 }],
  });

  const log = db
    .prepare(
      "SELECT summary, detail_json FROM operation_logs WHERE action = 'wipLot.relink' ORDER BY id DESC"
    )
    .get();
  assert.match(log.summary, /L2608-0027 の仕掛品ロットの紐付けを直しました/);

  // 間違えたときに戻せるよう、直す前の内訳も残す
  const detail = JSON.parse(log.detail_json);
  assert.deepEqual(detail.before, []);
  assert.deepEqual(detail.after, [{ lot: 'L2607-0072', quantity: 30 }]);
});

test('紐付けたあとは、その瓶詰めを先に取り消せない（既存のルールが効き続ける）', async () => {
  const res = await api('POST', `/api/ledger-cancel/${LOT_A}`, { reason: '順番の確認' });
  assert.equal(res.status, 409);
});
