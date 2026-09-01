// 原酒マスタ（raw_sake_brands）
//
// 酒蔵（breweries）との紐付けは、DATA_STRUCTURE.md 6-6の通り現状「緩やか」で
// 実質未使用のため、本モデルでも自動での酒蔵新規作成は行わない：
//   - breweryId を渡された場合はそのまま外部キーとして使う
//   - breweryName（自由記述）だけ渡された場合、既存の酒蔵名と正規化一致すれば
//     その brewery_id を使う。一致しなければ brewery_id は NULL のまま、
//     元の文字列を brewery_name_raw に保存する（8-2参照）。

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { normalizeName } = require('../utils/normalizeName');

function list() {
  const db = getConnection();
  return db.prepare('SELECT * FROM raw_sake_brands ORDER BY name').all();
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM raw_sake_brands WHERE id = ?').get(id);
}

function findByUid(uid) {
  const db = getConnection();
  return db.prepare('SELECT * FROM raw_sake_brands WHERE uid = ?').get(uid);
}

/**
 * breweryId が優先。なければ breweryName を既存の酒蔵名と正規化突合し、
 * 一致すればそのidを、しなければ null を返す（brewery_name_rawは呼び出し元で保存）。
 */
function resolveBreweryId(db, { breweryId, breweryName }) {
  if (breweryId) return breweryId;
  if (!breweryName) return null;

  const target = normalizeName(breweryName);
  const breweries = db.prepare('SELECT id, name FROM breweries').all();
  const matched = breweries.find((b) => normalizeName(b.name) === target);
  return matched ? matched.id : null;
}

function create({
  name,
  abv,
  sakeMeterValue,
  breweryId,
  breweryName,
  status,
  producedOn,
  note,
  registeredOn,
  initialStock,
}) {
  const db = getConnection();
  const uid = generateUid(db, 'raw_sake_brands');
  const resolvedBreweryId = resolveBreweryId(db, { breweryId, breweryName });
  const breweryNameRaw = resolvedBreweryId ? null : (breweryName ?? null);

  const result = db
    .prepare(
      `INSERT INTO raw_sake_brands
         (uid, name, abv, sake_meter_value, brewery_id, brewery_name_raw,
          status, produced_on, note, registered_on, initial_stock, current_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uid,
      name,
      abv ?? null,
      sakeMeterValue ?? null,
      resolvedBreweryId,
      breweryNameRaw,
      status ?? null,
      producedOn ?? null,
      note ?? null,
      registeredOn ?? null,
      initialStock ?? 0,
      initialStock ?? 0
    );
  return findById(result.lastInsertRowid);
}

function update(id, fields) {
  const db = getConnection();
  const current = findById(id);
  if (!current) return null;

  const resolvedBreweryId =
    fields.breweryId !== undefined || fields.breweryName !== undefined
      ? resolveBreweryId(db, fields)
      : current.brewery_id;
  const breweryNameRaw = resolvedBreweryId
    ? null
    : (fields.breweryName ?? current.brewery_name_raw);

  db.prepare(
    `UPDATE raw_sake_brands
     SET name = COALESCE(?, name),
         abv = COALESCE(?, abv),
         sake_meter_value = COALESCE(?, sake_meter_value),
         brewery_id = ?,
         brewery_name_raw = ?,
         status = COALESCE(?, status),
         produced_on = COALESCE(?, produced_on),
         note = COALESCE(?, note),
         registered_on = COALESCE(?, registered_on)
     WHERE id = ?`
  ).run(
    fields.name ?? null,
    fields.abv ?? null,
    fields.sakeMeterValue ?? null,
    resolvedBreweryId,
    breweryNameRaw,
    fields.status ?? null,
    fields.producedOn ?? null,
    fields.note ?? null,
    fields.registeredOn ?? null,
    id
  );
  return findById(id);
}

function remove(id) {
  const db = getConnection();
  const result = db.prepare('DELETE FROM raw_sake_brands WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = { list, findById, findByUid, create, update, remove };
