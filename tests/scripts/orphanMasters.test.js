// シートのどの行にも対応しなくなったマスタ行（取り残し）を報告すること。
//
// マスタは消さない作りなので、シートから外した商品が受注の選択肢に残り続ける。
// 実データでも商品がDB21件・シート19件で2件残っていたが、
// 「投入／更新／スキップ」はシート側から見た数字なので、これは出てこなかった。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const PRODUCT_HEADER = '商品ID,商品名称,容量(ml),度数,容器種別,単位,上代(円),JANコード';
const CUSTOMER_HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';

function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-'));
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
    dbPath: path.join(dir, 'orph.sqlite'),
    reportDir,
    write,
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: reportDir,
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'),
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

function rowsOf(csv) {
  return csv.trim().split('\n').slice(1).filter(Boolean);
}

const THREE_PRODUCTS =
  `${PRODUCT_HEADER}\n` +
  'P001,浄酎 300ml,300,35,瓶,本,3000,\n' +
  'P002,浄酎 500ml,500,35,瓶,本,5000,\n' +
  'P003,終売にする商品,700,41,瓶,本,7000,\n';

test('シートから消した商品が、取り残しとして出る', (t) => {
  const ctx = useCsv(t, { 'products.csv': THREE_PRODUCTS });
  run(ctx);

  // シートから1行外して流し直す（実データの 商品DB21 vs シート19 と同じ形）
  ctx.write({
    'products.csv':
      `${PRODUCT_HEADER}\n` +
      'P001,浄酎 300ml,300,35,瓶,本,3000,\n' +
      'P002,浄酎 500ml,500,35,瓶,本,5000,\n',
  });
  const out = run(ctx);

  const orphans = rowsOf(report(ctx, 'orphan-masters.csv'));
  assert.equal(orphans.length, 1);
  assert.match(orphans[0], /^商品,P003,終売にする商品,/);
  assert.match(out, /シートに対応が無いマスタ行: 1件/);

  // 消さずに残す（受注が紐付いていることがあるので、消すかは人が決める）
  const db = require('better-sqlite3')(ctx.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 3);
  db.close();
});

test('取り残しがあっても移行は止まらない', (t) => {
  const ctx = useCsv(t, { 'products.csv': THREE_PRODUCTS });
  run(ctx);
  ctx.write({ 'products.csv': `${PRODUCT_HEADER}\nP001,浄酎 300ml,300,35,瓶,本,3000,\n` });

  // 例外を投げずに最後まで通ること
  const out = run(ctx);
  assert.match(out, /商品マスタ: 読込1/);
  assert.equal(rowsOf(report(ctx, 'orphan-masters.csv')).length, 2);
});

test('CSVを置いていないマスタは、取り残し扱いにしない', (t) => {
  const ctx = useCsv(t, {
    'products.csv': THREE_PRODUCTS,
    'customers.csv': `${CUSTOMER_HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
  });
  run(ctx);

  // 得意先のCSVだけ置き忘れて流し直す
  ctx.write({ 'products.csv': THREE_PRODUCTS });
  run(ctx);

  const orphans = report(ctx, 'orphan-masters.csv');
  // 置き忘れただけの得意先を「シートから消えた」と言ってはいけない
  assert.doesNotMatch(orphans, /カナカン酒類石川/);
  assert.equal(rowsOf(orphans).length, 0);
});

test('シートと過不足が無ければ、orphan-masters.csv は見出しだけ', (t) => {
  const ctx = useCsv(t, { 'products.csv': THREE_PRODUCTS });
  run(ctx);
  const out = run(ctx);

  assert.equal(rowsOf(report(ctx, 'orphan-masters.csv')).length, 0);
  assert.doesNotMatch(out, /シートに対応が無いマスタ行/);
});

test('IDと名前の両方を変えると、古い行が取り残しになり新しい行が入る', (t) => {
  const ctx = useCsv(t, {
    'products.csv': `${PRODUCT_HEADER}\nP001,浄酎 300ml,300,35,瓶,本,3000,\n`,
  });
  run(ctx);

  // ID も名前も変える＝別の行として扱われる（手順書で注意している形）
  ctx.write({
    'products.csv': `${PRODUCT_HEADER}\nP009,浄酎 300ml 新,300,35,瓶,本,3000,\n`,
  });
  run(ctx);

  const orphans = rowsOf(report(ctx, 'orphan-masters.csv'));
  assert.equal(orphans.length, 1);
  assert.match(orphans[0], /^商品,P001,浄酎 300ml,/);

  const db = require('better-sqlite3')(ctx.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 2);
  db.close();
});
