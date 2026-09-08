// 一度決めた読み替えを、手で書き直さずに済むこと。
//
// 表記ゆれの直し方が毎回 aliases.json の手書きになっていて、
// リッチテキストで保存された・全角の引用符が混ざった・同じキーを2回書いて
// 前の分が消えた、と何往復も潰れた。決まったものは同梱の
// known-aliases.json に置き、手元のファイルはその上に重ねる足し算にする。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { mergeAliases, findDuplicateKeys, readAliasFile } = require('../../scripts/lib/aliasFile');
const { readKnownTanks } = require('../../scripts/loaders/knownTanks');

const ROOT = path.resolve(__dirname, '..', '..');

const TANK_HEADER =
  '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,' +
  '初期在庫量,現在液量(L),理論アルコール度数,備考';
const RAW_LEDGER_HEADER = '日付,受払,受入元,受払量,払出先,原酒受払ID,ID,原酒スペック';
const CUSTOMER_HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';
const PRODUCT_HEADER = '商品ID,商品名称,容量(ml),度数,容器種別,単位,上代(円),JANコード';
const ORDER_HEADER =
  '受注番号,受注日,得意先名,商品名,本数,単価,掛け率,売価,送料,合計(税込),' +
  '納入希望日,請求日,入金予定日,入金日,販売方法,納品方法,ステータス,配送先,' +
  '納品日（発送日、配達日）,備考';

const SP001 = 'SP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,';

function useCsv(t, files, aliasJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }
  const aliasPath = path.join(dir, 'aliases.json');
  if (aliasJson != null) fs.writeFileSync(aliasPath, aliasJson, 'utf8');

  return {
    dbPath: path.join(dir, 'known.sqlite'),
    reportDir: path.join(dir, 'report'),
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: path.join(dir, 'report'),
      MIGRATION_ALIASES: aliasPath,
    },
  };
}

/** 警告は console.warn（標準エラー）に出るので、両方まとめて受ける */
function run(ctx, extraArgs = []) {
  const r = spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial', ...extraArgs],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `移行が失敗しました:\n${out}`);
  return out;
}

function toTankCodeOf(dbPath) {
  const db = require('better-sqlite3')(dbPath);
  const row = db
    .prepare('SELECT t.code FROM raw_sake_ledger l LEFT JOIN tanks t ON t.id = l.to_tank_id')
    .get();
  db.close();
  return row?.code ?? null;
}

// --- 組み込みの補正表 ------------------------------------------------------

test('aliases.json が無くても、決まった読み替えは効く', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,出荷ポリタンク2,M2604-0001,aaaaaaaa,\n`,
  });
  run(ctx);

  // 「出荷ポリタンク2」→「出荷用ポリ2」（JP-002）まで、手で書かずに通ること
  assert.equal(toTankCodeOf(ctx.dbPath), 'JP-002');
});

test('手元の aliases.json は、組み込みの上に重なる（消さない・上書きできる）', (t) => {
  const ctx = useCsv(
    t,
    {
      'tanks.csv': `${TANK_HEADER}\n${SP001}\nJP-009,出荷用ポリ9,PE,20,浄溜所,稼働中,,0,0,,\n`,
      'raw_sake_ledger.csv':
        `${RAW_LEDGER_HEADER}\n` +
        '2026-04-01,受入,鳥屋酒造,10,出荷タンク6,M2604-0001,aaaaaaaa,\n' +
        '2026-04-02,受入,鳥屋酒造,10,出荷ポリタンク2,M2604-0002,bbbbbbbb,\n',
    },
    // 「出荷ポリタンク2」だけ別の容器に読み替える
    JSON.stringify({ '払出先(受入先タンク)': { 出荷ポリタンク2: '出荷用ポリ9' } }, null, 2)
  );
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const codes = db
    .prepare('SELECT t.code FROM raw_sake_ledger l JOIN tanks t ON t.id = l.to_tank_id ORDER BY l.txn_date')
    .all()
    .map((r) => r.code);
  db.close();

  // 上書きした分は手元の指定どおり、書いていない分は組み込みのまま
  assert.deepEqual(codes, ['JP-006', 'JP-009']);
});

test('組み込みの補正表について、直しようのない警告を出さない', (t) => {
  const ctx = useCsv(t, {
    'customers.csv': `${CUSTOMER_HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
  });
  const out = run(ctx);

  // 組み込みの右辺（サーフBar など）はこの得意先マスタには無いが、
  // 利用者が直せるものではないので、警告に混ぜない
  assert.doesNotMatch(out, /効きません/);
});

test('組み込みの補正表そのものが読めること', () => {
  const { aliases, warnings } = readAliasFile(
    path.join(ROOT, 'scripts', 'data', 'known-aliases.json')
  );
  assert.deepEqual(warnings, []);

  for (const [column, table] of Object.entries(aliases)) {
    if (column.startsWith('_')) continue;
    assert.equal(typeof table, 'object', `${column} が対応表になっていません`);
    for (const [from, to] of Object.entries(table)) {
      assert.equal(typeof to, 'string', `${column}「${from}」の右辺が文字列ではありません`);
      assert.notEqual(from, to, `${column}「${from}」が自分自身を指しています`);
    }
  }
});

// --- マスタにそのままある名前を優先する ------------------------------------

test('マスタに登録されている名前は、補正表より優先される', (t) => {
  const ctx = useCsv(t, {
    // マスタ側の名前を「ホテル日航金沢」にした場合。
    // 組み込みには「ホテル日航金沢」→「日航ホテル」が入っているが、
    // 寄せ先が無くなっただけなので、そのまま引けなければいけない
    'customers.csv': `${CUSTOMER_HEADER}\nC0100,ホテル日航金沢,得意先,飲食店,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'products.csv': `${PRODUCT_HEADER}\nP001,浄酎 300ml,300,35,瓶,本,3000,\n`,
    'orders.csv':
      `${ORDER_HEADER}\n` +
      'O2604-001,2026-04-01,ホテル日航金沢,浄酎 300ml,6,3000,0.7,12600,0,12600,,,,,,,,,,\n',
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const row = db
    .prepare('SELECT c.name FROM orders o JOIN customers c ON c.id = o.customer_id')
    .get();
  db.close();
  assert.equal(row?.name, 'ホテル日航金沢');
});

test('マスタにある名前を左辺に書いていたら、そう伝える', (t) => {
  const ctx = useCsv(
    t,
    { 'customers.csv': `${CUSTOMER_HEADER}\nC0100,松本,得意先,酒販店,0.7,金沢市,翌月,末日,,,,,,,\n` },
    JSON.stringify({ 得意先名: { 松本: '株式会社松本' } }, null, 2)
  );
  const out = run(ctx);

  assert.match(out, /「松本」はマスタに登録されているので、読み替えずにそのまま使います/);
});

// --- 同じキーを2回書いたとき ------------------------------------------------

test('同じキーを2回書いたら、消えるほうの行番号を添えて知らせる', (t) => {
  const ctx = useCsv(
    t,
    { 'customers.csv': `${CUSTOMER_HEADER}\nC0100,松本,得意先,酒販店,0.7,金沢市,翌月,末日,,,,,,,\n` },
    '{\n' +
      '  "元容器ID": {\n' +
      '    "QB009": "Q-009"\n' +
      '  },\n' +
      '  "得意先名": {\n' +
      '    "近江町松本": "松本"\n' +
      '  },\n' +
      '  "元容器ID": {\n' +
      '    "QB010": "Q-010"\n' +
      '  }\n' +
      '}\n'
  );
  const out = run(ctx);

  // JSONは黙って後勝ちにするので、放っておくと QB009 が消えたことに気づけない
  assert.match(out, /「元容器ID」が2回書かれています（2行目と8行目）/);
  assert.match(out, /2行目の中身は消えます/);
});

test('findDuplicateKeys は、値の中の文字列を勘定に入れない', () => {
  const text = '{"得意先名": {"A{B": "C", "D,E": "F"}, "商品名": {"x": "y"}}';
  assert.deepEqual(findDuplicateKeys(text), []);

  // 別のオブジェクトの中の同じ名前は重複ではない
  const nested = '{"得意先名": {"松本": "A"}, "得意先": {"松本": "B"}}';
  assert.deepEqual(findDuplicateKeys(nested), []);
});

// --- 重ね方 ----------------------------------------------------------------

test('mergeAliases は、片方にしか無い列を落とさない', () => {
  const merged = mergeAliases(
    { 得意先名: { A: 'a' }, 資材名称: { M: 'm' } },
    { 得意先名: { B: 'b' }, 商品名称: { P: 'p' } }
  );
  assert.deepEqual(merged, {
    得意先名: { A: 'a', B: 'b' },
    資材名称: { M: 'm' },
    商品名称: { P: 'p' },
  });
});

test('mergeAliases は、__ignore__ を列ごとにつなげて重複を落とす', () => {
  const merged = mergeAliases(
    { __ignore__: { 得意先: ['カナカン'], 商品名称: ['旧品'] } },
    { __ignore__: { 得意先: ['カナカン', '見本'] } }
  );
  assert.deepEqual(merged.__ignore__, {
    得意先: ['カナカン', '見本'],
    商品名称: ['旧品'],
  });
});

// --- シートに無い容器の補完 --------------------------------------------------

test('シートに行が無い容器を、タンクマスタに足す', (t) => {
  const ctx = useCsv(t, { 'tanks.csv': `${TANK_HEADER}\n${SP001}\n` });
  const out = run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const added = db.prepare("SELECT code, name FROM tanks WHERE code LIKE 'JP-%' ORDER BY code").all();
  db.close();

  assert.deepEqual(added, [
    { code: 'JP-002', name: '出荷用ポリ2' },
    { code: 'JP-006', name: '出荷用ポリ6' },
  ]);
  // 黙って足さない。あとで追えるように、足したことを言う
  assert.match(out, /\[補完\] タンクマスタに JP-002「出荷用ポリ2」を追加しました/);
});

test('シートに同じ容器があれば、足さずにそちらを使う', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\nJP-002,出荷用ポリ2,PE,30,浄溜所,稼働中,,0,0,,シート側\n`,
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const rows = db.prepare("SELECT code, max_volume_l, note FROM tanks WHERE name = '出荷用ポリ2'").all();
  db.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].max_volume_l, 30); // シートの内容が残る
  assert.equal(rows[0].note, 'シート側');
});

test('流し直しても、補完した容器は増えない', (t) => {
  const ctx = useCsv(t, { 'tanks.csv': `${TANK_HEADER}\n${SP001}\n` });
  run(ctx);
  run(ctx, ['--reset']);

  const db = require('better-sqlite3')(ctx.dbPath);
  const count = db.prepare("SELECT COUNT(*) c FROM tanks WHERE code LIKE 'JP-%'").get().c;
  db.close();
  assert.equal(count, 2);
});

test('補完した容器を、シートから消した行として報告しない', (t) => {
  const ctx = useCsv(t, { 'tanks.csv': `${TANK_HEADER}\n${SP001}\n` });
  run(ctx);
  run(ctx, ['--reset']);

  const orphans = fs.readFileSync(path.join(ctx.reportDir, 'orphan-masters.csv'), 'utf8');
  assert.doesNotMatch(orphans, /出荷用ポリ/);
});

test('known-tanks.json の中身が、採番の決まりに合っていること', () => {
  const tanks = readKnownTanks();
  assert.ok(tanks.length > 0);
  for (const tank of tanks) {
    // DATA_STRUCTURE.md の採番。JP＝出荷用ポリタンク
    assert.match(tank.code, /^JP-\d{3}$/, `${tank.name} の容器IDが採番の形ではありません`);
    assert.equal(typeof tank.name, 'string');
    assert.ok(tank.note, `${tank.name} に、なぜ足したかが書かれていません`);
  }
});
