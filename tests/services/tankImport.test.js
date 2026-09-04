// タンクマスタのCSV一括登録と、CSVファイルのアップロード読み取りを検証する。
// 見出しと値は現行スプレッドシートの「容器マスタ」シートの実物に合わせている。

const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { createHarness } = require('../helpers/appHarness');

const harness = createHarness('test-tank-import.sqlite');
const api = harness.api;

let db;

// 容器マスタシートの見出しと、実データからそのまま取った行
const SHEET_HEADER =
  '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,現在液量(L),理論アルコール度数,備考';
const SHEET_ROWS = [
  'DISTL-01,浄溜機,蒸留機,40,浄溜所,稼働中,,0,,0,2024年',
  'T-001,ステンレスタンク1,ステンレスタンク,213,浄溜所,稼働中,,84,90,0.34,2025年導入',
  'B-001,樽1,木樽,245,熟成室,稼働中,,,,0,ミズナラ新樽',
  'U-001,残渣保管タンク1,PP,514,浄溜所,空,,,,0,',
  'SP-001,原酒ポリ1,PE,20,浄溜所,,,,,,',
  'Q-001,テナー1,QBテナー,18,浄溜所,空,,0,0,,',
];
const SHEET_CSV = [SHEET_HEADER, ...SHEET_ROWS].join('\n');

test.before(async () => {
  ({ db } = await harness.setup());
});

test.after(async () => {
  await harness.teardown();
});

test('容器マスタシートの見出しをそのまま取り込める', async () => {
  const { status, body } = await api('POST', '/api/master-import', {
    kind: 'tanks',
    csv: SHEET_CSV,
    dryRun: true,
  });
  assert.equal(status, 200);
  assert.equal(body.created, 6);
  assert.equal(body.updated, 0);
  assert.deepEqual(body.errors, []);
  // 「現在液量(L)」はこちらでは入出庫の記録から算出する計算列なので取り込まない
  assert.deepEqual(body.ignoredColumns, ['現在液量(L)']);
});

test('取り込むとタンクが登録され、シートの値がそのまま入る', async () => {
  const { body } = await api('POST', '/api/master-import', { kind: 'tanks', csv: SHEET_CSV });
  assert.equal(body.created, 6);

  const rows = db.prepare('SELECT * FROM tanks ORDER BY code').all();
  assert.equal(rows.length, 6);

  const stainless = rows.find((r) => r.code === 'T-001');
  assert.equal(stainless.name, 'ステンレスタンク1');
  assert.equal(stainless.container_type, 'ステンレスタンク');
  assert.equal(stainless.max_volume_l, 213);
  assert.equal(stainless.location, '浄溜所');
  assert.equal(stainless.status, '稼働中');
  assert.equal(stainless.initial_volume_l, 84);
  assert.equal(stainless.current_abv, 0.34);
  assert.equal(stainless.note, '2025年導入');

  // シートの容器種別は PP・PE・斗瓶 のように、採番の種別名とは別の書き方が入っている。
  // 勝手に読み替えず、シートの値のまま持つ。
  assert.equal(rows.find((r) => r.code === 'U-001').container_type, 'PP');
  assert.equal(rows.find((r) => r.code === 'SP-001').container_type, 'PE');
});

test('容器IDが同じ行は更新になる（名称を変えても新規にならない）', async () => {
  const csv = [SHEET_HEADER, 'T-001,ステンレスタンク1号,ステンレスタンク,220,浄溜所,空,,84,,0.4,更新した'].join('\n');
  const { body } = await api('POST', '/api/master-import', { kind: 'tanks', csv });
  assert.equal(body.created, 0);
  assert.equal(body.updated, 1);

  const row = db.prepare("SELECT * FROM tanks WHERE code = 'T-001'").get();
  assert.equal(row.name, 'ステンレスタンク1号');
  assert.equal(row.max_volume_l, 220);
  assert.equal(row.status, '空');
  assert.equal(row.note, '更新した');
});

test('更新のときは初期在庫量を上書きしない（在庫計算の起点が動かないように）', async () => {
  const before = db.prepare("SELECT initial_volume_l FROM tanks WHERE code = 'T-001'").get();
  assert.equal(before.initial_volume_l, 84);

  const csv = [SHEET_HEADER, 'T-001,ステンレスタンク1号,ステンレスタンク,220,浄溜所,空,,999,,0.4,'].join('\n');
  const { body } = await api('POST', '/api/master-import', { kind: 'tanks', csv });
  assert.equal(body.updated, 1);
  assert.deepEqual(body.createOnlyColumns, ['初期在庫量']);

  const after = db.prepare("SELECT initial_volume_l FROM tanks WHERE code = 'T-001'").get();
  assert.equal(after.initial_volume_l, 84);
});

test('容器IDと容器名称は必須', async () => {
  const { status, body } = await api('POST', '/api/master-import', {
    kind: 'tanks',
    csv: '最大容量(L),現在設置場所\n213,浄溜所',
  });
  assert.equal(status, 422);
  assert.match(body.message, /容器ID/);
  assert.match(body.message, /容器名称/);
});

test('取り込みテンプレートに容器マスタの見出しが出る', async () => {
  const { body } = await api('GET', '/api/master-import/template/tanks');
  assert.equal(body.label, 'タンク');
  // 見出しの案内には取り込む列だけを出す（計算列の「現在液量(L)」は含めない）
  assert.equal(
    body.header,
    '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,理論アルコール度数,備考'
  );
  assert.deepEqual(body.required, ['容器ID', '容器名称']);
});

// --- ファイルのアップロード ---------------------------------------------------

/** ファイルの中身をそのまま送る（画面のドラッグ＆ドロップと同じ経路） */
async function decode(buffer) {
  const res = await harness.rawFetch('/api/master-import/decode', {
    method: 'POST',
    headers: { Cookie: harness.state.cookie, 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  return { status: res.status, body: await res.json() };
}

test('UTF-8のCSVファイルをそのまま読み取れる', async () => {
  const { status, body } = await decode(Buffer.from(SHEET_CSV, 'utf8'));
  assert.equal(status, 200);
  assert.equal(body.encoding, 'UTF-8');
  assert.equal(body.text, SHEET_CSV);
});

test('BOM付きUTF-8（スプレッドシートのエクスポート）も読み取れる', async () => {
  const { body } = await decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SHEET_CSV, 'utf8')]));
  assert.equal(body.encoding, 'UTF-8 (BOM付き)');
  assert.equal(body.text, SHEET_CSV);
});

test('Shift_JISのCSVファイル（Excelで保存し直したもの）も文字化けせずに読み取れる', async () => {
  const { body } = await decode(iconv.encode(SHEET_CSV, 'Shift_JIS'));
  assert.equal(body.encoding, 'Shift_JIS');
  assert.equal(body.text, SHEET_CSV);
  // 化けていたら「容器名称」や「浄溜所」が壊れる
  assert.ok(body.text.includes('ステンレスタンク1'));
  assert.ok(body.text.includes('浄溜所'));
});

test('読み取った中身はそのまま取り込みに渡せる', async () => {
  const { body: decoded } = await decode(iconv.encode(SHEET_CSV, 'Shift_JIS'));
  const { body } = await api('POST', '/api/master-import', {
    kind: 'tanks',
    csv: decoded.text,
    dryRun: true,
  });
  assert.equal(body.created + body.updated, 6);
  assert.deepEqual(body.errors, []);
});

test('空のファイルは取り違えずにエラーになる', async () => {
  const { status } = await decode(Buffer.alloc(0));
  assert.equal(status, 422);
});

test('ログインしていないとファイルを読み込めない', async () => {
  const res = await harness.rawFetch('/api/master-import/decode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(SHEET_CSV, 'utf8'),
  });
  assert.equal(res.status, 401);
});
