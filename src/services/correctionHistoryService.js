// 修正履歴（旧 getCorrectionHistory / シート「修正履歴」）。
//
// シートは 日時／ユーザー／対象種別／対象ID／操作内容／理由 の6列で、
// 取消や差し替えのたびに1行積まれる。
// こちらは別テーブルを作らず、取消した行そのものに理由・実施者・日時を残している
// （15-6の方針。同じ事実が2箇所に増えると片方だけ直る事故が起きるため）。
// ここではその行を集めて、シートと同じ形の一覧として見せる。

const { getConnection } = require('../db/connection');

/**
 * 並べ替えに使ってよい列。UNIONの外側の名前で指定する。
 *
 * 画面から来た文字列をそのままSQLに入れない。
 * **寄せ集めなので、元の表にしかない列では並べ替えられない**
 * （数量や金額は枝ごとに意味が違うため、そもそも列になっていない）。
 */
const SORTABLE = {
  occurred_at: 'occurred_at',
  target_type: 'target_type',
  target_code: 'target_code',
  user_name: 'user_name',
};
const DEFAULT_SORT = 'occurred_at';

/**
 * 修正履歴。
 *
 * @param {object} opts
 * @param {string} [opts.targetCode] - 蒸留IDや商品履歴IDでの絞り込み
 * @param {string} [opts.targetType] - 「商品在庫変動履歴」など
 * @param {string} [opts.userName]   - 実施者（部分一致）
 * @param {string} [opts.from]       - 日付の範囲
 * @param {string} [opts.to]
 * @returns {{rows: object[], total: number}} total は同じ絞り込みでの全件数
 */
function list({
  targetCode,
  targetType,
  userName,
  from,
  to,
  limit = 200,
  offset = 0,
  sort = DEFAULT_SORT,
  order = 'desc',
} = {}) {
  const db = getConnection();

  const union = `SELECT * FROM (
         -- 商品在庫変動履歴の取消（瓶詰め・箱詰め・出荷・返品）
         SELECT l.cancelled_at        AS occurred_at,
                u.display_name        AS user_name,
                '商品在庫変動履歴'     AS target_type,
                l.history_code        AS target_code,
                l.txn_type || ' ' || l.quantity || ' を取消' AS action,
                l.cancel_reason       AS reason,
                p.name                AS detail
         FROM product_stock_ledger l
         LEFT JOIN users u    ON u.id = l.cancelled_by
         LEFT JOIN products p ON p.id = l.product_id
         WHERE l.is_cancelled = 1 AND l.cancelled_at IS NOT NULL

         UNION ALL

         -- 資材在庫変動履歴の取消（商品側の取消に連動したぶんを含む）
         SELECT l.cancelled_at, u.display_name, '資材在庫変動履歴', l.history_code,
                l.txn_type || ' ' || l.quantity || ' を取消', l.cancel_reason, m.name
         FROM material_stock_ledger l
         LEFT JOIN users u     ON u.id = l.cancelled_by
         LEFT JOIN materials m ON m.id = l.material_id
         WHERE l.is_cancelled = 1 AND l.cancelled_at IS NOT NULL

         UNION ALL

         -- 原料受払記録の取消（原酒入荷・棚卸）
         SELECT l.cancelled_at, u.display_name, '原料受払記録', l.lot_code,
                l.txn_type || ' ' || l.quantity || 'L を取消', l.cancel_reason,
                COALESCE(tt.name, ft.name)
         FROM raw_sake_ledger l
         LEFT JOIN users u  ON u.id = l.cancelled_by
         LEFT JOIN tanks tt ON tt.id = l.to_tank_id
         LEFT JOIN tanks ft ON ft.id = l.from_tank_id
         WHERE l.is_cancelled = 1 AND l.cancelled_at IS NOT NULL

         UNION ALL

         -- 浄酎容器変動履歴の取消
         SELECT l.cancelled_at, u.display_name, '浄酎容器変動履歴',
                COALESCE(ft.name, tt.name),
                l.txn_type || ' ' || l.quantity_l || 'L を取消', l.cancel_reason,
                COALESCE(ft.name || '→', '') || COALESCE(tt.name, '')
         FROM tank_ledger l
         LEFT JOIN users u  ON u.id = l.cancelled_by
         LEFT JOIN tanks ft ON ft.id = l.from_tank_id
         LEFT JOIN tanks tt ON tt.id = l.to_tank_id
         WHERE l.is_cancelled = 1 AND l.cancelled_at IS NOT NULL

         UNION ALL

         -- 蒸留明細の部分取消（理由は備考に残している）
         SELECT NULL, NULL, '蒸留明細', d.distillation_code,
                '投入明細（' || t.name || ' ' || dd.input_l || 'L）を取消',
                dd.note, d.distillation_code
         FROM distillation_details dd
         JOIN distillations d ON d.id = dd.distillation_id
         LEFT JOIN tanks t    ON t.id = dd.source_tank_id
         WHERE dd.is_cancelled = 1
       )`;

  const where = ['(@targetCode IS NULL OR target_code = @targetCode)'];
  const params = {
    targetCode: targetCode ?? null,
    targetType: targetType ?? null,
    userName: userName ? `%${userName}%` : null,
    from: from ?? null,
    to: to ?? null,
  };

  if (targetType) where.push('target_type = @targetType');
  if (userName) where.push('user_name LIKE @userName');
  // **日付を絞ると、蒸留明細の枝は落ちる。** あの枝は取消の日時を持っておらず
  // （理由を備考に残すだけの作り）、occurred_at が NULL になる。
  // 画面にもその旨を出しておく
  if (from) where.push("date(occurred_at) >= @from");
  if (to) where.push("date(occurred_at) <= @to");

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const column = SORTABLE[sort] ?? SORTABLE[DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 日時を持たない行（蒸留明細）は常に最後へ。並べ替えても迷子にしない
  const nulls = column === 'occurred_at' ? ' NULLS LAST' : '';
  const orderSql = `${column} ${direction}${nulls}, target_code ${direction}`;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM (${union} ${whereSql})`)
    .get(params);

  const rows = db
    .prepare(`${union} ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  return { rows, total };
}

/** 絞り込みのプルダウンに出す値（実データにあるものだけ） */
function listFilterOptions() {
  const { rows } = list({ limit: 100000 });
  return {
    targetTypes: [...new Set(rows.map((r) => r.target_type))].sort(),
    users: [...new Set(rows.map((r) => r.user_name).filter(Boolean))].sort(),
  };
}

module.exports = { list, listFilterOptions };
