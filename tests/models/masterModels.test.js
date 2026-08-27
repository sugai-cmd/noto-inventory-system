// 酒蔵マスタ・原酒マスタモデルの最小テスト（8-2の移行方針に対応する実装の動作確認）

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// src/config.js は process.env.DB_PATH をモジュール読込時に評価するため、
// 他のrequireより前にテスト専用の一時DBパスを設定する
const TEST_DB_PATH = path.resolve(__dirname, '..', '..', 'db', 'test-master-models.sqlite');
for (const ext of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + ext, { force: true });
process.env.DB_PATH = TEST_DB_PATH;

const { migrate } = require('../../src/db/migrate');
const breweryModel = require('../../src/models/breweryModel');
const rawSakeBrandModel = require('../../src/models/rawSakeBrandModel');

test.before(() => {
  migrate();
});

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + ext, { force: true });
});

test('breweryModel.create は8桁小文字英数字のuidを採番する', () => {
  const brewery = breweryModel.create({ name: 'テスト酒造' });
  assert.match(brewery.uid, /^[a-z0-9]{8}$/);
  assert.equal(brewery.name, 'テスト酒造');
});

test('rawSakeBrandModel.create はbreweryNameが既存酒蔵と正規化一致すればbrewery_idを解決する', () => {
  breweryModel.create({ name: '山田酒造' });
  // 全角/半角・前後空白の違いがあっても一致させる
  const brand = rawSakeBrandModel.create({ name: '銘柄X', breweryName: ' 山田酒造　' });
  assert.notEqual(brand.brewery_id, null);
  assert.equal(brand.brewery_name_raw, null);
});

test('rawSakeBrandModel.create は未登録の酒蔵名ならbrewery_idをNULLにしbrewery_name_rawへ退避する（6-6/8-2）', () => {
  const brand = rawSakeBrandModel.create({ name: '銘柄Y', breweryName: '存在しない酒蔵' });
  assert.equal(brand.brewery_id, null);
  assert.equal(brand.brewery_name_raw, '存在しない酒蔵');
});

test('rawSakeBrandModel.create はbreweryIdが渡されればそのまま使う', () => {
  const brewery = breweryModel.create({ name: '佐藤酒造' });
  const brand = rawSakeBrandModel.create({ name: '銘柄Z', breweryId: brewery.id });
  assert.equal(brand.brewery_id, brewery.id);
});

test('breweryModel.remove は削除の成否をbooleanで返す', () => {
  const brewery = breweryModel.create({ name: '削除用酒蔵' });
  assert.equal(breweryModel.remove(brewery.id), true);
  assert.equal(breweryModel.remove(brewery.id), false);
});
