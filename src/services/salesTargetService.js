// 売上目標（旧GASの setSalesTarget 相当）と、ダッシュボードの当月進捗率。

const { getConnection } = require('../db/connection');
const { BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

/** 目標を設定する。同じ月に再設定したら上書きする。 */
function setSalesTarget({ targetMonth, targetAmount, note }, actor = null) {
  const db = getConnection();

  if (!/^\d{4}-\d{2}$/.test(targetMonth ?? '')) {
    throw new BusinessRuleError('対象月はYYYY-MM形式で指定してください');
  }

  db.prepare(
    `INSERT INTO sales_targets (target_month, target_amount, note)
     VALUES (@targetMonth, @targetAmount, @note)
     ON CONFLICT(target_month) DO UPDATE SET
       target_amount = excluded.target_amount,
       note = excluded.note`
  ).run({ targetMonth, targetAmount, note: note ?? null });

  operationLogService.record({
    user: actor,
    action: 'sales_target.set',
    targetType: 'sales_targets',
    summary: `${targetMonth} の売上目標を ${targetAmount.toLocaleString('ja-JP')}円 に設定`,
  });

  return db.prepare('SELECT * FROM sales_targets WHERE target_month = ?').get(targetMonth);
}

function list({ limit = 24 } = {}) {
  const db = getConnection();
  return db
    .prepare('SELECT * FROM sales_targets ORDER BY target_month DESC LIMIT ?')
    .all(limit);
}

/**
 * 指定月の売上実績と目標の対比（ダッシュボードの「当月進捗率」）。
 *
 * 実績は納品日ベースで集計する（売上として立つのは出荷したとき、という考え方）。
 * 納品日が未設定の受注は、まだ売上になっていないので含めない。
 * 委託販売は受注時点では売上にせず、実績報告された分だけを計上する。
 */
function getMonthlyProgress(targetMonth) {
  const db = getConnection();

  if (!/^\d{4}-\d{2}$/.test(targetMonth ?? '')) {
    throw new BusinessRuleError('対象月はYYYY-MM形式で指定してください');
  }

  const target = db
    .prepare('SELECT * FROM sales_targets WHERE target_month = ?')
    .get(targetMonth);

  // 買取分：納品済みの受注
  const purchase = db
    .prepare(
      `SELECT COALESCE(SUM(sales_amount), 0) AS amount, COUNT(*) AS count
       FROM orders
       WHERE delivered_on IS NOT NULL
         AND substr(delivered_on, 1, 7) = ?
         AND (sales_method IS NULL OR sales_method <> '委託')`
    )
    .get(targetMonth);

  // 委託分：その月に報告された実績
  const consignment = db
    .prepare(
      `SELECT COALESCE(SUM(sales_amount), 0) AS amount, COUNT(*) AS count
       FROM consignment_reports
       WHERE report_month = ?`
    )
    .get(targetMonth);

  const actualAmount = purchase.amount + consignment.amount;
  const targetAmount = target?.target_amount ?? null;

  return {
    targetMonth,
    targetAmount,
    actualAmount,
    breakdown: {
      purchase: { amount: purchase.amount, count: purchase.count },
      consignment: { amount: consignment.amount, count: consignment.count },
    },
    // 目標未設定なら進捗率は出さない（0%と誤解されないようnullにする）
    progressRate: targetAmount ? Math.round((actualAmount / targetAmount) * 1000) / 10 : null,
    remainingAmount: targetAmount ? Math.max(targetAmount - actualAmount, 0) : null,
  };
}

module.exports = { setSalesTarget, list, getMonthlyProgress };
