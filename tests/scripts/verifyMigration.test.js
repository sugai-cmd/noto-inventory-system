// 答え合わせ（verify-migration.js）が、移行と同じ補正表を使うこと。
//
// 本番投入のあと、タンクモニターの「タンク1」「タンク2」「タンク3」が
// 「こちらに同じ名前がありません」と出た。容器マスタの名前は
// 「ステンレスタンク1」で、移行では正しく寄っている。
// 答え合わせだけが補正表を知らなかったので、直すところが無いものを
// 探すことになっていた。
//
// 件数の出し方も直した。以前は「13件中4件に差」と出していたが、
// 13は突き合わせた件数、4には名前が一致しなかった2件が混ざっていて、
// どこから来た数字か読めなかった。

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
const MATERIAL_HEADER =
  '資材ID,資材名,資材種別,単位,単価(円),ロット数,適正在庫数,初期在庫数,' +
  '発注先会社名,発注先住所,発注先担当者名,備考,リードタイム';

function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }
  return {
    dir,
    csvDir,
    dbPath: path.join(dir, 'verify.sqlite'),
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: path.join(dir, 'report'),
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'),
    },
  };
}

function migrate(ctx) {
  const r = spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial'],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `移行が失敗しました:\n${r.stdout}${r.stderr}`);
}

/** モニターのCSVを足してから答え合わせを動かす。実データの置き場には触らない */
function verify(ctx, monitorFiles) {
  for (const [name, content] of Object.entries(monitorFiles)) {
    fs.writeFileSync(path.join(ctx.csvDir, name), content, 'utf8');
  }
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'verify-migration.js')], {
    cwd: ROOT,
    env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath },
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `答え合わせが失敗しました:\n${out}`);
  return out;
}

test('タンクモニターの略称を、補正表で容器マスタの名前に寄せる', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv':
      `${TANK_HEADER}\n` +
      'T-001,ステンレスタンク1,ステンレスタンク,1000,浄溜所,稼働中,,100,100,35,\n' +
      'T-002,ステンレスタンク2,ステンレスタンク,1000,浄溜所,稼働中,,50,50,35,\n',
  });
  migrate(ctx);

  const out = verify(ctx, {
    'tank_monitor.csv':
      '浄酎タンク,アルコール度数,現在液量,最大液量\n' +
      'タンク1,35,100,1000\n' +
      'タンク2,35,80,1000\n',
  });

  // 以前は2件とも「こちらに同じ名前がありません」だった
  assert.match(out, /［補正表］タンク1 → ステンレスタンク1 として突き合わせました/);
  assert.doesNotMatch(out, /タンク1 … こちらに同じ名前がありません/);

  // 寄せたうえで、中身の差だけが出る（タンク2はシート80・こちら50）
  assert.match(out, /ステンレスタンク2|タンク2/);
  assert.match(out, /シート2件 → 突合2件/);
});

test('容器IDで書かれていても引ける', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\nT-001,ステンレスタンク1,ステンレスタンク,1000,浄溜所,稼働中,,100,100,35,\n`,
  });
  migrate(ctx);

  const out = verify(ctx, {
    'tank_monitor.csv': '浄酎タンク,アルコール度数,現在液量,最大液量\nT-001,35,100,1000\n',
  });

  assert.match(out, /シート1件 → 突合1件/);
  assert.doesNotMatch(out, /こちらに同じ名前がありません/);
});

test('本当に無い名前は、似ている候補を添えて出す', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv': `${TANK_HEADER}\nT-001,ステンレスタンク1,ステンレスタンク,1000,浄溜所,稼働中,,100,100,35,\n`,
  });
  migrate(ctx);

  const out = verify(ctx, {
    'tank_monitor.csv': '浄酎タンク,アルコール度数,現在液量,最大液量\nステンレスタンク9,35,100,1000\n',
  });

  // 黙って落とさない。どれを指しているのか探せるように候補を出す
  assert.match(out, /［未対応］ステンレスタンク9 … こちらに同じ名前がありません/);
  assert.match(out, /似ている名前: .*ステンレスタンク1/);
});

test('シートの2行が同じ行に寄ったら、そう言う', (t) => {
  const ctx = useCsv(t, {
    'materials.csv':
      `${MATERIAL_HEADER}\nMAT-001,30mlミニボトル(PE),容器,本,50,,,20,酒井硝子,,,,\n`,
  });
  migrate(ctx);

  // 実データの資材在庫モニターと同じ形。両方の書き方が並んでいる
  const out = verify(ctx, {
    'material_stock_monitor.csv':
      '資材名,現在庫数\n30mlミニボトル(PE),20\n30mlミニボトル,5\n',
  });

  // 片方だけ見て「合っている」と早合点しないよう、必ず言う
  assert.match(out, /［重複］30mlミニボトル は「30mlミニボトル\(PE\)」と同じ行に寄っています/);
});

test('差のある行には、こちらの数字の内訳を添える', (t) => {
  const ctx = useCsv(t, {
    'materials.csv': `${MATERIAL_HEADER}\nMAT-003,300mlガラス瓶,容器,本,281,,,1000,酒井硝子,,,,\n`,
    'material_stock_ledger.csv':
      '日付,資材履歴ID,資材名称,受払,数量,受払先,商品履歴ID,備考\n' +
      '2026-05-01,M2605-0001,300mlガラス瓶,入荷,100,酒井硝子,,\n' +
      '2026-05-02,M2605-0002,300mlガラス瓶,消費,20,,,\n' +
      '2026-05-03,M2605-0003,300mlガラス瓶,欠損,3,,,破損\n',
  });
  migrate(ctx);

  const out = verify(ctx, {
    'material_stock_monitor.csv': '資材名,現在庫数\n300mlガラス瓶,1000\n',
  });

  // 「差がある」で止まらず、初期値なのか台帳なのかがその場で分かること
  assert.match(out, /内訳: 初期1000 \+ 入荷100 - 消費20 - 欠損3 = 1077/);
});

test('タンクの内訳は、受入と払出で出す', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv':
      `${TANK_HEADER}\n` +
      'T-001,ステンレスタンク1,ステンレスタンク,1000,浄溜所,稼働中,,100,100,35,\n' +
      'T-004,一斗瓶2,斗瓶,19.9,浄溜所,空,,0,0,,\n',
    'tank_ledger.csv':
      '日付,受入元,受払,瓶詰め商品,払出先,数量(L),アルコール度数,商品履歴ID,蒸留ID,データ区分,備考\n' +
      '2026/06/12,ステンレスタンク1,容器移動,,一斗瓶2,-19.9,35%,,,運用中（リアルタイム）,\n',
  });
  migrate(ctx);

  const out = verify(ctx, {
    'tank_monitor.csv': '浄酎タンク,アルコール度数,現在液量,最大液量\nタンク1,35,100,1000\n',
  });

  assert.match(out, /内訳: 初期100 - 払出19\.9 = 80\.1/);
});

test('内訳は、ビューの数字と必ず一致する（受入元と払出先が同じ行があっても）', (t) => {
  const ctx = useCsv(t, {
    'tanks.csv':
      `${TANK_HEADER}\n` +
      'T-001,ステンレスタンク1,ステンレスタンク,1000,浄溜所,稼働中,,100,100,35,\n' +
      'T-004,一斗瓶2,斗瓶,19.9,浄溜所,空,,0,0,,\n',
    'tank_ledger.csv':
      '日付,受入元,受払,瓶詰め商品,払出先,数量(L),アルコール度数,商品履歴ID,蒸留ID,データ区分,備考\n' +
      '2026/06/12,ステンレスタンク1,容器移動,,一斗瓶2,-10,35%,,,運用中（リアルタイム）,\n' +
      // 受入元と払出先が同じ。ビューはこれを「受入」だけに数える
      '2026/06/13,ステンレスタンク1,容器移動,,ステンレスタンク1,-24,35%,,,運用中（リアルタイム）,\n',
  });
  migrate(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const view = db
    .prepare("SELECT current_volume_l FROM v_tank_monitor WHERE name = 'ステンレスタンク1'")
    .get().current_volume_l;
  db.close();

  const out = verify(ctx, {
    'tank_monitor.csv': `浄酎タンク,アルコール度数,現在液量,最大液量\nタンク1,35,999,1000\n`,
  });

  // 内訳の右辺が、ビューの数字と一致すること。
  // 素直に2つのSUMで書くと同じタンクの行が相殺され、24Lずれる
  assert.equal(view, 114);
  assert.match(out, /内訳: 初期100 \+ 受入24 - 払出10 = 114/);

  // その行があること自体も伝える（残量が実物より多く出るため）
  assert.match(out, /受入元と払出先が同じタンクの行/);
  assert.match(out, /ステンレスタンク1: 24L/);
  assert.match(out, /合計 24L が多く数えられています/);
});

test('未納税移出は仕掛品を減らす（シートのモニターは引いていない）', (t) => {
  const ctx = useCsv(t, {
    'products.csv':
      '商品ID,商品名称,容量(ml),度数,容器種別,単位,上代(円),JANコード\n' +
      'P001,浄酎 700ml,700,35,瓶,本,7000,\n',
    'product_stock_ledger.csv':
      '日付,商品履歴ID,商品名,受払,数量,受払先,受注番号,保管場所,データ区分,備考\n' +
      '2026-05-01,L2605-0001,浄酎 700ml,瓶詰,100,,,,,\n' +
      '2026-05-02,L2605-0002,浄酎 700ml,未納税移出,30,L2605-0001,,熟成室,,\n',
  });
  migrate(ctx);

  const out = verify(ctx, {
    'product_stock_monitor.csv': '商品名称,商品,仕掛品\n浄酎 700ml,0,100\n',
  });

  // 0013 で足した区分。内訳に出ないと、差の理由が分からないままになる
  assert.match(out, /内訳: 初期0 \+ 瓶詰100 - 未納税移出30 = 70/);
});

test('まとめの件数が、どこから来た数字か分かること', (t) => {
  const ctx = useCsv(t, {
    'materials.csv': `${MATERIAL_HEADER}\nMAT-001,300mlガラス瓶,容器,本,281,,,1000,酒井硝子,,,,\n`,
  });
  migrate(ctx);

  const out = verify(ctx, {
    'material_stock_monitor.csv': '資材名,現在庫数\n300mlガラス瓶,900\n知らない資材,10\n',
  });

  // 以前は「2件中2件に差」で、2が突合数なのか全体なのか読めなかった
  assert.match(out, /資材在庫: シート2件 → 突合1件 \/ 差1件 \/ 名前が一致せず1件/);
});
