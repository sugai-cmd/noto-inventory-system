// 修正履歴（旧 getCorrectionHistory / シート「修正履歴」）。
//
// シートは 日時／ユーザー／対象種別／対象ID／操作内容／理由 の6列で、
// 取消や差し替えのたびに1行積まれる。
// こちらは別テーブルを作らず、取消した行そのものに理由・実施者・日時を残している
// （15-6の方針。同じ事実が2箇所に増えると片方だけ直る事故が起きるため）。
// ここではその行を集めて、シートと同じ形の一覧として見せる。

const { getConnection } = require('../db/connection');

/**
 * @param {object} opts
 * @param {string} [opts.targetCode] - 蒸留IDや商品履歴IDでの絞り込み
 * @param {number} [opts.limit]
 */
function list({ targetCode, limit = 200 } = {}) {
  const db = getConnection();

  const rows = db
    .prepare(
      `SELECT * FROM (
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
       )
       WHERE (@targetCode IS NULL OR target_code = @targetCode)
       ORDER BY occurred_at DESC NULLS LAST, target_code DESC
       LIMIT @limit`
    )
    .all({ targetCode: targetCode ?? null, limit });

  return rows;
}

module.exports = { list };
