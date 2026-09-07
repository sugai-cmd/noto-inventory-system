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

const HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';

/**
 * この試験だけのCSV置き場とレポート出力先を用意する。
 * リポジトリの scripts/data/csv を書き換えると、並行して走る他の試験と
 * 取り合いになるので、環境変数で差し替える。
 */
function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  const reportDir = path.join(dir, 'report');
  fs.mkdirSync(csvDir);

  const env = {
    MIGRATION_CSV_DIR: csvDir,
    MIGRATION_REPORT_DIR: reportDir,
    MIGRATION_ALIASES: path.join(dir, 'aliases.json'), // 置かない＝補正表なし
  };
  const write = (contents) => {
    for (const [name, content] of Object.entries(contents)) {
      fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
    }
  };
  write(files);
  return { env, reportDir, write, dbPath: path.join(dir, 'test.sqlite') };
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

test('流し直すと、シートの内容でマスタが更新される', (t) => {
  // 1回目: 支払いサイトが空欄の状態で投入する
  const ctx = useCsv(t, {
    'customers.csv': `${HEADER}\nC0105,カナカン酒類福井,卸売業者,卸問屋,0.7,福井市重立町28字辻54,,,,,,,,,\n`,
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const before = db.prepare("SELECT * FROM customers WHERE name = 'カナカン酒類福井'").get();
  assert.equal(before.payment_term_months, null);

  // 画面から本店を設定した状態を作る（シートには無い列）
  db.prepare("INSERT INTO customers (uid, code, name) VALUES ('aaaaaaaa','C0900','カナカン')").run();
  const parentId = db.prepare("SELECT id FROM customers WHERE name = 'カナカン'").get().id;
  db.prepare('UPDATE customers SET parent_id = ? WHERE id = ?').run(parentId, before.id);
  db.close();

  // 2回目: シート側で支払いサイトを埋めて流し直す
  ctx.write({
    'customers.csv': `${HEADER}\nC0105,カナカン酒類福井,卸売業者,卸問屋,0.7,福井市重立町28字辻54,翌々月,末日,月初に郵送,備考を足した,田中,,,,\n`,
  });
  const out = run(ctx);

  assert.match(out, /得意先マスタ: 読込1 \/ 投入0 \/ 更新1/);

  const db2 = require('better-sqlite3')(ctx.dbPath);
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
  const updates = report(ctx, 'master-updates.csv');
  assert.match(updates, /カナカン酒類福井,payment_term_months,,2/);
  assert.match(updates, /カナカン酒類福井,payment_term_day,,末日/);
});

test('在庫計算の起点になる列は、既存の行に上書きしない', (t) => {
  const matHeader =
    '資材ID,資材名,資材種別,単位,単価(円),ロット数,適正在庫数,初期在庫数,' +
    '発注先会社名,発注先住所,発注先担当者名,備考,リードタイム';

  const ctx = useCsv(t, {
    'materials.csv': `${matHeader}\nMAT-003,300mlガラス瓶,容器,本,281,20,100,1000,酒井硝子,,,,3週間\n`,
  });
  run(ctx);

  // 2回目: 初期在庫数と単価をシート側で変える
  ctx.write({
    'materials.csv': `${matHeader}\nMAT-003,300mlガラス瓶,容器,本,300,20,150,9999,酒井硝子,,,,3週間\n`,
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const row = db.prepare("SELECT * FROM materials WHERE name = '300mlガラス瓶'").get();
  // 単価・適正在庫は更新される
  assert.equal(row.unit_price, 300);
  assert.equal(row.proper_stock_qty, 150);
  // 初期在庫数は上書きしない（在庫計算の起点なので、動かすと現在庫が変わる）
  assert.equal(row.initial_stock, 1000);
  db.close();
});

test('タンクの初期在庫量と現在液量も上書きしない', (t) => {
  const h = '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,現在液量(L),理論アルコール度数,備考';
  const ctx = useCsv(t, { 'tanks.csv': `${h}\nT-001,ステンレスタンク1,ステンレスタンク,213,浄溜所,稼働中,,84,90,0.34,\n` });
  run(ctx);

  ctx.write({ 'tanks.csv': `${h}\nT-001,ステンレスタンク1,ステンレスタンク,220,熟成室,空,,999,999,0.5,移設した\n` });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const row = db.prepare("SELECT * FROM tanks WHERE code = 'T-001'").get();
  assert.equal(row.max_volume_l, 220);      // 更新される
  assert.equal(row.location, '熟成室');       // 更新される
  assert.equal(row.note, '移設した');         // 更新される
  assert.equal(row.initial_volume_l, 84);    // 起点なので触らない
  assert.equal(row.current_volume_l, 90);    // 同上（残量は台帳から計算する）
  db.close();
});

test('掛率が空欄なら空欄のまま入る（1.0で埋めない）', (t) => {
  const ctx = useCsv(t, {
    'customers.csv':
      `${HEADER}\n` +
      'C0101,カナカン酒類富山,卸売業者,卸問屋,,富山市,,,,,,,,,\n' +
      'C0200,直売所,小売,小売,1,珠洲市,当月,末日,,,,,,,\n',
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  // 空欄は空欄のまま。1.0（上代どおり）は消費者向けで実在する値なので、
  // 空を1で埋めると「まだ決めていない」支店が上代どおりに見えてしまい、
  // 本店から掛率を引き継げなくなる。
  assert.equal(db.prepare("SELECT markup_rate AS r FROM customers WHERE name = 'カナカン酒類富山'").get().r, null);
  // 1 と書いてあるものは 1 のまま入る
  assert.equal(db.prepare("SELECT markup_rate AS r FROM customers WHERE name = '直売所'").get().r, 1);
  db.close();
});

test('顧客リストの「次回todo/課題」は、流し直しても積み上がらない', (t) => {
  const listHeader = 'No.,得意先,業態,担当者,郵便番号,住所,電話番号,次回todo/課題,最新訪問日';
  const files = {
    'customers.csv': `${HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'customer_list.csv': `${listHeader}\n1,カナカン酒類石川,卸問屋,山本,9200000,金沢市,076-000-0000,棚割の相談,2026-08-01\n`,
  };
  const ctx = useCsv(t, files);
  run(ctx);
  // 営業メモは --reset の対象ではないので、そのまま流し直す
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const notes = db.prepare("SELECT body FROM customer_notes WHERE body = '棚割の相談'").all();
  assert.equal(notes.length, 1);
  // 連絡先は取り込まれている
  const c = db.prepare("SELECT phone, postal_code FROM customers WHERE name = 'カナカン酒類石川'").get();
  assert.equal(c.phone, '076-000-0000');
  assert.equal(c.postal_code, '9200000');
  db.close();
});

test('顧客IDを保ったまま得意先名を変えると、行が増えずに改名される', (t) => {
  const orderHeader =
    '受注番号,受注日,得意先名,商品名,本数,単価,掛け率,売価,送料,合計(税込),納入希望日,' +
    '請求日,入金予定日,入金日,販売方法,納品方法,ステータス,配送先,納品日（発送日、配達日）,備考,ID';
  const productHeader = '商品ID,商品名称,容量(ml),度数,容器種別,単位,上代(円),JANコード';
  const order = (customer) =>
    `${orderHeader}\nD2605-0001,2026-05-01,${customer},JOCHU White NOTO 35 300ml,6,3000,0.7,` +
    '18000,0,19800,2026-05-10,,,,直販,宅配,完了,,,,\n';

  const ctx = useCsv(t, {
    'customers.csv': `${HEADER}\nC0080,松本,小売,酒販店,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'products.csv': `${productHeader}\nP001,JOCHU White NOTO 35 300ml,300,35,瓶,本,3000,\n`,
    'orders.csv': order('松本'),
  });
  run(ctx);

  const db = require('better-sqlite3')(ctx.dbPath);
  const before = db.prepare("SELECT id FROM customers WHERE name = '松本'").get();
  const orderCount = db.prepare('SELECT COUNT(*) c FROM orders WHERE customer_id = ?').get(before.id).c;
  assert.ok(orderCount > 0, '受注が紐付いていること（前提）');
  db.close();

  // シート側で名前だけ直す。顧客IDは変えない
  ctx.write({
    'customers.csv': `${HEADER}\nC0080,株式会社松本,小売,酒販店,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'products.csv': `${productHeader}\nP001,JOCHU White NOTO 35 300ml,300,35,瓶,本,3000,\n`,
    'orders.csv': order('株式会社松本'),
  });
  const out = run(ctx);

  // 新しい行ではなく、同じ行の更新として扱われる
  assert.match(out, /得意先マスタ: 読込1 \/ 投入0 \/ 更新1/);

  const db2 = require('better-sqlite3')(ctx.dbPath);
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM customers').get().c, 1);

  const after = db2.prepare("SELECT id, name FROM customers WHERE code = 'C0080'").get();
  assert.equal(after.name, '株式会社松本');
  assert.equal(after.id, before.id, '同じ行であること（受注の参照が切れない）');

  // 受注は同じ得意先を指したまま
  assert.equal(
    db2.prepare('SELECT COUNT(*) c FROM orders WHERE customer_id = ?').get(before.id).c,
    orderCount
  );
  db2.close();

  const updates = report(ctx, 'master-updates.csv');
  assert.match(updates, /得意先マスタ,株式会社松本,name,松本,株式会社松本/);
});
