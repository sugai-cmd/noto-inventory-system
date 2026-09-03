// 棚卸（商品・資材・タンク）とCSV出力の検証。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');
const iconv = require('iconv-lite');

// 認証を有効にしたまま（本番と同じ構成で）テストする
const harness = createHarness('test-stocktaking.sqlite');
const api = harness.api;

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
  db.prepare(`INSERT INTO customers (uid, name, markup_rate, address, payment_term_months, payment_term_day)
              VALUES (?, '株式会社NOTO', 0.7, '石川県輪島市1-1', 1, '末日')`).run(generateUid(db, 'customers'));
  db.prepare(`INSERT INTO products (uid, name, volume_ml, list_price, tax_per_unit,
                                    initial_product_stock, initial_wip_stock)
              VALUES (?, '浄酎 300ml', 300, 3000, 300, 100, 50)`).run(generateUid(db, 'products'));
  db.prepare(`INSERT INTO materials (uid, name, unit, unit_price, proper_stock_qty, initial_stock,
                                     supplier_name, lead_time_days)
              VALUES (?, '300ml瓶', '本', 100, 1000, 500, 'ガラス商事', 14)`).run(generateUid(db, 'materials'));
  db.prepare(`INSERT INTO tanks (uid, code, name, container_type, max_volume_l, initial_volume_l, current_abv)
              VALUES (?, 'T-01', '浄酎タンク1', 'ステンレスタンク', 1000, 500, 40)`).run(generateUid(db, 'tanks'));
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('商品棚卸: 実測が理論を下回れば欠損、上回れば棚卸調整として記録される', async () => {
  // 理論: 商品100 / 仕掛品50 → 実測: 商品95（-5） / 仕掛品55（+5）
  const { status, body } = await api('POST', '/api/stocktaking/products', {
    productId: 1,
    actualProductStock: 95,
    actualWipStock: 55,
    txnDate: '2026-08-10',
    reason: '実地棚卸',
  });
  assert.equal(status, 201);

  const productAdj = body.adjustments.find((a) => a.target === '商品');
  const wipAdj = body.adjustments.find((a) => a.target === '仕掛品');
  assert.equal(productAdj.diff, -5);
  assert.equal(productAdj.txnType, '欠損_商品');
  assert.equal(wipAdj.diff, 5);
  assert.equal(wipAdj.txnType, '棚卸調整_仕掛品');

  // 実測値がそのまま在庫になる
  assert.equal(body.after.product_stock, 95);
  assert.equal(body.after.wip_stock, 55);
});

test('商品棚卸: 差異が0なら台帳行を作らない', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM product_stock_ledger').get().c;

  const { body } = await api('POST', '/api/stocktaking/products', {
    productId: 1,
    actualProductStock: 95, // 前のテストで95になっている
    txnDate: '2026-08-11',
  });
  assert.equal(body.adjustments[0].diff, 0);
  assert.equal(body.adjustments[0].skipped, true);

  const after = db.prepare('SELECT COUNT(*) AS c FROM product_stock_ledger').get().c;
  assert.equal(after, before, '差異0のとき台帳に行が追加されないこと');
});

test('商品棚卸: 実測値を1つも入力しないと422', async () => {
  const { status } = await api('POST', '/api/stocktaking/products', { productId: 1 });
  assert.equal(status, 400); // zodのrefineで弾かれる
});

test('資材棚卸: 0003で追加した棚卸調整/欠損区分が使われる', async () => {
  // 理論500 → 実測480（-20）
  const down = await api('POST', '/api/stocktaking/materials', {
    materialId: 1,
    actualStock: 480,
    txnDate: '2026-08-10',
    reason: '破損分',
  });
  assert.equal(down.status, 201);
  assert.equal(down.body.diff, -20);
  assert.equal(down.body.txnType, '欠損');
  assert.equal(down.body.after.current_stock, 480);

  // 理論480 → 実測500（+20）
  const up = await api('POST', '/api/stocktaking/materials', {
    materialId: 1,
    actualStock: 500,
    txnDate: '2026-08-11',
  });
  assert.equal(up.body.diff, 20);
  assert.equal(up.body.txnType, '棚卸調整');
  assert.equal(up.body.after.current_stock, 500);
});

test('タンク棚卸: 減少は欠減、増加は棚卸調整として記録される', async () => {
  // 理論500L → 実測495L（-5L）
  const down = await api('POST', '/api/stocktaking/tanks', {
    tankId: 1,
    actualVolumeL: 495,
    abv: 39.5,
    txnDate: '2026-08-10',
    reason: '検尺',
  });
  assert.equal(down.status, 201);
  assert.equal(down.body.diff, -5);
  assert.equal(down.body.txnType, '欠減');
  assert.equal(down.body.after.current_volume_l, 495);

  // 実測度数がタンクマスタに反映される
  assert.equal(db.prepare('SELECT current_abv FROM tanks WHERE id = 1').get().current_abv, 39.5);

  const up = await api('POST', '/api/stocktaking/tanks', {
    tankId: 1,
    actualVolumeL: 500,
    txnDate: '2026-08-11',
  });
  assert.equal(up.body.txnType, '棚卸調整');
  assert.equal(up.body.after.current_volume_l, 500);
});

test('ゆうパックCSVは72列・ヘッダー行なし・Shift_JISで出力される', async () => {
  await api('POST', '/api/orders', {
    orderedOn: '2026-08-05',
    customerId: 1,
    productId: 1,
    quantity: 10,
    shippingFee: 800,
    requestedDeliveryOn: '2026-08-10',
    deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1\n09083834939\n上森さくら様',
  });

  const res = await harness.rawFetch('/api/exports/yupack', {
    headers: { Cookie: harness.state.cookie },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /Shift_JIS/);
  assert.match(res.headers.get('content-disposition'), /attachment/);

  // Shift_JISのバイト列で返るので、そのまま復号して確かめる
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = iconv.decode(bytes, 'Shift_JIS');
  const lines = text.trim().split('\r\n');

  // ヘッダー行は無い
  const cells = lines[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  assert.equal(cells.length, 72, '72列であること');

  assert.equal(cells[0], '1');    // 1 商品（ゆうパック）
  assert.equal(cells[1], '0');    // 2 元払
  assert.equal(cells[6], '1');    // 7 作成数
  assert.equal(cells[7], '上森さくら'); // 8 お届け先のお名前
  assert.equal(cells[8], '様');   // 9 敬称
  assert.equal(cells[10], '9203114');  // 11 郵便番号（ハイフンなし7桁）
  assert.equal(cells[11], '石川県');    // 12 都道府県
  assert.equal(cells[12], '金沢市吉原町ヨ87-1'); // 13 市区町村郡
  assert.equal(cells[15], '09083834939'); // 16 電話番号
  assert.equal(cells[25], '9291715');     // 26 ご依頼主の郵便番号
  assert.equal(cells[31], 'NOTO Naorai株式会社'); // 32 ご依頼主の法人名
  assert.equal(cells[32], '能登浄溜所');  // 33 部署名
  assert.equal(cells[34], '浄酎');        // 35 品名
  assert.equal(cells[45], '1');           // 46 取扱上の注意 ビン類
  assert.equal(cells[51], '20260810');    // 52 配達希望日（YYYYMMDD）
  assert.equal(cells[52], '00');          // 53 配達希望時間帯
  assert.equal(cells[71], '0');           // 72 配達完了通知(依頼主)

  // 先頭0が消えないよう、全セルがダブルクォートで囲まれている
  assert.ok(lines[0].startsWith('"') && lines[0].endsWith('"'));
});

test('ゆうパックCSVは同じ受注番号を荷物1件にまとめる', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-06',
    customerId: 1,
    items: [{ productId: 1, quantity: 6 }, { productId: 1, quantity: 3 }],
    deliveryAddress: '〒920-3114 石川県金沢市吉原町ヨ87-1 上森さくら様',
  });

  const res = await harness.rawFetch(
    `/api/exports/yupack?orderIds=${order.body.lines.map((l) => l.id).join(',')}`,
    { headers: { Cookie: harness.state.cookie } }
  );
  const text = iconv.decode(Buffer.from(await res.arrayBuffer()), 'Shift_JIS');
  assert.equal(text.trim().split('\r\n').length, 1, '2明細でも1行');
});

test('住所を分解できない受注は、ヘッダで要確認として知らせる', async () => {
  const order = await api('POST', '/api/orders', {
    orderedOn: '2026-08-07',
    customerId: 1,
    productId: 1,
    quantity: 1,
    deliveryAddress: '住所未定',
  });

  const res = await harness.rawFetch(`/api/exports/yupack?orderIds=${order.body.id}`, {
    headers: { Cookie: harness.state.cookie },
  });
  const unresolved = JSON.parse(decodeURIComponent(res.headers.get('x-unresolved')));
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].orderNo, order.body.order_no);
});

test('マネーフォワードCSVは csv_type 40202・横型明細7品目で出力される', async () => {
  const { status, body } = await api('GET', '/api/exports/moneyforward');
  assert.equal(status, 200);

  const lines = body.trim().split('\r\n');
  const header = lines[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  assert.equal(header[0], 'csv_type(変更不可)');
  assert.equal(header[1], '取引先名称');
  assert.equal(header[4], '納品書番号');
  // 基本24列 + 明細8列 × 7品目
  assert.equal(header.length, 24 + 8 * 7);
  assert.equal(header[24], '品名');
  assert.equal(header[24 + 8], '品名'); // 2品目め

  const row = lines[1].split(',').map((c) => c.replace(/^"|"$/g, ''));
  assert.equal(row[0], '40202');
  assert.equal(row[1], '株式会社NOTO');
  assert.equal(row[10], '御中');
  // 小計 = 売価21000 + 送料800、消費税10%、合計
  assert.equal(row[7], '21800');
  assert.equal(row[8], '2180');
  assert.equal(row[9], '23980');
  // 1品目め：品名・単価・数量・単位・金額・税率
  assert.equal(row[24], '浄酎 300ml');
  assert.equal(row[26], '2100');  // 単価3000 × 掛率0.7
  assert.equal(row[27], '10');
  assert.equal(row[28], '本');
  assert.equal(row[30], '21000');
  assert.equal(row[31], '10%');
  // 2品目めに送料が1明細として入る
  assert.equal(row[32], '送料');
  assert.equal(row[38], '800');
});

test('CSVはBOM付きCRLFで出力される（Excelでの文字化け対策）', async () => {
  // fetchのtext()は仕様上BOMを取り除いてしまうので、生バイト列で検証する
  const res = await harness.rawFetch('/api/exports/moneyforward', { headers: { Cookie: harness.state.cookie } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOMで始まること');

  const { body } = await api('GET', '/api/exports/moneyforward');
  assert.ok(body.includes('\r\n'), 'CRLF改行であること');
});

test('カンマや引用符を含む値が正しくエスケープされる', async () => {
  db.prepare("UPDATE orders SET note = 'テスト,カンマ入り \"引用符\" あり' WHERE id = 1").run();

  const { body } = await api('GET', '/api/exports/moneyforward');
  assert.ok(body.includes('"テスト,カンマ入り ""引用符"" あり"'));
});

test('棚卸用の在庫CSVには実測記入欄が含まれる', async () => {
  const product = await api('GET', '/api/exports/product-stock');
  assert.match(product.body.split('\r\n')[0], /実測（記入欄）/);

  const material = await api('GET', '/api/exports/material-stock');
  assert.match(material.body, /300ml瓶/);

  const tank = await api('GET', '/api/exports/tank-monitor');
  assert.match(tank.body, /T-01/);
});

test('受注CSVは受注IDや期間で絞り込める', async () => {
  // 受注番号ごとに1行なので、件数はそのときのデータに依らず数え直す
  const countRows = (body) => body.trim().split('\r\n').length - 1; // ヘッダ分を引く

  const all = await api('GET', '/api/exports/moneyforward');
  assert.ok(countRows(all.body) >= 1);

  const filtered = await api('GET', '/api/exports/moneyforward?from=2027-01-01');
  assert.equal(countRows(filtered.body), 0, '期間外は0件');

  const byId = await api('GET', '/api/exports/moneyforward?orderIds=1');
  assert.equal(countRows(byId.body), 1, '受注ID指定は1件');
});
