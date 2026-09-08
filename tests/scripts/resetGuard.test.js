// --reset で、画面から入力した記録を黙って消さないこと。
//
// 移行が済んだ時点からシステムは本番で使われる。実際に、投入した翌日に
// 「過去に蒸留した作業内容」が画面から入力された（タンクの受入が26.3L増えた）。
//
// --reset は台帳を消してシートを入れ直すので、シートに無い行は戻らない。
// 手順書は「流し直すときは必ず --reset を付けてください」と書いてあるため、
// 表記ゆれを1件直すつもりで流し直したときに、黙って失われる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const TANK_HEADER =
  '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,' +
  '初期在庫量,現在液量(L),理論アルコール度数,備考';
const RAW_LEDGER_HEADER = '日付,受払,受入元,受払量,払出先,原酒受払ID,ID,原酒スペック';

const CSV = {
  'tanks.csv': `${TANK_HEADER}\nSP-001,原酒ポリ1,ポリタンク,20,熟成室,稼働中,,0,0,,\n`,
  'raw_sake_ledger.csv':
    `${RAW_LEDGER_HEADER}\n2026-04-01,受入,鳥屋酒造,10,原酒ポリ1,M2604-0001,aaaaaaaa,\n`,
};

function useCsv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(CSV)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }
  return {
    dbPath: path.join(dir, 'reset.sqlite'),
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: path.join(dir, 'report'),
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'),
    },
  };
}

function run(ctx, extraArgs = []) {
  const r = spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial', ...extraArgs],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

/** 画面から1件入力したのと同じ状態にする（シートには無い行） */
function addRowFromScreen(ctx) {
  const db = require('better-sqlite3')(ctx.dbPath);
  const tankId = db.prepare("SELECT id FROM tanks WHERE name = '原酒ポリ1'").get().id;
  db.prepare(
    `INSERT INTO raw_sake_ledger (lot_code, txn_date, txn_type, to_tank_id, quantity)
     VALUES ('R2609-9001', '2026-09-08', '受入', ?, 26.3)`
  ).run(tankId);
  db.close();
}

function ledgerCount(ctx) {
  const db = require('better-sqlite3')(ctx.dbPath);
  const c = db.prepare('SELECT COUNT(*) AS c FROM raw_sake_ledger').get().c;
  db.close();
  return c;
}

test('前回の投入より後に増えた行があれば、--reset を止める', (t) => {
  const ctx = useCsv(t);
  run(ctx); // 本番投入
  addRowFromScreen(ctx);

  const { out, status } = run(ctx, ['--reset']);

  assert.notEqual(status, 0);
  assert.match(out, /前回の投入より後に増えた行があります/);
  assert.match(out, /raw_sake_ledger: 前回の投入後 1件 増えています（1→2）/);
  assert.match(out, /--force-reset を付けてください/);

  // 止めた以上、消していないこと
  assert.equal(ledgerCount(ctx), 2);
});

test('--force-reset を付ければ、消すと分かったうえで流せる', (t) => {
  const ctx = useCsv(t);
  run(ctx);
  addRowFromScreen(ctx);

  const { out, status } = run(ctx, ['--reset', '--force-reset']);

  assert.equal(status, 0);
  assert.doesNotMatch(out, /前回の投入より後に増えた行があります/);
  assert.match(out, /原料受払記録: 読込1 \/ 投入1/);
  assert.equal(ledgerCount(ctx), 1); // 画面から入れた行は消える（承知のうえ）
});

test('増えていなければ、--reset はこれまで通り通る', (t) => {
  const ctx = useCsv(t);
  run(ctx);

  const { out, status } = run(ctx, ['--reset']);

  assert.equal(status, 0);
  assert.doesNotMatch(out, /前回の投入より後に増えた行があります/);
  assert.equal(ledgerCount(ctx), 1);
});

test('何を何件消すかを、消す前に出す', (t) => {
  const ctx = useCsv(t);
  run(ctx);

  const { out } = run(ctx, ['--reset']);

  // 消したあとでは数えられないので、消す前に言う
  assert.match(out, /raw_sake_ledger: 1件を削除/);
});

test('投入の記録は dry-run では残さない（ロールバックされる）', (t) => {
  const ctx = useCsv(t);
  run(ctx, ['--dry-run']);

  const db = require('better-sqlite3')(ctx.dbPath);
  const c = db.prepare('SELECT COUNT(*) AS c FROM migration_runs').get().c;
  db.close();
  assert.equal(c, 0);
});

test('初めての投入では、比べる相手が無いので止めない', (t) => {
  const ctx = useCsv(t);

  const { out, status } = run(ctx, ['--reset']);

  assert.equal(status, 0);
  assert.doesNotMatch(out, /前回の投入より後に増えた行があります/);
});
