// 0028 の移行が、いまの判定（容器IDの接頭辞）をそのまま写すこと。
//
// 移行の前後で挙動が変わると、原酒入荷・蒸留・残渣回収・棚卸の画面から
// 既存の容器が黙って消える（どれも中身の種類で絞るようになる）。
//
// 試験にSQLを写すと、マイグレーションを緩めても試験は通ってしまう。
// 実際のファイルを読んで、そこに書いてある文を走らせる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('../helpers/appHarness');

function backfillSql() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../db/migrations/0028_tank_contents_kind.sql'),
    'utf8'
  );
  const stmt = sql.split(';').find((s) => /UPDATE tanks/.test(s));
  assert.ok(stmt, '0028 に contents_kind を埋めるUPDATE文があること');
  return `${stmt.trim()};`;
}

const harness = createHarness('test-tank-contents-migration.sqlite');

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
    // ハーネスの投入は移行のあとなので、ここでは列が空のまま入る
    db.exec('UPDATE tanks SET contents_kind = NULL');
  }));
});

test.after(async () => {
  await harness.teardown();
});

test('SP- は原酒、U- は残渣、それ以外は浄酎になる', () => {
  db.exec(backfillSql());

  const kinds = Object.fromEntries(
    db.prepare('SELECT code, contents_kind FROM tanks').all().map((r) => [r.code, r.contents_kind])
  );

  assert.equal(kinds['SP-001'], '原酒');
  assert.equal(kinds['SP-026'], '原酒');
  assert.equal(kinds['U-001'], '残渣');
  assert.equal(kinds['U-006'], '残渣');

  // 容器種別が 'PE' でも、SP でなければ原酒にしない（JPとSPは種別が同じ）
  assert.equal(kinds['JP-003'], '浄酎');
  // 一斗瓶は T- で採番されている。接頭辞どおり浄酎に入る
  assert.equal(kinds['T-004'], '浄酎');
  assert.equal(kinds['T-001'], '浄酎');
  assert.equal(kinds['Q-001'], '浄酎');
  assert.equal(kinds['B-001'], '浄酎');
  assert.equal(kinds['DISTL-01'], '浄酎');

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tanks WHERE contents_kind IS NULL').get().n,
    0,
    '埋め残しが無いこと'
  );
});

test('すでに値が入っている行は上書きしない', () => {
  // 利用者がマスタで直した中身の種類を、再実行で元に戻してしまわないこと
  db.prepare("UPDATE tanks SET contents_kind = '原酒' WHERE code = 'Q-001'").run();
  db.exec(backfillSql());

  assert.equal(
    db.prepare("SELECT contents_kind AS k FROM tanks WHERE code = 'Q-001'").get().k,
    '原酒'
  );
});
