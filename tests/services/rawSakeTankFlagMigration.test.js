// 0029 の移行が、0028 の値と今までの判定（容器IDの接頭辞）を正しく写すこと。
//
// 0028 は tanks.contents_kind（浄酎/原酒/残渣）を足したが、残渣まで対象にしたのは
// 行き過ぎだった。0029 で「原酒を入れる容器かどうか」だけに絞り、浄酎・残渣は
// 容器IDの接頭辞に戻す。
//
// **利用者の機はすでに 0028 まで当たっている。** 0028 → 0029 の順に当てたときに
// 原酒タンクが原酒のまま残ることを押さえる（ここがずれると、取り込んだ瞬間に
// 原酒入荷・蒸留の画面から容器が消える）。
//
// 試験にSQLを写すと、マイグレーションを緩めても試験は通ってしまう。
// 実際のファイルを読んで、そこに書いてある文を走らせる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('../helpers/appHarness');

function statementsOf(file, pattern) {
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', file), 'utf8');
  const stmts = sql.split(';').filter((s) => pattern.test(s));
  assert.ok(stmts.length, `${file} に ${pattern} の文があること`);
  return stmts.map((s) => `${s.trim()};`);
}

const harness = createHarness('test-raw-sake-tank-flag.sqlite');

let db;

test.before(async () => {
  ({ db } = await harness.setup((db, generateUid) => {
    // 実データの並びを写す。SP（原酒ポリ）と JP（出荷用ポリ）は container_type が
    // 同じ 'PE'、一斗瓶は容器IDが G- ではなく T- で採番されている
    const rows = [
      ['SP-001', '原酒ポリ1', 'PE'],
      ['SP-026', '原酒ポリ26', 'PE'],
      ['U-001', '残渣保管タンク1', 'PP'],
      ['U-006', '残渣保管タンク6', 'PP'],
      ['T-001', 'ステンレスタンク1', 'ステンレスタンク'],
      ['T-004', '一斗瓶1', '斗瓶'],
      ['JP-003', '出荷用ポリタンク3', 'PE'],
      ['Q-001', 'テナー1', 'QBテナー'],
      ['B-001', '樽1', '木樽'],
      ['DISTL-01', '蒸留機1', '蒸留機'],
    ];
    const insert = db.prepare(
      'INSERT INTO tanks (uid, code, name, container_type) VALUES (?, ?, ?, ?)'
    );
    for (const [code, name, type] of rows) {
      insert.run(generateUid(db, 'tanks'), code, name, type);
    }
    // ハーネスの投入は移行のあとなので、ここでは印が空のまま入る
    db.exec('UPDATE tanks SET is_raw_sake_tank = NULL');
  }));
});

test.after(async () => {
  await harness.teardown();
});

/** 0028 を当て直した状態を作る（列はもう無いので、一時列で代用する） */
function replay0028() {
  db.exec('ALTER TABLE tanks ADD COLUMN contents_kind TEXT');
  for (const stmt of statementsOf('0028_tank_contents_kind.sql', /UPDATE tanks/)) {
    db.exec(stmt);
  }
}

function apply0029() {
  for (const stmt of statementsOf('0029_raw_sake_tank_flag.sql', /UPDATE tanks/)) {
    db.exec(stmt);
  }
}

const flags = () =>
  Object.fromEntries(
    db.prepare('SELECT code, is_raw_sake_tank AS f FROM tanks').all().map((r) => [r.code, r.f])
  );

test('0028 → 0029 の順に当てても、SP- は原酒のまま残る', () => {
  replay0028();
  // 0028 の結果を前提として確かめる（ここがずれていたら 0029 の写しも意味が無い）
  assert.equal(
    db.prepare("SELECT contents_kind AS k FROM tanks WHERE code = 'SP-001'").get().k,
    '原酒'
  );

  apply0029();
  const f = flags();

  assert.equal(f['SP-001'], 1);
  assert.equal(f['SP-026'], 1);

  // 残渣は印の対象外。容器IDの U- で決まるので、印は 0 のままでよい
  assert.equal(f['U-001'], 0);
  assert.equal(f['U-006'], 0);

  // 容器種別が 'PE' でも、SP でなければ原酒にしない（JPとSPは種別が同じ）
  assert.equal(f['JP-003'], 0);
  // 一斗瓶は T- で採番されている
  assert.equal(f['T-004'], 0);
  assert.equal(f['T-001'], 0);
  assert.equal(f['Q-001'], 0);
  assert.equal(f['B-001'], 0);
  assert.equal(f['DISTL-01'], 0);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tanks WHERE is_raw_sake_tank IS NULL').get().n,
    0,
    '埋め残しが無いこと'
  );
});

test('0028 で原酒にした SP- 以外の容器も、印を引き継ぐ', () => {
  // #61 を取り込んだあとで「中身の種類＝原酒」にして登録した QBテナーが消えないこと
  db.prepare('UPDATE tanks SET is_raw_sake_tank = NULL').run();
  db.prepare("UPDATE tanks SET contents_kind = '原酒' WHERE code = 'Q-001'").run();

  apply0029();

  assert.equal(flags()['Q-001'], 1, '0028 で原酒にした容器の印が落ちています');
});

test('0028 を当てていない行（移行ローダー経由）は容器IDで決まる', () => {
  // scripts/loaders/tanks.js はどちらの列も入れずにタンクを作る
  db.prepare('UPDATE tanks SET is_raw_sake_tank = NULL, contents_kind = NULL').run();

  apply0029();
  const f = flags();

  assert.equal(f['SP-001'], 1, '列が空の SP- が原酒から外れています');
  assert.equal(f['JP-003'], 0);
});

test('0029 は contents_kind を落とす', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../db/migrations/0029_raw_sake_tank_flag.sql'),
    'utf8'
  );
  assert.match(sql, /ALTER TABLE tanks DROP COLUMN contents_kind/);

  // 実際のスキーマにも残っていないこと（残すと「3種類あるように見えて
  // 原酒しか効かない」列になり、次に読む人を必ず誤らせる）
  const columns = db.prepare('PRAGMA table_info(tanks)').all().map((c) => c.name);
  assert.ok(columns.includes('is_raw_sake_tank'));
});
