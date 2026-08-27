// 酒蔵マスタ（breweries）
//
// DATA_STRUCTURE.md 6-6の通り、現状は原酒入荷画面から自動参照されない
// 「実質未使用」のマスタ。8-2の方針により、旧シートからの一括移行は行わず、
// 移行後にこのAPIを使って必要な分だけ順次手動登録していく運用とする。

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');

function list() {
  const db = getConnection();
  return db.prepare('SELECT * FROM breweries ORDER BY name').all();
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM breweries WHERE id = ?').get(id);
}

function findByUid(uid) {
  const db = getConnection();
  return db.prepare('SELECT * FROM breweries WHERE uid = ?').get(uid);
}

function create({ name, address, phone, contact, startedOn }) {
  const db = getConnection();
  const uid = generateUid(db, 'breweries');
  const result = db
    .prepare(
      `INSERT INTO breweries (uid, name, address, phone, contact, started_on)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(uid, name, address ?? null, phone ?? null, contact ?? null, startedOn ?? null);
  return findById(result.lastInsertRowid);
}

function update(id, { name, address, phone, contact, startedOn }) {
  const db = getConnection();
  db.prepare(
    `UPDATE breweries
     SET name = COALESCE(?, name),
         address = COALESCE(?, address),
         phone = COALESCE(?, phone),
         contact = COALESCE(?, contact),
         started_on = COALESCE(?, started_on)
     WHERE id = ?`
  ).run(name ?? null, address ?? null, phone ?? null, contact ?? null, startedOn ?? null, id);
  return findById(id);
}

function remove(id) {
  const db = getConnection();
  const result = db.prepare('DELETE FROM breweries WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = { list, findById, findByUid, create, update, remove };
