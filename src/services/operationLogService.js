// 操作ログ。誰がいつ何をしたかを時系列で残す。
//
// 台帳そのものは各テーブルに残るので、ここは「操作の記録」に徹する。
// 記録に失敗しても業務処理は止めない（ログのために受注登録が失敗しては本末転倒なため）。

const { getConnection } = require('../db/connection');

/**
 * @param {object} opts
 * @param {object|null} opts.user - req.user（未ログインの処理ならnull）
 * @param {string} opts.action - 'order.create' のような識別子
 * @param {string} [opts.targetType] - 対象テーブル名
 * @param {number} [opts.targetId]
 * @param {string} [opts.summary] - 一覧に出す一行説明
 * @param {object} [opts.detail] - 補足情報
 */
function record({ user, action, targetType, targetId, summary, detail }) {
  try {
    const db = getConnection();
    db.prepare(
      `INSERT INTO operation_logs
         (user_id, username, action, target_type, target_id, summary, detail_json)
       VALUES (@userId, @username, @action, @targetType, @targetId, @summary, @detailJson)`
    ).run({
      userId: user?.id ?? null,
      username: user?.username ?? null,
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      summary: summary ?? null,
      detailJson: detail ? JSON.stringify(detail) : null,
    });
  } catch (err) {
    // ログの失敗で業務処理を止めない
    console.error('[operation-log] 記録に失敗しました:', err.message);
  }
}

function list({ from, to, userId, action, targetType, limit = 200 } = {}) {
  const db = getConnection();
  const where = [];
  const params = { limit };

  if (from) { where.push("date(l.occurred_at) >= @from"); params.from = from; }
  if (to) { where.push("date(l.occurred_at) <= @to"); params.to = to; }
  if (userId) { where.push('l.user_id = @userId'); params.userId = userId; }
  if (action) { where.push('l.action LIKE @action'); params.action = `${action}%`; }
  if (targetType) { where.push('l.target_type = @targetType'); params.targetType = targetType; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT l.*, u.display_name
       FROM operation_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${whereSql}
       ORDER BY l.occurred_at DESC, l.id DESC
       LIMIT @limit`
    )
    .all(params);
}

module.exports = { record, list };
