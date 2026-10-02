// 入金の消し込み。
//
// 通帳に入金があったら、それを1件の記録として足し、請求（受注番号・委託の報告）に
// 割り当てる。1回の振込で複数の請求がまとめて払われる（まとめ入金）、一部だけ入る、
// 振込手数料が引かれて端数が残る、のどれも扱えるようにするため、
// 「入金」と「割り当て」を分けている（引き当ての作法。0027のコメント参照）。
//
// ## orders.paid_on は残す
//
// ダッシュボード・売上目標・CSV・受注一覧は、どれも paid_on を見ている。
// そこを作り直すと波及が大きいので、**paid_on を割り当ての結果として自動で入れる**。
// 全額ついたら最後の入金日が入り、割り当てを外すと消える。
// 2か所から書かないよう、受注の編集パネルの入金日は割り当てがある受注では塞いである。

const { getConnection } = require('../db/connection');
const { nextPaymentNo } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../utils/errors');
const operationLogService = require('./operationLogService');
const customerService = require('./customerService');
const invoiceAmount = require('./invoiceAmount');

/** 円の丸め。REALの足し算で出る小数のごみを落とす */
const yen = (v) => Math.round(v * 100) / 100;

/**
 * 並べ替えに使ってよい列。
 * 画面から来た文字列をそのままSQLに入れない（既存の一覧と同じ作法）。
 */
const SORTABLE = {
  paid_on: 'p.paid_on',
  payment_no: 'p.payment_no',
  customer_name: 'c.name',
  amount: 'p.amount',
  is_cancelled: 'p.is_cancelled',
};
const DEFAULT_SORT = 'paid_on';

// ---------------------------------------------------------------------------
// 請求と割り当ての突き合わせ
// ---------------------------------------------------------------------------

/** その請求に割り当てられている額（取消済みの入金は数えない） */
function allocatedTo(db, { orderNo = null, reportId = null }) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
        WHERE p.is_cancelled = 0
          AND CASE WHEN @orderNo IS NOT NULL
                   THEN a.order_no = @orderNo
                   ELSE a.consignment_report_id = @reportId END`
    )
    .get({ orderNo, reportId });
  return yen(row.total);
}

/** その入金のうち使った額（端数は入金の金額を使わないので数えない） */
function usedOf(db, paymentId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM payment_allocations WHERE payment_id = ? AND kind = '入金'`
    )
    .get(paymentId);
  return yen(row.total);
}

/**
 * 請求を1件引く。受注番号なら受注、そうでなければ委託の報告。
 * 残額つきで返す。
 */
function invoiceWithBalance(db, { orderNo = null, reportId = null }) {
  const invoice = orderNo
    ? invoiceAmount.orderInvoice(db, orderNo)
    : invoiceAmount.consignmentInvoice(db, reportId);
  if (!invoice) return null;

  const allocated = allocatedTo(db, { orderNo, reportId });
  return { ...invoice, allocated, remaining: yen(invoice.total - allocated) };
}

/**
 * 入金日を請求に書き戻す。
 *
 * 残額が0以下になったら paid_on を入れ、戻ったら消す。
 * **入れる日付は、その請求に充てた入金のうち一番新しい入金日**（最後に埋まった日）。
 */
function refreshPaidOn(db, { orderNo = null, reportId = null }) {
  const invoice = invoiceWithBalance(db, { orderNo, reportId });
  if (!invoice) return;

  const latest = db
    .prepare(
      `SELECT MAX(p.paid_on) AS paid_on
         FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
        WHERE p.is_cancelled = 0
          AND CASE WHEN @orderNo IS NOT NULL
                   THEN a.order_no = @orderNo
                   ELSE a.consignment_report_id = @reportId END`
    )
    .get({ orderNo, reportId }).paid_on;

  const paidOn = invoice.remaining <= 0 ? latest : null;

  if (orderNo) {
    // 受注番号ぶんの明細すべてに入れる（請求は受注番号単位なので、行だけ入るのは変）
    db.prepare(
      `UPDATE orders SET paid_on = @paidOn, updated_at = datetime('now')
        WHERE order_no = @orderNo AND is_cancelled = 0`
    ).run({ orderNo, paidOn });
  } else {
    db.prepare('UPDATE consignment_reports SET paid_on = @paidOn WHERE id = @reportId')
      .run({ reportId, paidOn });
  }
}

/** その入金が触っている請求を全部引き直す */
function refreshTouched(db, paymentId) {
  const targets = db
    .prepare(
      `SELECT DISTINCT order_no, consignment_report_id
         FROM payment_allocations WHERE payment_id = ?`
    )
    .all(paymentId);
  for (const t of targets) {
    refreshPaidOn(db, { orderNo: t.order_no, reportId: t.consignment_report_id });
  }
}

// ---------------------------------------------------------------------------
// 入金
// ---------------------------------------------------------------------------

function recordPayment(input, actor = null) {
  const db = getConnection();

  if (!(input.amount > 0)) throw new BusinessRuleError('入金額は0より大きい金額で入力してください');

  const run = db.transaction(() => {
    const paidOn = input.paidOn ?? today();
    if (input.customerId) {
      const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(input.customerId);
      if (!customer) throw new NotFoundError(`得意先が見つかりません (id=${input.customerId})`);
    }

    const result = db
      .prepare(
        `INSERT INTO payments (payment_no, paid_on, customer_id, amount, payer_name, note, created_by)
         VALUES (@paymentNo, @paidOn, @customerId, @amount, @payerName, @note, @createdBy)`
      )
      .run({
        paymentNo: nextPaymentNo(db, paidOn),
        paidOn,
        customerId: input.customerId ?? null,
        amount: input.amount,
        payerName: input.payerName ?? null,
        note: input.note ?? null,
        createdBy: actor?.id ?? null,
      });

    const payment = findById(result.lastInsertRowid);
    operationLogService.record({
      user: actor,
      action: 'payment.create',
      targetType: 'payments',
      targetId: payment.id,
      summary:
        `入金 ${payment.payment_no} を記録（${paidOn} ${payment.amount.toLocaleString('ja-JP')}円` +
        `${payment.customer_name ? ` / ${payment.customer_name}` : ''}` +
        `${input.payerName ? ` / 名義 ${input.payerName}` : ''}）`,
    });
    return payment;
  });

  return run();
}

function findById(id) {
  const db = getConnection();
  const payment = db
    .prepare(
      `SELECT p.*, c.name AS customer_name
         FROM payments p
         LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.id = ?`
    )
    .get(id);
  if (!payment) return null;

  const allocations = db
    .prepare(
      `SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY id`
    )
    .all(id)
    .map((a) => {
      const invoice = a.order_no
        ? invoiceAmount.orderInvoice(db, a.order_no)
        : invoiceAmount.consignmentInvoice(db, a.consignment_report_id);
      return {
        ...a,
        label: a.order_no ? a.order_no : (invoice?.reportNo ?? `委託id=${a.consignment_report_id}`),
        customerName: invoice?.customerName ?? null,
        productSummary: invoice?.productSummary ?? null,
        invoiceTotal: invoice?.total ?? null,
      };
    });

  const used = usedOf(db, id);
  return { ...payment, allocations, used, unallocated: yen(payment.amount - used) };
}

/** 入金の一覧（絞り込み・並べ替え・ページ送り。既存の一覧と同じ形） */
function listPayments({
  limit = 100,
  offset = 0,
  sort = DEFAULT_SORT,
  order = 'desc',
  customerId = null,
  from = null,
  to = null,
  includeCancelled = false,
  unallocatedOnly = false,
} = {}) {
  const db = getConnection();

  const where = [];
  const params = {};
  if (!includeCancelled) where.push('p.is_cancelled = 0');
  if (customerId) { where.push('p.customer_id = @customerId'); params.customerId = customerId; }
  if (from) { where.push('p.paid_on >= @from'); params.from = from; }
  if (to) { where.push('p.paid_on <= @to'); params.to = to; }
  if (unallocatedOnly) {
    // まだ全額を割り当てきれていない入金（消し込みの続きをやる対象）
    where.push(`p.amount > (
      SELECT COALESCE(SUM(a.amount), 0) FROM payment_allocations a
       WHERE a.payment_id = p.id AND a.kind = '入金')`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const column = SORTABLE[sort] ?? SORTABLE[DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 同じ値のときの並びが実行のたびに変わらないよう、idを第2キーにする
  const orderSql = `${column} ${direction}, p.id ${direction}`;

  const joins = `FROM payments p LEFT JOIN customers c ON c.id = p.customer_id`;
  const { total } = db.prepare(`SELECT COUNT(*) AS total ${joins} ${whereSql}`).get(params);

  const rows = db
    .prepare(
      `SELECT p.*, c.name AS customer_name,
              (SELECT COALESCE(SUM(a.amount), 0) FROM payment_allocations a
                WHERE a.payment_id = p.id AND a.kind = '入金') AS used
         ${joins} ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset })
    .map((r) => ({ ...r, unallocated: yen(r.amount - r.used) }));

  return { rows, total };
}

// ---------------------------------------------------------------------------
// 消し込みの候補
// ---------------------------------------------------------------------------

/**
 * まだ残額が残っている請求を返す（消し込みの候補）。
 *
 * **得意先を指定したら、同じ本店につながる支店ぶんも出す**（まとめ入金のため）。
 * 本店の口座に振り込まれても請求は支店ごとに立っているので、
 * 自分の行だけに絞ると1件も消し込めない。
 *
 * @param {object} opts
 * @param {number} [opts.customerId] - 省略すると全得意先
 * @param {boolean} [opts.includeUnbilled] - 請求日が入っていないものも出す
 */
function listOpenInvoices({ customerId = null, includeUnbilled = false, limit = 200 } = {}) {
  const db = getConnection();

  const ids = customerId ? customerService.familyIds(db, customerId) : null;
  const inFamily = (id) => !ids || ids.includes(id);

  // 受注（受注番号ごと）。取消済みは候補にしない
  const orderNos = db
    .prepare(
      `SELECT o.order_no, MIN(o.customer_id) AS customer_id
         FROM orders o
        WHERE o.is_cancelled = 0
          AND (@includeUnbilled = 1 OR o.invoiced_on IS NOT NULL)
        GROUP BY o.order_no`
    )
    .all({ includeUnbilled: includeUnbilled ? 1 : 0 })
    .filter((r) => inFamily(r.customer_id))
    .map((r) => r.order_no);

  const reportIds = db
    .prepare(
      `SELECT id, customer_id FROM consignment_reports
        WHERE (@includeUnbilled = 1 OR invoiced_on IS NOT NULL)`
    )
    .all({ includeUnbilled: includeUnbilled ? 1 : 0 })
    .filter((r) => inFamily(r.customer_id))
    .map((r) => r.id);

  const invoices = [
    ...orderNos.map((orderNo) => invoiceWithBalance(db, { orderNo })),
    ...reportIds.map((reportId) => invoiceWithBalance(db, { reportId })),
  ]
    .filter((inv) => inv && inv.remaining > 0)
    // 入金予定日の早い順。予定日が無いものは後ろ
    .sort((a, b) =>
      (a.paymentDueOn ?? '9999-12-31').localeCompare(b.paymentDueOn ?? '9999-12-31')
      || String(a.orderNo ?? a.reportNo ?? '').localeCompare(String(b.orderNo ?? b.reportNo ?? ''))
    );

  return { rows: invoices.slice(0, limit), total: invoices.length };
}

// ---------------------------------------------------------------------------
// 割り当て
// ---------------------------------------------------------------------------

/** 1件の割り当ての宛先を確かめ、正規化して返す */
function resolveTarget(db, item) {
  if (item.orderNo) {
    const invoice = invoiceAmount.orderInvoice(db, String(item.orderNo));
    if (!invoice) {
      // 取消済みの受注は orderInvoice が null を返す（is_cancelled = 0 で絞っている）
      throw new NotFoundError(
        `受注番号 ${item.orderNo} が見つかりません（取り消された受注にも割り当てられません）`
      );
    }
    return { orderNo: invoice.orderNo, reportId: null, invoice };
  }
  if (item.consignmentReportId) {
    const invoice = invoiceAmount.consignmentInvoice(db, item.consignmentReportId);
    if (!invoice) {
      throw new NotFoundError(`委託販売実績報告が見つかりません (id=${item.consignmentReportId})`);
    }
    return { orderNo: null, reportId: invoice.reportId, invoice };
  }
  throw new BusinessRuleError('割り当て先（受注番号または委託の報告）を指定してください');
}

/**
 * 割り当てを差し替える（丸ごと入れ直す）。
 *
 * 1件ずつ足し引きさせると、画面とサーバーで持っている割当がずれる。
 * 製品レシピの差し替え（updateProductRecipe）と同じく、いまの内容を全部受け取る。
 *
 * @param {Array<{orderNo?, consignmentReportId?, amount, kind?, note?}>} items
 */
function allocate(paymentId, items = [], actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw new NotFoundError(`入金が見つかりません (id=${paymentId})`);
    if (payment.is_cancelled) {
      throw new ConflictError(`入金 ${payment.payment_no} は取消済みです`);
    }

    // 入れ直す前に、いま触っている請求を覚えておく（外した請求の paid_on も戻すため）
    const before = db
      .prepare('SELECT DISTINCT order_no, consignment_report_id FROM payment_allocations WHERE payment_id = ?')
      .all(paymentId);

    db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(paymentId);

    const insert = db.prepare(
      `INSERT INTO payment_allocations
         (payment_id, order_no, consignment_report_id, amount, kind, note)
       VALUES (@paymentId, @orderNo, @reportId, @amount, @kind, @note)`
    );

    const touched = [...before];
    let usedTotal = 0;

    for (const item of items) {
      const amount = Number(item.amount);
      if (!(amount > 0)) {
        throw new BusinessRuleError('割り当ての金額は0より大きい金額で入力してください');
      }
      const kind = item.kind === '端数' ? '端数' : '入金';
      if (kind === '端数' && !String(item.note ?? '').trim()) {
        // 何の端数かが残らないと、あとから見て差額の説明がつかない
        throw new BusinessRuleError('端数として締めるときは理由を入れてください');
      }

      const { orderNo, reportId } = resolveTarget(db, item);
      insert.run({
        paymentId, orderNo, reportId, amount, kind, note: item.note ?? null,
      });
      touched.push({ order_no: orderNo, consignment_report_id: reportId });
      if (kind === '入金') usedTotal = yen(usedTotal + amount);
    }

    // 入金額を超えて割り当てられない（端数は入金の金額を使わないので数えない）
    if (usedTotal > payment.amount) {
      throw new BusinessRuleError(
        `割り当ての合計 ${usedTotal.toLocaleString('ja-JP')}円 が入金額 ` +
          `${payment.amount.toLocaleString('ja-JP')}円 を超えています`
      );
    }

    // 請求額を超えて割り当てられない。**他の入金からの分も合わせて**見る
    const seen = new Map();
    for (const t of touched) {
      const key = t.order_no ? `o:${t.order_no}` : `c:${t.consignment_report_id}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      const invoice = invoiceWithBalance(db, {
        orderNo: t.order_no, reportId: t.consignment_report_id,
      });
      if (!invoice) continue;
      if (invoice.remaining < 0) {
        const label = t.order_no ?? invoice.reportNo ?? `委託id=${t.consignment_report_id}`;
        throw new BusinessRuleError(
          `${label} への割り当てが請求額を超えています` +
            `（請求 ${invoice.total.toLocaleString('ja-JP')}円 / ` +
            `割当 ${invoice.allocated.toLocaleString('ja-JP')}円）`
        );
      }
    }

    // 入金日を書き戻す。外した請求も含めて引き直す
    for (const key of seen.keys()) {
      const [type, value] = [key.slice(0, 1), key.slice(2)];
      refreshPaidOn(db, {
        orderNo: type === 'o' ? value : null,
        reportId: type === 'c' ? Number(value) : null,
      });
    }

    const after = findById(paymentId);
    operationLogService.record({
      user: actor,
      action: 'payment.allocate',
      targetType: 'payments',
      targetId: paymentId,
      summary:
        `入金 ${payment.payment_no} の消し込みを更新（${after.allocations.length}件・` +
        `充当 ${after.used.toLocaleString('ja-JP')}円 / 未割当 ${after.unallocated.toLocaleString('ja-JP')}円）`,
      detail: {
        allocations: after.allocations.map((a) => ({ label: a.label, amount: a.amount, kind: a.kind })),
      },
    });
    return after;
  });

  return run();
}

/**
 * 残額を「端数」として締める（振込手数料・値引きなど）。
 *
 * いまの割り当てに1件足すだけ。入金の金額は使わないので、
 * 同じ入金をまだ他の請求に充てられる。
 */
function settleRemainder(paymentId, { orderNo, consignmentReportId, note } = {}, actor = null) {
  const db = getConnection();
  const existing = db
    .prepare('SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY id')
    .all(paymentId);

  const invoice = invoiceWithBalance(db, {
    orderNo: orderNo ?? null,
    reportId: consignmentReportId ?? null,
  });
  if (!invoice) throw new NotFoundError('締める請求が見つかりません');
  if (invoice.remaining <= 0) {
    throw new ConflictError('この請求には残額がありません');
  }

  const items = existing.map((a) => ({
    orderNo: a.order_no ?? undefined,
    consignmentReportId: a.consignment_report_id ?? undefined,
    amount: a.amount,
    kind: a.kind,
    note: a.note ?? undefined,
  }));
  items.push({
    orderNo: orderNo ?? undefined,
    consignmentReportId: consignmentReportId ?? undefined,
    amount: invoice.remaining,
    kind: '端数',
    note,
  });

  return allocate(paymentId, items, actor);
}

/** 入金の取消（打ち間違い）。割り当ても効かなくなり、入金日が戻る */
function cancelPayment(paymentId, { reason } = {}, actor = null) {
  const db = getConnection();
  if (!reason || !String(reason).trim()) {
    throw new BusinessRuleError('取消理由は必須です');
  }

  const run = db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw new NotFoundError(`入金が見つかりません (id=${paymentId})`);
    if (payment.is_cancelled) {
      throw new ConflictError(`入金 ${payment.payment_no} は既に取消済みです`);
    }

    db.prepare(
      `UPDATE payments
          SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
              cancelled_by = @by, updated_at = datetime('now')
        WHERE id = @id`
    ).run({ id: paymentId, reason: String(reason).trim(), by: actor?.id ?? null });

    // 割り当ての行は履歴として残す。allocatedTo が取消済みの入金を数えないので、
    // 残額は自動で戻る（数値を書き戻さないので二重に戻す事故が起きない）
    refreshTouched(db, paymentId);

    operationLogService.record({
      user: actor,
      action: 'payment.cancel',
      targetType: 'payments',
      targetId: paymentId,
      summary:
        `入金 ${payment.payment_no}（${payment.paid_on} ${payment.amount.toLocaleString('ja-JP')}円）を取消` +
        `／理由: ${String(reason).trim()}`,
    });

    return findById(paymentId);
  });

  return run();
}

module.exports = {
  recordPayment,
  findById,
  listPayments,
  listOpenInvoices,
  allocate,
  settleRemainder,
  cancelPayment,
  invoiceWithBalance,
  refreshPaidOn,
  SORTABLE,
};
