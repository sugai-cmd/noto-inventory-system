// 経営数値シート（scripts/export-management-sheet.js がスプレッドシートへ送る中身）と、
// その原価の計算（原酒の単価×倍率＋資材）。
//
// 数字は手で出した答えと突き合わせる。取消・委託・前日まで・単価なし、の境目の行をわざと入れてある。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-management-sheet.sqlite');
const { api } = harness;

let buildManagementSheets;
let listProductCosts;
let dailyMatrix;

test.before(async () => {
  await harness.setup((db, generateUid) => {
    const cust = db.prepare('INSERT INTO customers (uid, code, name, address, phone) VALUES (?, ?, ?, ?, ?)');
    cust.run(generateUid(db, 'customers'), 'C-001', '得意先A', '石川県輪島市', '0768-00-0000');
    cust.run(generateUid(db, 'customers'), 'C-002', '得意先B', null, null);

    const prod = db.prepare(
      `INSERT INTO products (uid, code, name, volume_ml, abv, list_price, tax_category,
                             initial_product_stock, initial_wip_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    prod.run(generateUid(db, 'products'), 'P-001', '浄酎35 300ml', 300, 35, 3300, 'スピリッツ', 5, 3);
    prod.run(generateUid(db, 'products'), 'P-002', '浄酎41 710ml', 710, 41, 8800, null, 0, 0);
    prod.run(generateUid(db, 'products'), 'P-003', '度数なし', 500, null, null, null, 0, 0);

    const mat = db.prepare(
      'INSERT INTO materials (uid, code, name, unit_price, proper_stock_qty, initial_stock) VALUES (?, ?, ?, ?, ?, ?)'
    );
    mat.run(generateUid(db, 'materials'), 'M-001', '300ml瓶', 100, 5, 10);
    mat.run(generateUid(db, 'materials'), 'M-002', 'キャップ', 20.5, 10, 3); // 適正を下回る・いちばん先に足りなくなる
    mat.run(generateUid(db, 'materials'), 'M-003', '化粧箱', null, null, 50); // 単価なし

    db.prepare(
      `INSERT INTO product_recipes (product_id, material_id, qty_required, process)
       VALUES (1, 1, 1, '瓶詰'), (1, 2, 1, '瓶詰'), (1, 3, 1, '箱詰')`
    ).run();

    // 20度で1klあたり20万円、1度ごとに1万円 → 35度は35万円/kl、300mlで105円
    db.prepare(
      `INSERT INTO liquor_tax_rates (category, base_abv, base_yen_per_kl, step_yen_per_kl)
       VALUES ('スピリッツ', 20, 200000, 10000)`
    ).run();

    const brand = db.prepare('INSERT INTO raw_sake_brands (uid, code, name, produced_on) VALUES (?, ?, ?, ?)');
    brand.run(generateUid(db, 'raw_sake_brands'), 'toriya-BY6-L1', '鳥屋 一昨年度', '2024');
    brand.run(generateUid(db, 'raw_sake_brands'), 'toriya-BY7-L1', '鳥屋 昨年度', '2025');

    const order = db.prepare(
      `INSERT INTO orders (order_no, line_no, ordered_on, customer_id, product_id, quantity, unit_price,
                           sales_amount, shipping_fee, payment_due_on, paid_on, sales_method, is_cancelled)
       VALUES (@no, 1, @on, @cust, 1, @qty, 3000, @sales, @ship, @due, @paid, @method, @cancelled)`
    );
    const base = { ship: 0, due: null, paid: null, method: '買取', cancelled: 0 };
    order.run({ ...base, no: 'O2609-0001', on: '2026-09-15', cust: 1, qty: 1, sales: 3000, due: '2026-09-30', paid: '2026-09-30' });
    order.run({ ...base, no: 'O2610-0001', on: '2026-10-01', cust: 1, qty: 2, sales: 6000, ship: 1000, due: '2026-11-30' });
    order.run({ ...base, no: 'O2610-0002', on: '2026-10-02', cust: 2, qty: 9, sales: 27000, cancelled: 1 });
    order.run({ ...base, no: 'O2610-0003', on: '2026-10-03', cust: 2, qty: 4, sales: 12000, method: '委託' });
    // 集計日当日の受注は数えない（朝に集計するので前日まで）
    order.run({ ...base, no: 'O2610-0004', on: '2026-10-26', cust: 1, qty: 1, sales: 3000 });

    db.prepare(
      `INSERT INTO consignment_reports (report_no, report_month, customer_id, product_id, quantity, sales_amount, shipping_fee)
       VALUES ('C2610-0001', '2026-10', 2, 1, 1, 3000, 0)`
    ).run();
  });

  ({ buildManagementSheets } = require('../../src/services/managementSheetService'));
  ({ listProductCosts } = require('../../src/services/productCostService'));
  ({ dailyMatrix } = require('../../src/services/managementSheetService'));
});

test.after(() => harness.teardown());

function sheet(report, name) {
  const s = report.sheets.find((x) => x.name === name);
  assert.ok(s, `シート「${name}」がありません`);
  return s;
}

/** 見出し行の名前で列を引く */
function cell(s, rowIndex, column, headerRow = 0) {
  const i = s.rows[headerRow].indexOf(column);
  assert.ok(i >= 0, `列「${column}」がありません`);
  return s.rows[rowIndex][i];
}

test('原酒が選ばれていなければ中身の原価は出さず、理由を返す（0円にしない）', () => {
  const p = listProductCosts().products.find((x) => x.code === 'P-001');
  assert.equal(p.liquidCost, null);
  assert.equal(p.totalCost, null);
  assert.match(p.reasons.join(), /原価に使う原酒が選ばれていません/);
});

test('原酒の単価と「原価に使う」は画面のAPIから入れられ、使用中は1件だけになる', async () => {
  let res = await api('PUT', '/api/raw-sake-brands/1', { unitPricePerL: 1000, usedForCost: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.unit_price_per_l, 1000);
  assert.equal(res.body.used_for_cost, 1);

  res = await api('PUT', '/api/raw-sake-brands/2', { unitPricePerL: 1400, usedForCost: true });
  assert.equal(res.body.used_for_cost, 1);
  assert.equal((await api('GET', '/api/raw-sake-brands/1')).body.used_for_cost, 0);

  // 一昨年度の原酒に戻す（以降の試験はこの状態）
  await api('PUT', '/api/raw-sake-brands/1', { usedForCost: true });
  assert.equal((await api('GET', '/api/raw-sake-brands/2')).body.used_for_cost, 0);
  // 単価だけ直しても、使用中の印は変わらない
  res = await api('PUT', '/api/raw-sake-brands/1', { unitPricePerL: 1000 });
  assert.equal(res.body.used_for_cost, 1);
});

test('中身の原価＝容量(L)×倍率×原酒の単価。35度は原酒30L→15L、41度は30L→13L', () => {
  const { products, rates } = listProductCosts();
  assert.deepEqual(rates.map((r) => [r.abv, r.raw_l, r.distillate_l]), [[35, 30, 15], [41, 30, 13]]);

  const p35 = products.find((x) => x.code === 'P-001');
  assert.equal(p35.ratio, 2);
  assert.equal(p35.liquidCost, 600); // 0.3L × 2 × 1,000円

  const p41 = products.find((x) => x.code === 'P-002');
  assert.equal(p41.liquidCost, 1638.46); // 0.71L × 30/13 × 1,000円
  assert.equal(p41.totalCost, 1638.46); // レシピなし→資材0円
  assert.match(p41.reasons.join(), /レシピが未登録/);

  const noAbv = products.find((x) => x.code === 'P-003');
  assert.equal(noAbv.liquidCost, null);
  assert.match(noAbv.reasons.join(), /規定度数が未設定/);
});

test('資材の原価は瓶詰＋箱詰のレシピを足す。単価のない資材は名前を出す', () => {
  const p = listProductCosts().products.find((x) => x.code === 'P-001');
  assert.equal(p.materialCost, 120.5); // 瓶100 ＋ キャップ20.5（化粧箱は単価なし）
  assert.equal(p.totalCost, 720.5);
  assert.match(p.reasons.join(), /単価が未設定の資材: 化粧箱/);
});

test('受注明細は全期間・取消も載せ、粗利は取消と委託（預け）には出さない', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), '受注明細');
  assert.equal(s.rows.length - 1, 5);
  const row = (no) => s.rows.findIndex((r) => r[0] === no);

  const r1 = row('O2610-0001');
  assert.equal(cell(s, r1, '合計(税込)'), 7600); // 6000×1.1＋送料1000
  assert.equal(cell(s, r1, '原価合計'), 1441);   // 720.5×2
  assert.equal(cell(s, r1, '粗利'), 4559);
  assert.equal(cell(s, r1, '酒税'), 210);        // 105円×2本
  assert.equal(cell(s, r1, '粗利(酒税を引いた後)'), 4349);

  const cancelled = row('O2610-0002');
  assert.equal(cell(s, cancelled, '取消'), '取消');
  assert.equal(cell(s, cancelled, '粗利'), '');
  assert.equal(cell(s, row('O2610-0003'), '粗利'), '');
});

test('受注ベース売上高：月合計の列に委託を足し、日の列は前日まで。当月以外は畳む', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), '受注ベース売上高');
  const header = s.rows[0];
  const total = s.rows.find((r) => r[0] === '売上合計（税抜）');

  const sep = header.indexOf('2026年09月 合計');
  const oct = header.indexOf('2026年10月 合計');
  assert.equal(total[sep], 3000);
  assert.equal(total[oct], 9000); // 買取6000（取消・委託の受注・当日分は除く）＋委託の報告3000
  assert.equal(total[header.indexOf('2026-10-01')], 6000);
  assert.ok(header.includes('2026-10-25'));
  assert.ok(!header.includes('2026-10-26'));

  // 列のまとまりは 1始まりの列番号。9月は30日ぶん・畳む、10月は25日ぶん・開いたまま
  assert.deepEqual(s.columnGroups, [
    { start: sep + 2, count: 30, collapsed: true },
    { start: oct + 2, count: 25, collapsed: false },
  ]);

  const qty = s.rows.findIndex((r) => r[0] === '商品別の本数');
  assert.equal(s.rows[qty + 1][0], '浄酎35 300ml');
  assert.equal(s.rows[qty + 1][oct], 3); // 買取2本＋委託1本
});

test('入金ベース：先の入金予定日の月まで列を作り、入金予定・未入金・入金を分ける', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), '入金ベース');
  const header = s.rows[0];
  const due = s.rows.find((r) => r[0].startsWith('入金予定額'));
  const unpaid = s.rows.find((r) => r[0] === 'うち未入金');
  const received = s.rows.find((r) => r[0].startsWith('入金額'));
  assert.equal(due[header.indexOf('2026-11-30')], 7600);
  assert.equal(unpaid[header.indexOf('2026年11月 合計')], 7600);
  assert.equal(received[header.indexOf('2026-09-30')], 3300);
});

test('商品在庫は商品＋仕掛品を合算し、資材から作れる本数と足りなくなる資材を出す', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), '商品在庫');
  const r = s.rows.findIndex((x) => x[0] === '浄酎35 300ml');
  assert.equal(cell(s, r, '在庫(商品＋仕掛品)'), 8);
  assert.equal(cell(s, r, 'あと作れる本数(資材)'), 3);
  assert.equal(cell(s, r, 'いちばん先に足りなくなる資材'), 'キャップ');
  assert.equal(cell(s, r, '在庫金額(原価)'), 5764); // 720.5×8
});

test('資材在庫は適正在庫を下回った行を赤くする（適正在庫が空なら判定しない）', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), '資材在庫');
  const names = s.highlightRows.map((row) => s.rows[row - 1][1]);
  assert.deepEqual(names, ['キャップ']);
});

test('得意先マスタは住所・電話も含めて出す', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), '得意先マスタ');
  assert.equal(cell(s, 1, '住所'), '石川県輪島市');
  assert.equal(cell(s, 1, '電話'), '0768-00-0000');
});

test('サマリーは週次報告と同じ数え方', () => {
  const s = sheet(buildManagementSheets({ asOf: '2026-10-26' }), 'サマリー');
  const value = (label) => s.rows.find((r) => r[0] === label)[1];
  assert.equal(value('当月売上（税抜・受注日）'), 9000);
  assert.equal(value('要発注の資材'), '1件');
});

test('13シートを決まった順で送る', () => {
  const names = buildManagementSheets({ asOf: '2026-10-26' }).sheets.map((s) => s.name);
  assert.deepEqual(names, [
    'サマリー', '受注明細', '受注ベース売上高', '入金ベース', '売上目標', '入金遅れ', '委託販売実績',
    '商品在庫', '資材在庫', 'タンク・原酒', '商品原価', '資材マスタ', '得意先マスタ',
  ]);
});

test('日別の横並び：月の途中で止めた月は、その日までの列だけ作る', () => {
  const { rows, columnGroups } = dailyMatrix(
    ['2026-02'],
    '2026-02-03',
    [{ label: 'x', byDay: new Map([['2026-02-02', 5]]) }],
    '2026-02'
  );
  assert.deepEqual(rows[0], ['項目', '2026年02月 合計', '2026-02-01', '2026-02-02', '2026-02-03']);
  assert.deepEqual(rows[1], ['x', 5, '', 5, '']);
  assert.deepEqual(columnGroups, [{ start: 3, count: 3, collapsed: false }]);
});

test('集計日の形式が違えば止める', () => {
  assert.throws(() => buildManagementSheets({ asOf: '2026/10/26' }), /YYYY-MM-DD/);
});
