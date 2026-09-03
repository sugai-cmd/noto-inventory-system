// マスタ登録画面（/masters.html）が使うAPIの検証。
// 得意先・酒蔵・原酒のCRUDと、画面に出る制約違反メッセージ。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-masters.sqlite');
const { api, rawFetch } = harness;

let db;

test.before(async () => {
  ({ db } = await harness.setup());
});

test.after(async () => {
  await harness.teardown();
});

// --- 画面 ---

test('マスタ画面はログインしないと開けない', async () => {
  const res = await rawFetch('/masters.html', { redirect: 'manual' });
  assert.equal(res.status, 302);
  // ログイン後に元の画面へ戻れるよう、遷移先が引き継がれる
  assert.equal(res.headers.get('location'), '/login.html?next=%2Fmasters.html');
});

test('ログイン済みならマスタ画面が返る', async () => {
  const { status, body } = await api('GET', '/masters.html');
  assert.equal(status, 200);
  assert.match(body, /製品レシピ/);
});

// --- 得意先 ---

test('得意先を登録・編集できる', async () => {
  const created = await api('POST', '/api/customers', {
    code: 'C001',
    name: '能登酒店',
    markupRate: 0.7,
    paymentTermMonths: 1,
    paymentTermDay: '末日',
    salesRep: '菅井',
    onboardedMonth: '2026-04',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.markup_rate, 0.7);
  assert.match(created.body.uid, /^[a-z0-9]{8}$/);

  const updated = await api('PUT', `/api/customers/${created.body.id}`, {
    markupRate: 0.65,
    salesSubRep: '山田',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.markup_rate, 0.65);
  assert.equal(updated.body.sales_sub_rep, '山田');
  // 送らなかった項目は元の値が残る
  assert.equal(updated.body.sales_rep, '菅井');
  assert.equal(updated.body.name, '能登酒店');
});

test('得意先名の重複は日本語のメッセージで拒否される', async () => {
  const { status, body } = await api('POST', '/api/customers', { name: '能登酒店' });
  assert.equal(status, 409);
  assert.equal(body.message, 'その得意先名はすでに登録されています。');
});

test('取引開始月をYYYY-MM以外で送ると400になる（2.0の日付方針）', async () => {
  const { status, body } = await api('POST', '/api/customers', {
    name: '日付テスト商店',
    onboardedMonth: '2026-04-01',
  });
  assert.equal(status, 400);
  assert.match(JSON.stringify(body.details), /YYYY-MM/);
});

// --- 酒蔵・原酒 ---

test('酒蔵を登録・編集・削除できる', async () => {
  const created = await api('POST', '/api/breweries', {
    name: '白山酒造',
    address: '石川県白山市',
    phone: '076-000-0000',
    startedOn: '2026-04-01',
  });
  assert.equal(created.status, 201);

  const updated = await api('PUT', `/api/breweries/${created.body.id}`, { contact: '田中' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.contact, '田中');
  assert.equal(updated.body.address, '石川県白山市');

  const removed = await api('DELETE', `/api/breweries/${created.body.id}`);
  assert.equal(removed.status, 204);

  const gone = await api('GET', `/api/breweries/${created.body.id}`);
  assert.equal(gone.status, 404);
});

test('原酒は酒蔵を選んでも、一覧にない名前を直接入力しても登録できる', async () => {
  const brewery = await api('POST', '/api/breweries', { name: '能登杜氏酒造' });

  const linked = await api('POST', '/api/raw-sake-brands', {
    name: '純米原酒A',
    breweryId: brewery.body.id,
    abv: 18.5,
  });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.brewery_id, brewery.body.id);

  // 未登録の酒蔵名はbrewery_name_rawに退避され、brewery_idはNULLのまま（8-2）
  const free = await api('POST', '/api/raw-sake-brands', {
    name: '純米原酒B',
    breweryName: 'まだ登録していない蔵',
  });
  assert.equal(free.status, 201);
  assert.equal(free.body.brewery_id, null);
  assert.equal(free.body.brewery_name_raw, 'まだ登録していない蔵');
});

test('酒蔵IDと酒蔵名の同時指定は400になる', async () => {
  const brewery = await api('POST', '/api/breweries', { name: '二重指定テスト蔵' });
  const { status } = await api('POST', '/api/raw-sake-brands', {
    name: '二重指定原酒',
    breweryId: brewery.body.id,
    breweryName: '別の蔵',
  });
  assert.equal(status, 400);
});

test('原酒から参照されている酒蔵は削除できず、理由が日本語で返る', async () => {
  const brewery = await api('POST', '/api/breweries', { name: '参照されている蔵' });
  await api('POST', '/api/raw-sake-brands', {
    name: '参照している原酒',
    breweryId: brewery.body.id,
  });

  const { status, body } = await api('DELETE', `/api/breweries/${brewery.body.id}`);
  assert.equal(status, 409);
  assert.match(body.message, /参照されているため削除できません/);

  // 削除されていないこと
  const still = await api('GET', `/api/breweries/${brewery.body.id}`);
  assert.equal(still.status, 200);
});

test('原酒を編集・削除できる', async () => {
  const created = await api('POST', '/api/raw-sake-brands', {
    name: '編集テスト原酒',
    abv: 17,
    initialStock: 300,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.initial_stock, 300);

  const updated = await api('PUT', `/api/raw-sake-brands/${created.body.id}`, {
    abv: 17.5,
    status: '保管中',
    producedOn: '令和8年8月',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.abv, 17.5);
  assert.equal(updated.body.produced_on, '令和8年8月');

  const removed = await api('DELETE', `/api/raw-sake-brands/${created.body.id}`);
  assert.equal(removed.status, 204);
});

// --- 存在しないAPI ---

test('存在しない /api/... はHTMLではなくJSONで404を返す', async () => {
  const { status, body, res } = await api('GET', '/api/does-not-exist');
  assert.equal(status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(body.error, 'unknown_endpoint');
  // 原因（サーバーが古いまま）に気づける文言になっていること
  assert.match(body.message, /再起動/);
  assert.match(body.message, /GET \/api\/does-not-exist/);
});

test('存在しないAPIへのPOSTも同じ形で返る', async () => {
  const { status, body } = await api('POST', '/api/nope', { a: 1 });
  assert.equal(status, 404);
  assert.equal(body.error, 'unknown_endpoint');
  assert.match(body.message, /POST \/api\/nope/);
});

test('画面ファイルの404は従来どおり（APIの404だけを変えている）', async () => {
  const { status } = await api('GET', '/no-such-page.html');
  assert.equal(status, 404);
});

// --- コードの自動採番（GAS版の「IDはすべて自動採番」） ---

test('得意先コードは既存データの採番の続きを返す', async () => {
  // このテストDBには「能登酒店」など code なしの得意先が既にいる
  const first = await api('GET', '/api/customers/next-code');
  assert.equal(first.status, 200);

  await api('POST', '/api/customers', { code: 'C0035', name: '採番テスト商店' });
  const next = await api('GET', '/api/customers/next-code');
  assert.equal(next.body.code, 'C0036');
  assert.equal(next.body.basedOn, 'C0035');
  assert.equal(next.body.prefix, 'C');
});

test('コードが1件も無ければ既定のプレフィックスで1番から始まる', async () => {
  const { body } = await api('GET', '/api/products/next-code');
  assert.equal(body.code, 'P0001');
  assert.equal(body.basedOn, null);
});

test('採番は表示するだけで、別のコードでも登録できる（多数派の書き方が保たれる）', async () => {
  await api('POST', '/api/products', { code: 'P0001', name: '採番テスト商品1' });
  await api('POST', '/api/products', { code: 'P0002', name: '採番テスト商品2' });

  // 1件だけ別の書き方で登録しても
  const created = await api('POST', '/api/products', { code: 'ORIGINAL-1', name: '手入力コードの商品' });
  assert.equal(created.status, 201);
  assert.equal(created.body.code, 'ORIGINAL-1');

  // 次の採番は多数派（P）の続きのまま。1件の例外に引きずられない
  const after = await api('GET', '/api/products/next-code');
  assert.equal(after.body.code, 'P0003');
  assert.equal(after.body.prefix, 'P');
});

test('資材と酒蔵にも採番がある', async () => {
  const material = await api('GET', '/api/materials/next-code');
  assert.equal(material.body.code, 'M0001');

  await api('POST', '/api/breweries', { code: 'B0007', name: '採番テスト蔵' });
  const brewery = await api('GET', '/api/breweries/next-code');
  assert.equal(brewery.body.code, 'B0008');
});

test('酒蔵IDを登録・保持できる（シートの酒蔵ID列に対応）', async () => {
  const created = await api('POST', '/api/breweries', { code: 'B0100', name: 'ID付きの蔵' });
  assert.equal(created.status, 201);
  assert.equal(created.body.code, 'B0100');

  const duplicated = await api('POST', '/api/breweries', { code: 'B0100', name: '別の蔵' });
  assert.equal(duplicated.status, 409);
});

test('/next-code は :id ルートに食われていない', async () => {
  for (const path of ['/api/customers/next-code', '/api/products/next-code',
                      '/api/materials/next-code', '/api/breweries/next-code']) {
    const { status, body } = await api('GET', path);
    assert.equal(status, 200, path);
    assert.ok(body.code, `${path} が採番を返すこと`);
  }
});

// --- CSV一括登録：現行スプレッドシートの書き出しをそのまま受け取れるか ---

const SHEET_HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';

test('シートの見出しのまま・シートの並び順のまま取り込める', async () => {
  const csv = [
    SHEET_HEADER,
    'C0500,シート取込テスト商店,小売業者,小売,0.8,石川県七尾市1-1,当月,末日,,備考です,菅井,,,,',
  ].join('\n');

  const { status, body } = await api('POST', '/api/master-import', { kind: 'customers', csv });
  assert.equal(status, 200);
  assert.equal(body.created, 1);
  assert.deepEqual(body.ignoredColumns, []);

  const row = db.prepare("SELECT * FROM customers WHERE name = 'シート取込テスト商店'").get();
  assert.equal(row.code, 'C0500');          // 顧客ID → 得意先コード
  assert.equal(row.payment_term_day, '末日'); // 支払いサイト日付 → 支払いサイト日
  assert.equal(row.note, '備考です');
  assert.equal(row.sales_rep, '菅井');
});

test('支払いサイト月数の「当月／翌月／翌々月」を月数に読み替える', async () => {
  const rows = [
    ['当月テスト店', '当月', 0],
    ['翌月テスト店', '翌月', 1],
    ['翌々月テスト店', '翌々月', 2],
    ['数字テスト店', '2', 2],
  ];
  const csv = ['得意先名,支払いサイト月数', ...rows.map(([n, v]) => `${n},${v}`)].join('\n');

  const { body } = await api('POST', '/api/master-import', { kind: 'customers', csv });
  assert.equal(body.created, 4);

  for (const [name, , expected] of rows) {
    const row = db.prepare('SELECT payment_term_months FROM customers WHERE name = ?').get(name);
    assert.equal(row.payment_term_months, expected, name);
  }
});

test('支払いサイトが解釈できない言葉は、受け付ける書き方を添えて指摘する', async () => {
  const { body } = await api('POST', '/api/master-import', {
    kind: 'customers',
    csv: '得意先名,支払いサイト月数\n応相談テスト店,応相談',
  });
  assert.equal(body.created, 0);
  assert.match(body.errors[0].message, /支払いサイト月数を読み取れませんでした/);
  assert.match(body.errors[0].message, /翌々月/);
});

test('対応する項目がない列は、取り込みを止めずに報告する', async () => {
  const { body } = await api('POST', '/api/master-import', {
    kind: 'customers',
    csv: '得意先名,掛率,社内メモ,担当ランク\n未知列テスト店,0.8,なにか,A',
  });
  assert.equal(body.created, 1);
  assert.deepEqual(body.ignoredColumns, ['社内メモ', '担当ランク']);
});

test('タブ区切り（スプレッドシートから直接コピー）でも取り込める', async () => {
  const csv = '得意先名\t掛率\tサブ担当者\nタブ区切りテスト店\t0.75\t山田';
  const { body } = await api('POST', '/api/master-import', { kind: 'customers', csv });
  assert.equal(body.created, 1);
  const row = db.prepare("SELECT * FROM customers WHERE name = 'タブ区切りテスト店'").get();
  assert.equal(row.markup_rate, 0.75);
  assert.equal(row.sales_sub_rep, '山田');
});

test('見出し行とデータ行の列数が違うと、何行目が何列かを日本語で返す', async () => {
  const { status, body } = await api('POST', '/api/master-import', {
    kind: 'customers',
    csv: '得意先コード,得意先名,区分\nC0600,列ずれテスト店,小売,余分,な,列',
  });
  assert.equal(status, 422);
  assert.match(body.message, /見出し行は3列ですが、2行目は6列あります/);
  assert.match(body.message, /スプレッドシートの見出し行ごと貼り付けれ/);
});

test('住所の改行や引用符を含む行も壊れない', async () => {
  const csv = [
    '得意先名,住所',
    '"改行住所テスト店","〒150-0031\n東京都渋谷区桜丘町\n3-3"',
    '"引用符テスト10""1",東京都',
  ].join('\n');

  const { body } = await api('POST', '/api/master-import', { kind: 'customers', csv });
  assert.equal(body.created, 2);
  const row = db.prepare("SELECT address FROM customers WHERE name = '改行住所テスト店'").get();
  assert.match(row.address, /東京都渋谷区桜丘町/);
  assert.ok(db.prepare('SELECT 1 FROM customers WHERE name = ?').get('引用符テスト10"1'));
});

test('取り込みテンプレートの見出しは、シートの列名・並び順そのもの', async () => {
  const { body } = await api('GET', '/api/master-import/template/customers');
  assert.equal(
    body.header,
    '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
      '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月'
  );
  // こちらの旧表記も別名として受け付ける
  const code = body.aliases.find((a) => a.canonical === '顧客ID');
  assert.ok(code.aliases.includes('得意先コード'));
});

test('資材・商品・レシピの見出しもシートの列そのもの', async () => {
  const material = await api('GET', '/api/master-import/template/materials');
  assert.equal(
    material.body.header,
    '資材ID,資材名,資材種別,単位,単価(円),ロット数,適正在庫数,初期在庫数,' +
      '発注先会社名,発注先住所,発注先担当者名,備考,リードタイム'
  );

  const product = await api('GET', '/api/master-import/template/products');
  assert.equal(
    product.body.header,
    '商品名称,容量(ml),規定度数,容器タイプ,単位,上代,JAN,目標エキス分基準,備考,' +
      '商品カテゴリ,商品ID,初期商品在庫数,初期仕掛品在庫数,課税額'
  );

  const recipe = await api('GET', '/api/master-import/template/productRecipes');
  assert.equal(recipe.body.header, 'レシピID,商品名称,資材名,必要数量,ステータス');
});

// --- シートのプルダウン相当の値 ---

test('支払いサイト月数は当月=0／翌月=1／翌々月=2 で保存される', async () => {
  const created = await api('POST', '/api/customers', {
    name: 'プルダウン保存テスト商店',
    segment: '卸売業者',
    businessType: '国内卸',
    paymentTermMonths: 2,
    paymentTermDay: '末日',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.segment, '卸売業者');
  assert.equal(created.body.payment_term_months, 2);
  assert.equal(created.body.payment_term_day, '末日');
});

test('資材種別・容器タイプ・設置場所・原酒ステータスが保存される', async () => {
  const material = await api('POST', '/api/materials', { name: '種別テスト資材', category: 'キャップ' });
  assert.equal(material.body.category, 'キャップ');

  const product = await api('POST', '/api/products', {
    name: '容器タイプテスト商品', containerType: 'ガラス瓶',
  });
  assert.equal(product.body.container_type, 'ガラス瓶');

  const tank = await api('POST', '/api/tanks', {
    code: 'T-880', name: '設置場所テストタンク',
    containerType: 'ステンレスタンク', location: '熟成室', status: '稼働中',
  });
  assert.equal(tank.body.location, '熟成室');
  assert.equal(tank.body.status, '稼働中');

  const brand = await api('POST', '/api/raw-sake-brands', {
    name: 'ステータステスト原酒', status: '未納税',
  });
  assert.equal(brand.body.status, '未納税');
});

test('営業メモの種別が保存される', async () => {
  const customer = await api('POST', '/api/customers', { name: 'メモ種別テスト商店' });
  await api('POST', `/api/customers/${customer.body.id}/notes`, {
    category: '訪問', body: '初回訪問',
  });
  const { body } = await api('GET', `/api/customers/${customer.body.id}/notes`);
  assert.equal(body[0].category, '訪問');
});

test('種別を指定しない営業メモは「メモ」になる', async () => {
  const customer = await api('POST', '/api/customers', { name: 'メモ既定テスト商店' });
  await api('POST', `/api/customers/${customer.body.id}/notes`, { body: '種別なし' });
  const { body } = await api('GET', `/api/customers/${customer.body.id}/notes`);
  assert.equal(body[0].category, 'メモ');
});
