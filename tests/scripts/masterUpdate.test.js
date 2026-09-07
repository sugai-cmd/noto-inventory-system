// 移行を流し直したとき、既にあるマスタがシートの内容で更新されること。
//
// これまでは同じ名前の行があると「既存」として飛ばしていたため、
// シート側で支払いサイトを直しても、流し直してもデータベースに反映されなかった。
// （実運用で 得意先マスタ: 読込156 / 投入0 / 既存156 となっていた）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CSV_DIR = path.join(ROOT, 'scripts', 'data', 'csv');
const REPORT_DIR = path.join(ROOT, 'scripts', 'migration-report');

const HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';

/** CSVディレクトリを空にして、この試験用のファイルだけ置く */
function useCsv(t, files) {
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-saved-'));
  for (const f of fs.readdirSync(CSV_DIR)) {
    if (f.endsWith('.csv')) fs.renameSync(path.join(CSV_DIR, f), path.join(saved, f));
  }
  t.after(() => {
    for (const f of fs.readdirSync(CSV_DIR)) {
      if (f.endsWith('.csv')) fs.rmSync(path.join(CSV_DIR, f));
    }
    for (const f of fs.readdirSync(saved)) {
      fs.renameSync(path.join(saved, f), path.join(CSV_DIR, f));
    }
    fs.rmSync(saved, { recursive: true, force: true });
  });
  writeCsv(files);
}

function writeCsv(files) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(CSV_DIR, name), content, 'utf8');
  }
}

function run(dbPath) {
  return execFileSync('node', [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
}

test('流し直すと、シートの内容でマスタが更新される', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-'));
  const dbPath = path.join(dir, 'mu.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1回目: 支払いサイトが空欄の状態で投入する
  useCsv(t, {
    'customers.csv': `${HEADER}\nC0105,カナカン酒類福井,卸売業者,卸問屋,0.7,福井市重立町28字辻54,,,,,,,,,\n`,
  });
  run(dbPath);

  const db = require('better-sqlite3')(dbPath);
  const before = db.prepare("SELECT * FROM customers WHERE name = 'カナカン酒類福井'").get();
  assert.equal(before.payment_term_months, null);

  // 画面から本店を設定した状態を作る（シートには無い列）
  db.prepare("INSERT INTO customers (uid, code, name) VALUES ('aaaaaaaa','C0900','カナカン')").run();
  const parentId = db.prepare("SELECT id FROM customers WHERE name = 'カナカン'").get().id;
  db.prepare('UPDATE customers SET parent_id = ? WHERE id = ?').run(parentId, before.id);
  db.close();

  // 2回目: シート側で支払いサイトを埋めて流し直す
  writeCsv({
    'customers.csv': `${HEADER}\nC0105,カナカン酒類福井,卸売業者,卸問屋,0.7,福井市重立町28字辻54,翌々月,末日,月初に郵送,備考を足した,田中,,,,\n`,
  });
  const out = run(dbPath);

  assert.match(out, /得意先マスタ: 読込1 \/ 投入0 \/ 更新1/);

  const db2 = require('better-sqlite3')(dbPath);
  const after = db2.prepare("SELECT * FROM customers WHERE name = 'カナカン酒類福井'").get();

  // シートの内容が反映される
  assert.equal(after.payment_term_months, 2);
  assert.equal(after.payment_term_day, '末日');
  assert.equal(after.invoice_due_note, '月初に郵送');
  assert.equal(after.note, '備考を足した');
  assert.equal(after.sales_rep, '田中');

  // シートに無い列（画面で設定した本店）は消えない
  assert.equal(after.parent_id, parentId);

  // uid は作り直されない
  assert.equal(after.uid, before.uid);
  db2.close();

  // 何がどう変わったかがレポートに出る
  const updates = fs.readFileSync(path.join(REPORT_DIR, 'master-updates.csv'), 'utf8');
  assert.match(updates, /カナカン酒類福井,payment_term_months,,2/);
  assert.match(updates, /カナカン酒類福井,payment_term_day,,末日/);
});

test('在庫計算の起点になる列は、既存の行に上書きしない', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu2-'));
  const dbPath = path.join(dir, 'mu2.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const matHeader =
    '資材ID,資材名,資材種別,単位,単価(円),ロット数,適正在庫数,初期在庫数,' +
    '発注先会社名,発注先住所,発注先担当者名,備考,リードタイム';

  useCsv(t, {
    'materials.csv': `${matHeader}\nMAT-003,300mlガラス瓶,容器,本,281,20,100,1000,酒井硝子,,,,3週間\n`,
  });
  run(dbPath);

  // 2回目: 初期在庫数と単価をシート側で変える
  writeCsv({
    'materials.csv': `${matHeader}\nMAT-003,300mlガラス瓶,容器,本,300,20,150,9999,酒井硝子,,,,3週間\n`,
  });
  run(dbPath);

  const db = require('better-sqlite3')(dbPath);
  const row = db.prepare("SELECT * FROM materials WHERE name = '300mlガラス瓶'").get();
  // 単価・適正在庫は更新される
  assert.equal(row.unit_price, 300);
  assert.equal(row.proper_stock_qty, 150);
  // 初期在庫数は上書きしない（在庫計算の起点なので、動かすと現在庫が変わる）
  assert.equal(row.initial_stock, 1000);
  db.close();
});

test('タンクの初期在庫量と現在液量も上書きしない', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu3-'));
  const dbPath = path.join(dir, 'mu3.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const h = '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,現在液量(L),理論アルコール度数,備考';
  useCsv(t, { 'tanks.csv': `${h}\nT-001,ステンレスタンク1,ステンレスタンク,213,浄溜所,稼働中,,84,90,0.34,\n` });
  run(dbPath);

  writeCsv({ 'tanks.csv': `${h}\nT-001,ステンレスタンク1,ステンレスタンク,220,熟成室,空,,999,999,0.5,移設した\n` });
  run(dbPath);

  const db = require('better-sqlite3')(dbPath);
  const row = db.prepare("SELECT * FROM tanks WHERE code = 'T-001'").get();
  assert.equal(row.max_volume_l, 220);      // 更新される
  assert.equal(row.location, '熟成室');       // 更新される
  assert.equal(row.note, '移設した');         // 更新される
  assert.equal(row.initial_volume_l, 84);    // 起点なので触らない
  assert.equal(row.current_volume_l, 90);    // 同上（残量は台帳から計算する）
  db.close();
});

test('掛率が空欄なら空欄のまま入る（1.0で埋めない）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu4-'));
  const dbPath = path.join(dir, 'mu4.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  useCsv(t, {
    'customers.csv':
      `${HEADER}\n` +
      'C0101,カナカン酒類富山,卸売業者,卸問屋,,富山市,,,,,,,,,\n' +
      'C0200,直売所,小売,小売,1,珠洲市,当月,末日,,,,,,,\n',
  });
  run(dbPath);

  const db = require('better-sqlite3')(dbPath);
  // 空欄は空欄のまま。1.0（上代どおり）は消費者向けで実在する値なので、
  // 空を1で埋めると「まだ決めていない」支店が上代どおりに見えてしまい、
  // 本店から掛率を引き継げなくなる。
  assert.equal(db.prepare("SELECT markup_rate AS r FROM customers WHERE name = 'カナカン酒類富山'").get().r, null);
  // 1 と書いてあるものは 1 のまま入る
  assert.equal(db.prepare("SELECT markup_rate AS r FROM customers WHERE name = '直売所'").get().r, 1);
  db.close();
});

test('顧客リストの「次回todo/課題」は、流し直しても積み上がらない', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu5-'));
  const dbPath = path.join(dir, 'mu5.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const listHeader = 'No.,得意先,業態,担当者,郵便番号,住所,電話番号,次回todo/課題,最新訪問日';
  const files = {
    'customers.csv': `${HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'customer_list.csv': `${listHeader}\n1,カナカン酒類石川,卸問屋,山本,9200000,金沢市,076-000-0000,棚割の相談,2026-08-01\n`,
  };
  useCsv(t, files);
  run(dbPath);
  // 営業メモは --reset の対象ではないので、そのまま流し直す
  run(dbPath);

  const db = require('better-sqlite3')(dbPath);
  const notes = db.prepare("SELECT body FROM customer_notes WHERE body = '棚割の相談'").all();
  assert.equal(notes.length, 1);
  // 連絡先は取り込まれている
  const c = db.prepare("SELECT phone, postal_code FROM customers WHERE name = 'カナカン酒類石川'").get();
  assert.equal(c.phone, '076-000-0000');
  assert.equal(c.postal_code, '9200000');
  db.close();
});
