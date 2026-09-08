// タンクマスタのCSVに無いタンクでも、DBにあれば台帳から引けること。
//
// 実運用で「出荷ポリタンク2」「出荷タンク6」が名寄せ不一致になった。
// 引き先（tankIdByName / tankIdByCode）は tanks.csv を読んだ行だけで
// 組み立てていたので、画面から登録したタンクは引けず、
// 「行は入るがタンクが空」＝液がどこにも紐付かない状態になっていた。
//
// しかも aliases.json の検算（checkAliases）はDBを見ているため、
// 「その右辺はマスタにあるので効きます」と言われたのに当たらない、
// という食い違いまで起きていた。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const TANK_HEADER =
  '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,' +
  '初期在庫量,現在液量(L),理論アルコール度数,備考';
const RAW_LEDGER_HEADER = '日付,受払,受入元,受払量,払出先,原酒受払ID,ID,原酒スペック';

const SP001 = 'SP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,';
const JP002 = 'JP-002,出荷用ポリ2,PE,20,浄溜所,稼働中,,0,0,,';

function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanklk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  const reportDir = path.join(dir, 'report');
  fs.mkdirSync(csvDir);

  const write = (contents) => {
    for (const f of fs.readdirSync(csvDir)) fs.rmSync(path.join(csvDir, f));
    for (const [name, content] of Object.entries(contents)) {
      fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
    }
  };
  write(files);

  return {
    dbPath: path.join(dir, 'tanklk.sqlite'),
    reportDir,
    aliasPath: path.join(dir, 'aliases.json'),
    write,
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: reportDir,
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'),
    },
  };
}

function run(ctx, extraArgs = []) {
  return execFileSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial', ...extraArgs],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
}

function report(ctx, name) {
  return fs.readFileSync(path.join(ctx.reportDir, name), 'utf8');
}

function rowsOf(csv) {
  return csv.trim().split('\n').slice(1).filter(Boolean);
}

/**
 * タンク欄の名寄せ不一致だけを取り出す。
 * 段ボール対応表は BOX_RULES から必ず組み立てるので、products.csv を
 * 置いていないこのテストでは商品名の不一致が常に11件出る。混ぜない。
 */
function unmatchedTankRows(ctx) {
  return rowsOf(report(ctx, 'unmatched-names.csv')).filter((line) => /タンク|受入元|払出先|容器/.test(line));
}

/** 台帳が指しているタンクの容器IDを返す（紐付いていなければ null） */
function toTankCodeOf(dbPath) {
  const db = require('better-sqlite3')(dbPath);
  const row = db
    .prepare('SELECT t.code FROM raw_sake_ledger l LEFT JOIN tanks t ON t.id = l.to_tank_id')
    .get();
  db.close();
  return row?.code ?? null;
}

test('シートから外したタンクでも、DBに残っていれば台帳から引ける', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n${JP002}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,出荷用ポリ2,M2604-0001,aaaaaaaa,\n`,
  });
  run(ctx);

  // タンクマスタからJP-002を外して流し直す（画面から登録した状態と同じ形）
  ctx.write({
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,出荷用ポリ2,M2604-0001,aaaaaaaa,\n`,
  });
  const out = run(ctx, ['--reset']);

  // 以前はここで名寄せ不一致になり、to_tank_id が空のまま入っていた
  assert.deepEqual(unmatchedTankRows(ctx), []);
  assert.equal(toTankCodeOf(ctx.dbPath), 'JP-002');
  assert.match(out, /原料受払記録: 読込1 \/ 投入1/);
});

test('容器IDでも引ける', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n${JP002}\n`,
  });
  run(ctx);

  ctx.write({
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,JP-002,M2604-0001,aaaaaaaa,\n`,
  });
  run(ctx, ['--reset']);

  assert.equal(toTankCodeOf(ctx.dbPath), 'JP-002');
});

test('補正表もDBのタンクに寄せられる（検算と実際の引きが食い違わない）', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n${JP002}\n`,
  });
  run(ctx);

  fs.writeFileSync(
    ctx.aliasPath,
    JSON.stringify({ '払出先(受入先タンク)': { 出荷ポリタンク2: '出荷用ポリ2' } }, null, 2),
    'utf8'
  );
  ctx.write({
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,出荷ポリタンク2,M2604-0001,aaaaaaaa,\n`,
  });
  const out = run(ctx, ['--reset']);

  // 「効きます」と言った以上、実際に当たること
  assert.doesNotMatch(out, /効きません/);
  assert.equal(toTankCodeOf(ctx.dbPath), 'JP-002');
});

test('DBにも無いタンクは、これまで通り名寄せ不一致として出る', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,出荷用ポリ6,M2604-0001,aaaaaaaa,\n`,
  });
  run(ctx);

  // 黙って通してはいけない。マスタに無いものは無いと言う
  assert.match(report(ctx, 'unmatched-names.csv'), /出荷用ポリ6/);
  assert.equal(toTankCodeOf(ctx.dbPath), null);
});

test('シートのタンクを優先する（同じ名前でDBと食い違っても取り違えない）', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\n${SP001}\n${JP002}\n`,
    'raw_sake_ledger.csv':
      `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,原酒ポリ1,M2604-0001,aaaaaaaa,\n`,
  });
  run(ctx);
  run(ctx, ['--reset']);

  assert.equal(toTankCodeOf(ctx.dbPath), 'SP-001');
});
