// 移行SQLを「実データと同じ形」で通す試験。
//
// **本番が起動しなくなった事故の再発防止。**
// 0027 の報告番号の一括採番が、既に使われている番号と衝突して UNIQUE 制約で落ち、
// migrate() が例外を投げ、サーバーごと起動しなくなった（画面が一切出ない）。
//
// これまでの試験は「既存の報告番号が無い」自作の fixture だったので、
// この不具合を1つも捕まえられなかった。**実データの形をそのまま写す。**
//
// 実データ（サーバー機）の形:
//   既存の報告番号は report_month の**翌月**で採番されている（旧シート由来）
//     2026-05 → C2606-0001〜0005 / 2026-06 → C2607-0001〜0005
//     2026-07 → C2608-0001〜0006 / 2026-08 → C2609-0001〜0006
//   未採番が 2026-08 に3件、2026-09 に3件

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const UNTIL_0026 = (f) => f <= '0026_order_cancel.sql';

/** 利用者の機と同じ「0026 まで当たったDB」を作る */
function dbAt0026() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'test.sqlite');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  for (const f of FILES.filter(UNTIL_0026)) {
    db.exec(fs.readFileSync(path.join(DIR, f), 'utf8'));
  }
  db.prepare("INSERT INTO customers (uid, name) VALUES ('cust0001', '委託先')").run();
  db.prepare("INSERT INTO products (uid, name, volume_ml) VALUES ('prod0001', '浄酎', 300)").run();
  return db;
}

/** 0027 以降を順に当てる。落ちたファイル名が分かるようにする */
function applyRest(db) {
  for (const f of FILES.filter((x) => !UNTIL_0026(x))) {
    try {
      db.exec(fs.readFileSync(path.join(DIR, f), 'utf8'));
    } catch (err) {
      throw new Error(`${f} で失敗: ${err.message}`);
    }
  }
}

function seedReports(db, rows) {
  const ins = db.prepare(
    `INSERT INTO consignment_reports (id, report_month, report_no, customer_id, product_id, quantity)
     VALUES (?, ?, ?, 1, 1, 1)`
  );
  for (const r of rows) ins.run(...r);
}

/** 実データと同じ並び */
const REAL_SHAPE = [
  [1, '2026-05', 'C2606-0001'], [2, '2026-05', 'C2606-0002'], [3, '2026-05', 'C2606-0003'],
  [4, '2026-05', 'C2606-0004'], [5, '2026-05', 'C2606-0005'],
  [6, '2026-06', 'C2607-0001'], [7, '2026-06', 'C2607-0002'], [8, '2026-06', 'C2607-0003'],
  [9, '2026-06', 'C2607-0004'], [10, '2026-06', 'C2607-0005'],
  [11, '2026-07', 'C2608-0001'], [12, '2026-07', 'C2608-0002'], [13, '2026-07', 'C2608-0003'],
  [14, '2026-07', 'C2608-0004'], [15, '2026-07', 'C2608-0005'], [16, '2026-07', 'C2608-0006'],
  [17, '2026-08', 'C2609-0001'], [18, '2026-08', 'C2609-0002'], [19, '2026-08', 'C2609-0003'],
  [20, '2026-08', 'C2609-0004'], [21, '2026-08', 'C2609-0005'], [22, '2026-08', 'C2609-0006'],
  [23, '2026-08', null], [24, '2026-08', null], [25, '2026-08', null],
  [26, '2026-09', null], [27, '2026-09', null], [28, '2026-09', null],
];

const numbers = (db) =>
  Object.fromEntries(
    db.prepare('SELECT id, report_no FROM consignment_reports ORDER BY id').all()
      .map((r) => [r.id, r.report_no])
  );

test('実データと同じ形で、0027 から 0029 まで通る', () => {
  const db = dbAt0026();
  seedReports(db, REAL_SHAPE);

  // 直す前はここで UNIQUE 制約違反になり、サーバーが起動しなくなっていた
  applyRest(db);

  const no = numbers(db);
  // 未採番の 2026-08 分は、既存の C2609-0006 の続きから
  assert.equal(no[23], 'C2609-0007');
  assert.equal(no[24], 'C2609-0008');
  assert.equal(no[25], 'C2609-0009');
  // 2026-09 分は翌月の C2610 から。**既存の C2609-0001 と衝突しない**
  assert.equal(no[26], 'C2610-0001');
  assert.equal(no[27], 'C2610-0002');
  assert.equal(no[28], 'C2610-0003');
});

test('既に番号がある行は1つも書き換えない', () => {
  const db = dbAt0026();
  seedReports(db, REAL_SHAPE);
  applyRest(db);

  const no = numbers(db);
  for (const [id, , before] of REAL_SHAPE) {
    if (before == null) continue;
    assert.equal(no[id], before, `id=${id} の番号が書き換わっています`);
  }
});

test('報告番号が重複しない', () => {
  const db = dbAt0026();
  seedReports(db, REAL_SHAPE);
  applyRest(db);

  const dup = db
    .prepare(
      `SELECT report_no, COUNT(*) AS n FROM consignment_reports
        WHERE report_no IS NOT NULL GROUP BY report_no HAVING n > 1`
    )
    .all();
  assert.deepEqual(dup, [], '重複した報告番号があります');
});

test('報告月は列の制約で守られている（移行が読めない値に当たらない）', () => {
  // report_month は NOT NULL ＋ GLOB 'YYYY-MM' なので、読めない値は入らない。
  // 移行側にも「読めなければ採番しない」を入れてあるが、それが効く前にここで弾かれる。
  // **落とさない**という方針を、制約の側からも確かめておく（落ちると起動できない）
  const db = dbAt0026();
  assert.throws(
    () => seedReports(db, [[1, '不明', null]]),
    /CHECK constraint failed: report_month/
  );
  assert.throws(
    () => seedReports(db, [[2, null, null]]),
    /NOT NULL constraint failed/
  );
});

test('未採番だけの月でも、1から振る', () => {
  const db = dbAt0026();
  seedReports(db, [
    [1, '2026-05', null],
    [2, '2026-05', null],
    [3, '2026-06', null],
  ]);

  applyRest(db);

  const no = numbers(db);
  assert.equal(no[1], 'C2606-0001');
  assert.equal(no[2], 'C2606-0002');
  assert.equal(no[3], 'C2607-0001');
});

test('報告が1件も無くても通る', () => {
  const db = dbAt0026();
  applyRest(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM consignment_reports').get().n, 0);
});
