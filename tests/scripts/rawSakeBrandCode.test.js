// 原酒マスタを銘柄名ではなく原酒IDで持つこと（0015）。
//
// 銘柄名が NOT NULL UNIQUE だったため、同じ銘柄の別ロットは片方しか入らず、
// 流し直すたびに度数が入れ替わっていた（実データの「浄酎用池月」18.3 と 18.8）。
// 度数は蒸留の計算に効く値なので、両方残らないといけない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { assignLotCodes } = require('../../scripts/loaders/rawSakeBrands');

const ROOT = path.resolve(__dirname, '..', '..');

const BRAND_HEADER =
  '銘柄,アルコール度数,日本酒度,酒蔵,ステータス,製造年(月),備考,ID,移入日,初期在庫量,現在在庫量';
const LEDGER_HEADER = '日付,受払,受入元,受払量,払出先,原酒受払ID,ID,原酒スペック';

/** この試験だけのCSV置き場とレポート出力先（他の試験と取り合わないため） */
function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  const reportDir = path.join(dir, 'report');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }

  return {
    dbPath: path.join(dir, 'rsb.sqlite'),
    reportDir,
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: reportDir,
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'), // 置かない＝補正表なし
    },
  };
}

function run(ctx) {
  return execFileSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial'],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
}

function report(ctx, name) {
  return fs.readFileSync(path.join(ctx.reportDir, name), 'utf8');
}

test('同じ銘柄名でも原酒IDが違えば2行として入る（度数が両方残る）', (t) => {
  const ctx = useCsv(t, {
    'raw_sake_brands.csv':
      `${BRAND_HEADER}\n` +
      '浄酎用池月,18.3,,鳥屋酒造,未納税,2025年,,toriya-BYR6-L1,2026-04-01,0,0\n' +
      '浄酎用池月,18.8,,鳥屋酒造,未納税,2025年,,toriya-BYR6-L2,2026-05-01,0,0\n',
  });
  const out = run(ctx);
  assert.match(out, /原酒マスタ: 読込2 \/ 投入2/);

  const db = require('better-sqlite3')(ctx.dbPath);
  const rows = db.prepare('SELECT code, name, abv FROM raw_sake_brands ORDER BY code').all();
  assert.deepEqual(
    rows.map((r) => [r.code, r.abv]),
    [['toriya-BYR6-L1', 18.3], ['toriya-BYR6-L2', 18.8]]
  );
  db.close();
});

test('同じ原酒IDが2行あるときは、両方に -L1 -L2 を付けて分ける', (t) => {
  const ctx = useCsv(t, {
    'raw_sake_brands.csv':
      `${BRAND_HEADER}\n` +
      '西之門　雲山,18.4,,西之門,未納税,2025年,,unzan-BYR6,2026-04-01,0,0\n' +
      '雲山,18.8,,西之門,未納税,2025年,,unzan-BYR6,2026-05-01,0,0\n',
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const rows = db.prepare('SELECT code, name, abv FROM raw_sake_brands ORDER BY id').all();
  // 1件目も素のままにせず、どちらのロットか分かるように両方へ振る
  assert.deepEqual(rows.map((r) => r.code), ['unzan-BYR6-L1', 'unzan-BYR6-L2']);
  assert.deepEqual(rows.map((r) => r.abv), [18.4, 18.8]);
  db.close();

  // 勝手に振り直したことは黙っていない
  const errors = report(ctx, 'errors.csv');
  assert.match(errors, /原酒ID「unzan-BYR6」が複数行にあるため unzan-BYR6-L1/);
  assert.match(errors, /原酒ID「unzan-BYR6」が複数行にあるため unzan-BYR6-L2/);
});

test('採番は、既に使われている枝番を避ける', () => {
  // 「X」が2行あり、別の行が既に「X-L1」を使っている場合
  const { codeByRow, renumbered } = assignLotCodes([
    { ID: 'X' },
    { ID: 'X-L1' },
    { ID: 'X' },
  ]);
  assert.equal(codeByRow.get(3), 'X-L1'); // もともと X-L1 の行はそのまま
  assert.deepEqual(
    renumbered.map((r) => r.to),
    ['X-L2', 'X-L3']
  );
});

test('流し直しても、原酒IDが同じ行は更新になって増えない', (t) => {
  const csv =
    `${BRAND_HEADER}\n` +
    '浄酎用池月,18.3,,鳥屋酒造,未納税,2025年,,toriya-BYR6-L1,2026-04-01,0,0\n' +
    '浄酎用池月,18.8,,鳥屋酒造,未納税,2025年,,toriya-BYR6-L2,2026-05-01,0,0\n';
  const ctx = useCsv(t, { 'raw_sake_brands.csv': csv });
  run(ctx);
  const out = run(ctx);

  assert.match(out, /原酒マスタ: 読込2 \/ 投入0 \/ 更新2/);

  const db = require('better-sqlite3')(ctx.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM raw_sake_brands').get().c, 2);
  // 度数が入れ替わらない（これが元の症状）
  assert.equal(
    db.prepare("SELECT abv FROM raw_sake_brands WHERE code = 'toriya-BYR6-L1'").get().abv,
    18.3
  );
  db.close();

  // 中身が変わっていないので、更新の記録も空
  const updates = report(ctx, 'master-updates.csv').trim();
  assert.equal(updates, 'sheet,name,column,before,after');
});

test('原酒スペックは銘柄名でも原酒IDでも引ける', (t) => {
  const ctx = useCsv(t, {
    'raw_sake_brands.csv':
      `${BRAND_HEADER}\n` +
      'BYR6浄酎用池月,18.3,,鳥屋酒造,未納税,2025年,,toriya-BYR6,2026-04-01,0,0\n',
    'tanks.csv':
      '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,現在液量(L),理論アルコール度数,備考\n' +
      'SP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,\n',
    'raw_sake_ledger.csv':
      `${LEDGER_HEADER}\n` +
      '2026-04-01,受入,鳥屋酒造,18,原酒ポリ1,M2604-0001,aaaaaaaa,BYR6浄酎用池月\n' +
      '2026-04-02,受入,鳥屋酒造,18,原酒ポリ1,M2604-0002,bbbbbbbb,toriya-BYR6\n',
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  // 名前で書いた行もIDで書いた行も、どちらも同じ原酒に紐付く
  const linked = db
    .prepare('SELECT COUNT(*) c FROM raw_sake_ledger WHERE raw_sake_brand_id IS NOT NULL')
    .get().c;
  assert.equal(linked, 2);
  db.close();
});

test('銘柄名が重複しているときは、名前では引かずに不一致として報告する', (t) => {
  const ctx = useCsv(t, {
    'raw_sake_brands.csv':
      `${BRAND_HEADER}\n` +
      '浄酎用池月,18.3,,鳥屋酒造,未納税,2025年,,toriya-BYR6-L1,2026-04-01,0,0\n' +
      '浄酎用池月,18.8,,鳥屋酒造,未納税,2025年,,toriya-BYR6-L2,2026-05-01,0,0\n',
    'tanks.csv':
      '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,現在液量(L),理論アルコール度数,備考\n' +
      'SP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,\n',
    'raw_sake_ledger.csv':
      `${LEDGER_HEADER}\n` +
      '2026-04-01,受入,鳥屋酒造,18,原酒ポリ1,M2604-0001,aaaaaaaa,浄酎用池月\n' +
      '2026-04-02,受入,鳥屋酒造,18,原酒ポリ1,M2604-0002,bbbbbbbb,toriya-BYR6-L2\n',
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  // 度数の違うロットを取り違えるより、紐付けないで報告する
  const byName = db
    .prepare("SELECT raw_sake_brand_id FROM raw_sake_ledger WHERE legacy_lot_code = 'M2604-0001'")
    .get();
  assert.equal(byName.raw_sake_brand_id, null);

  // IDで書いてあるほうは引ける
  const byCode = db
    .prepare("SELECT raw_sake_brand_id FROM raw_sake_ledger WHERE legacy_lot_code = 'M2604-0002'")
    .get();
  assert.notEqual(byCode.raw_sake_brand_id, null);
  db.close();

  const unmatched = report(ctx, 'unmatched-names.csv');
  assert.match(unmatched, /原料受払記録,原酒スペック,浄酎用池月/);
});
