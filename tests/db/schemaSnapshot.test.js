// db/schema.sql が、migrations を当てた結果と一致していること。
//
// schema.sql は適用されないドキュメントだが、一番それらしく見えるので
// 実装や調査のときに最初に読まれる。古いままだと、間違った式を読んで
// 間違った結論を出す。
//
// 実際に起きた: v_product_stock の仕掛品の式に 0013 で「未納税移出」が
// 足されていたのに schema.sql は 0001 のままだったので、在庫の差の原因を
// 読み違えた。67個中39個がずれていた。
// ずれたまま気づけないのが問題なので、ここで止める。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { buildSchema, SCHEMA_PATH } = require('../../scripts/dump-schema');

test('db/schema.sql が migrations と一致している', () => {
  const built = buildSchema();
  const current = fs.readFileSync(SCHEMA_PATH, 'utf8');

  assert.equal(
    current,
    built,
    'db/schema.sql が migrations とずれています。node scripts/dump-schema.js を実行して更新してください'
  );
});

test('書き出した内容に、後から足した定義が入っている', () => {
  const built = buildSchema();

  // 0013: 未納税移出は仕掛品を減らす
  assert.match(built, /WHEN l\.txn_type = '未納税移出' THEN -l\.quantity/);
  // 0003: 資材の棚卸調整・欠損
  assert.match(built, /WHEN l\.txn_type = '棚卸調整' THEN l\.quantity/);
  // 0015: 原酒マスタの原酒ID
  assert.match(built, /raw_sake_brands/);
  assert.match(built, /idx_raw_sake_brands_name/);
});

test('schema_migrations は書き出さない（適用の記録であってスキーマではない）', () => {
  assert.doesNotMatch(buildSchema(), /CREATE TABLE schema_migrations/);
});
