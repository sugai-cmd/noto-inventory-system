// 台帳を取り込むときに、行を落とさないこと。
//
// 実データで69行が落ちていた。内訳は3つで、どれも表記ゆれではなかった。
//   ・資材在庫変動履歴の「棚卸調整」「欠損」を受け付けていなかった（26行）
//   ・原酒受払IDの重複に枝番を付けていなかった（27行）
//   ・--reset を付けずに流し直して、前回投入分と伝票番号がぶつかっていた（残り）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const MATERIAL_HEADER =
  '資材ID,資材名,資材種別,単位,単価(円),ロット数,適正在庫数,初期在庫数,' +
  '発注先会社名,発注先住所,発注先担当者名,備考,リードタイム';
const MATERIAL_LEDGER_HEADER = '日付,資材履歴ID,資材名称,受払,数量,受払先,商品履歴ID,備考';
const TANK_HEADER =
  '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,' +
  '初期在庫量,現在液量(L),理論アルコール度数,備考';
const RAW_LEDGER_HEADER = '日付,受払,受入元,受払量,払出先,原酒受払ID,ID,原酒スペック';

function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  const reportDir = path.join(dir, 'report');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }
  return {
    dbPath: path.join(dir, 'ledger.sqlite'),
    reportDir,
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: reportDir,
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'),
    },
  };
}

function run(ctx, extraArgs = []) {
  const r = require('node:child_process').spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial', ...extraArgs],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

function report(ctx, name) {
  return fs.readFileSync(path.join(ctx.reportDir, name), 'utf8');
}

test('資材在庫変動履歴の「棚卸調整」「欠損」を取り込む', (t) => {
  const ctx = useCsv(t, {
    'materials.csv': `${MATERIAL_HEADER}\nMAT-003,300mlガラス瓶,容器,本,281,,,1000,酒井硝子,,,,\n`,
    'material_stock_ledger.csv':
      `${MATERIAL_LEDGER_HEADER}\n` +
      '2026-05-01,M2605-0001,300mlガラス瓶,入荷,100,酒井硝子,,\n' +
      '2026-05-02,M2605-0002,300mlガラス瓶,消費,20,,,\n' +
      '2026-05-03,M2605-0003,300mlガラス瓶,棚卸調整,5,,,実測が多かった\n' +
      '2026-05-04,M2605-0004,300mlガラス瓶,欠損,3,,,破損\n',
  });
  const out = run(ctx);

  // 以前は「入荷」「消費」しか通さず、下2行を捨てていた
  assert.match(out, /資材在庫変動履歴: 読込4 \/ 投入4/);

  const db = require('better-sqlite3')(ctx.dbPath);
  const types = db
    .prepare('SELECT txn_type FROM material_stock_ledger ORDER BY txn_date')
    .all()
    .map((r) => r.txn_type);
  assert.deepEqual(types, ['入荷', '消費', '棚卸調整', '欠損']);

  // 在庫の計算にも入る（初期1000 + 100 - 20 + 5 - 3）
  const stock = db.prepare("SELECT current_stock FROM v_material_stock WHERE name = '300mlガラス瓶'").get();
  assert.equal(stock.current_stock, 1082);
  db.close();
});

test('解釈できない受払は、受け付ける値を並べて断る', (t) => {
  const ctx = useCsv(t, {
    'materials.csv': `${MATERIAL_HEADER}\nMAT-003,300mlガラス瓶,容器,本,281,,,0,酒井硝子,,,,\n`,
    'material_stock_ledger.csv':
      `${MATERIAL_LEDGER_HEADER}\n2026-05-01,M2605-0001,300mlガラス瓶,よくわからない,100,,,\n`,
  });
  run(ctx);

  const errors = report(ctx, 'errors.csv');
  assert.match(errors, /入荷.*消費.*棚卸調整.*欠損/);
});

test('原酒受払IDが重複していても、行を落とさず枝番を付ける', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\nSP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n` +
      '2026-04-01,受入,鳥屋酒造,10,原酒ポリ1,M2604-0001,aaaaaaaa,\n' +
      '2026-04-02,受入,鳥屋酒造,5,原酒ポリ1,M2604-0001,bbbbbbbb,\n',
  });
  const out = run(ctx);

  // 以前は2件目が UNIQUE 違反で落ち、原酒の受入が1件消えていた
  assert.match(out, /原料受払記録: 読込2 \/ 投入2/);

  const db = require('better-sqlite3')(ctx.dbPath);
  const codes = db.prepare('SELECT lot_code FROM raw_sake_ledger ORDER BY id').all().map((r) => r.lot_code);
  assert.deepEqual(codes, ['R2604-0001', 'R2604-0001-2']);
  // 元の番号は両方に残る（シートと突き合わせられるように）
  const legacy = db.prepare('SELECT legacy_lot_code FROM raw_sake_ledger ORDER BY id').all();
  assert.deepEqual(legacy.map((r) => r.legacy_lot_code), ['M2604-0001', 'M2604-0001']);
  db.close();

  // 行は入っているので、エラーではなくお知らせに出す
  assert.match(report(ctx, 'notices.csv'), /原酒受払ID「M2604-0001」が重複していたため R2604-0001-2/);
  assert.doesNotMatch(report(ctx, 'errors.csv'), /重複していたため/);
});

test('台帳に前回の投入分が残っていたら、--reset を促す', (t) => {
  const csv = {
    'tanks.csv': `${TANK_HEADER}\nSP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,原酒ポリ1,M2604-0001,aaaaaaaa,\n`,
  };
  const ctx = useCsv(t, csv);
  run(ctx); // 1回目：本番投入

  // 2回目を --reset なしで流す
  const out = run(ctx);
  assert.match(out, /台帳に既にデータが入っています/);
  assert.match(out, /raw_sake_ledger\(1件\)/);
  assert.match(out, /--reset を付けてください/);
});

test('--reset を付ければ、伝票番号はぶつからない', (t) => {
  const csv = {
    'tanks.csv': `${TANK_HEADER}\nSP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,原酒ポリ1,M2604-0001,aaaaaaaa,\n`,
  };
  const ctx = useCsv(t, csv);
  run(ctx);
  const out = run(ctx, ['--reset']);

  assert.doesNotMatch(out, /台帳に既にデータが入っています/);
  assert.match(out, /原料受払記録: 読込1 \/ 投入1/);
  assert.doesNotMatch(out, /UNIQUE constraint failed/);

  const db = require('better-sqlite3')(ctx.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM raw_sake_ledger').get().c, 1);
  db.close();
});
