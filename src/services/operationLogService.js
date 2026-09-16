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

/**
 * 並べ替えに使ってよい列。画面から来た文字列をそのままSQLに入れない。
 */
const SORTABLE = {
  occurred_at: 'l.occurred_at',
  display_name: 'u.display_name',
  action: 'l.action',
  target_type: 'l.target_type',
};
const DEFAULT_SORT = 'occurred_at';

/**
 * 操作ログ。
 *
 * **画面は `?limit=100` を決め打ちで送っており、古いログは一切見られなかった。**
 * ログは消さずに増え続けるので、いちばん遡れないと困る一覧がここだった。
 * total を返してページ送りできるようにする。
 *
 * @returns {{rows: object[], total: number}} total は同じ絞り込みでの全件数
 */
function list({
  from,
  to,
  userId,
  action,
  targetType,
  limit = 200,
  offset = 0,
  sort = DEFAULT_SORT,
  order = 'desc',
} = {}) {
  const db = getConnection();
  const where = [];
  const params = {};

  if (from) { where.push("date(l.occurred_at) >= @from"); params.from = from; }
  if (to) { where.push("date(l.occurred_at) <= @to"); params.to = to; }
  if (userId) { where.push('l.user_id = @userId'); params.userId = userId; }
  // 前方一致。`rawSake` で rawSake.* をまとめて絞れる
  if (action) { where.push('l.action LIKE @action'); params.action = `${action}%`; }
  if (targetType) { where.push('l.target_type = @targetType'); params.targetType = targetType; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const column = SORTABLE[sort] ?? SORTABLE[DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 同じ時刻の行が実行のたびに入れ替わらないよう、idを第2キーにする
  const orderSql = `${column} ${direction}, l.id ${direction}`;

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM operation_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${whereSql}`
    )
    .get(params);

  const rows = db
    .prepare(
      `SELECT l.*, u.display_name
       FROM operation_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return { rows, total };
}

/**
 * 絞り込みのプルダウンに出す値。**実データにあるものだけ**を返す。
 *
 * 固定リストにすると、新しい操作を足したときに絞り込めない行が生まれる
 * （操作の種類は機能を足すたびに増える）。
 */
function listFilterOptions() {
  const db = getConnection();
  return {
    actions: db
      .prepare('SELECT DISTINCT action FROM operation_logs WHERE action IS NOT NULL ORDER BY action')
      .all()
      .map((r) => r.action),
    targetTypes: db
      .prepare(
        'SELECT DISTINCT target_type FROM operation_logs WHERE target_type IS NOT NULL ORDER BY target_type'
      )
      .all()
      .map((r) => r.target_type),
    users: db
      .prepare(
        `SELECT DISTINCT u.id, u.display_name
           FROM operation_logs l JOIN users u ON u.id = l.user_id
          ORDER BY u.display_name`
      )
      .all(),
  };
}

module.exports = { record, list, listFilterOptions };
