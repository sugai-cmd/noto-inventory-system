// 排他制御（旧GASの lockTank_ / ロック管理シート 相当）。
//
// 蒸留は「開始 → 作業 → 完了報告」と時間をまたぐ処理なので、
// 別の人が同じ蒸留を同時に触ると記録が食い違う。それを防ぐための仕組み。
//
// DBのトランザクションは一瞬の同時書き込みしか守れないため、
// 「今この蒸留は誰かが編集中」という数分〜数時間単位の主張はこちらで持つ。
//
// 24時間経過したロックは自動で失効する（DATA_STRUCTURE.md 4-16 C列の運用を踏襲）。

const { getConnection } = require('../db/connection');
const { ConflictError, NotFoundError } = require('../utils/errors');

const LOCK_HOURS = 24;

function purgeExpired(db) {
  db.prepare(
    "DELETE FROM resource_locks WHERE locked_at <= datetime('now', ?)"
  ).run(`-${LOCK_HOURS} hours`);
}

/**
 * ロックを取得する。既に他の人が持っていれば409で断る。
 * 同じ人が取り直した場合は時刻を更新して延長する。
 */
function acquire({ distillationId, user }) {
  const db = getConnection();

  const run = db.transaction(() => {
    purgeExpired(db);

    const distillation = db
      .prepare('SELECT * FROM distillations WHERE id = ?')
      .get(distillationId);
    if (!distillation) throw new NotFoundError(`蒸留記録が見つかりません (id=${distillationId})`);

    const existing = db
      .prepare("SELECT * FROM resource_locks WHERE target_type = 'distillation' AND distillation_id = ?")
      .get(distillationId);

    if (existing && existing.locked_by !== user.username) {
      throw new ConflictError(
        `蒸留 ${distillation.distillation_code} は ${existing.locked_by} さんが編集中です（${existing.locked_at}）`
      );
    }

    if (existing) {
      db.prepare("UPDATE resource_locks SET locked_at = datetime('now') WHERE id = ?").run(existing.id);
      return { ...existing, renewed: true };
    }

    const result = db
      .prepare(
        `INSERT INTO resource_locks (target_type, distillation_id, locked_by)
         VALUES ('distillation', ?, ?)`
      )
      .run(distillationId, user.username);

    return db.prepare('SELECT * FROM resource_locks WHERE id = ?').get(result.lastInsertRowid);
  });

  return run();
}

/** ロックを解放する。自分が持っているものだけ外せる（管理者は誰のものでも外せる）。 */
function release({ distillationId, user }) {
  const db = getConnection();
  purgeExpired(db);

  const existing = db
    .prepare("SELECT * FROM resource_locks WHERE target_type = 'distillation' AND distillation_id = ?")
    .get(distillationId);
  if (!existing) return false;

  if (existing.locked_by !== user.username && user.role !== 'admin') {
    throw new ConflictError(`このロックは ${existing.locked_by} さんのものです`);
  }

  return db.prepare('DELETE FROM resource_locks WHERE id = ?').run(existing.id).changes > 0;
}

/**
 * 他の人がロックしているなら止める。編集系の処理の冒頭で呼ぶ。
 * ロックが無い場合は素通りさせる（ロックは任意の仕組みで、必須ではない）。
 */
function assertNotLockedByOthers({ distillationId, user }) {
  const db = getConnection();
  purgeExpired(db);

  const existing = db
    .prepare("SELECT * FROM resource_locks WHERE target_type = 'distillation' AND distillation_id = ?")
    .get(distillationId);

  if (existing && existing.locked_by !== user?.username) {
    throw new ConflictError(
      `この蒸留は ${existing.locked_by} さんが編集中です。解除されるまでお待ちください`
    );
  }
}

function list() {
  const db = getConnection();
  purgeExpired(db);
  return db
    .prepare(
      `SELECT l.*, d.distillation_code, d.status
       FROM resource_locks l
       LEFT JOIN distillations d ON d.id = l.distillation_id
       ORDER BY l.locked_at DESC`
    )
    .all();
}

module.exports = { acquire, release, assertNotLockedByOthers, list, LOCK_HOURS };
