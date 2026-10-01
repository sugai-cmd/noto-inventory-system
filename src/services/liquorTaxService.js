// 酒税の月次算出（酒税申告用）と、出荷時の課税額の計算。
//
// 毎月月初に前月分の酒税を計算して申告する作業が、システムの外で行われていた。
// 旧シート21枚にも酒税のシートは無い。
//
// ## 税額の出し方
//
//   超過度数 = max(0, floor(度数 - 基準度数))      ← 1度未満の端数は切り捨て
//   円/kl   = 基準税額 + 超過度数 × 加算額
//   酒税額  = 容量(ml) × 数量 × 円/kl ÷ 1,000,000
//
// max(0, …) があるので**基準度数以下はどこでも基準税額のまま**になる
// （スピリッツなら 35度・36度・37度がいずれも 370,000円/kl。38度で 380,000円/kl）。
// この段の付き方は利用者と確認済み。
//
// **税率はコードに持たない。** 区分の判定（スピリッツか単式蒸留焼酎か）は会社が決めることで、
// 税率も改正される。推測で入れると**申告額を間違える**。liquor_tax_rates に登録してもらう。
//
// ## いままでの課税額は使えない
//
// products.tax_per_unit（「課税額」）は `課税額 × 本数` として使われていて、
// **容量を掛けていない**。0.37（円/ml）が入っていれば、300ml×12本で 4.44円。
// 正しくは 300 × 12 × 0.37 = 1,332円。桁が違う。
// これ以降 tax_per_unit は読まない（列は移行の履歴として残す）。
//
// ## 計算できないものを0円にしない
//
// 区分が未設定・区分に税率が無い・容量が空、のいずれかなら金額に混ぜず、
// **商品名を名指しで返す**。黙って0円にすると申告額が過少になる。

const { getConnection } = require('../db/connection');
const { BusinessRuleError, NotFoundError } = require('../utils/errors');
const { lastDayOfMonth } = require('../utils/dateUtil');
const operationLogService = require('./operationLogService');

const MONTH_RE = /^\d{4}-\d{2}$/;
const ML_PER_KL = 1_000_000;

/** 円の丸め。REALの掛け算で出る小数のごみを落とす */
function yen(value) {
  return Math.round(value * 100) / 100;
}

function assertMonth(month) {
  if (!MONTH_RE.test(month ?? '')) {
    throw new BusinessRuleError('対象月はYYYY-MM形式で指定してください');
  }
}

/** その月の末日（YYYY-MM-DD）。税率をどの時点で引くかに使う */
function endOfMonth(month) {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  return `${month}-${String(lastDayOfMonth(year, mon)).padStart(2, '0')}`;
}

/** 前月（YYYY-MM）。酒税の作業は月初に前月分を出すので、画面の既定に使う */
function previousMonth(month) {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const shifted = new Date(Date.UTC(year, mon - 2, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 税率マスタ
// ---------------------------------------------------------------------------

function listRates() {
  const db = getConnection();
  return db
    .prepare(
      `SELECT * FROM liquor_tax_rates
        ORDER BY category, COALESCE(effective_from, '') DESC`
    )
    .all();
}

/** 商品マスタの「酒類区分」の選択肢。登録済みの区分だけを出す */
function listCategories() {
  const db = getConnection();
  return db
    .prepare('SELECT DISTINCT category FROM liquor_tax_rates ORDER BY category')
    .all()
    .map((r) => r.category);
}

/**
 * 税率を登録・上書きする。
 * 同じ区分・同じ「いつから」は1件だけ（改正ごとに effective_from を変えて増やす）。
 */
function saveRate(input, actor = null) {
  const db = getConnection();

  const category = String(input.category ?? '').trim();
  if (!category) throw new BusinessRuleError('酒類区分を入力してください');

  const params = {
    category,
    baseAbv: input.baseAbv,
    baseYenPerKl: input.baseYenPerKl,
    stepYenPerKl: input.stepYenPerKl ?? 0,
    effectiveFrom: input.effectiveFrom || null,
    note: input.note || null,
  };

  db.prepare(
    `INSERT INTO liquor_tax_rates
       (category, base_abv, base_yen_per_kl, step_yen_per_kl, effective_from, note)
     VALUES (@category, @baseAbv, @baseYenPerKl, @stepYenPerKl, @effectiveFrom, @note)
     ON CONFLICT(category, COALESCE(effective_from, '')) DO UPDATE SET
       base_abv        = excluded.base_abv,
       base_yen_per_kl = excluded.base_yen_per_kl,
       step_yen_per_kl = excluded.step_yen_per_kl,
       note            = excluded.note,
       updated_at      = datetime('now')`
  ).run(params);

  const saved = db
    .prepare(
      `SELECT * FROM liquor_tax_rates
        WHERE category = @category AND COALESCE(effective_from, '') = COALESCE(@effectiveFrom, '')`
    )
    .get(params);

  operationLogService.record({
    user: actor,
    action: 'liquor_tax_rate.save',
    targetType: 'liquor_tax_rates',
    targetId: saved.id,
    summary:
      `酒税の税率を登録（${category}: ${params.baseAbv}度まで ${params.baseYenPerKl.toLocaleString('ja-JP')}円/kl、` +
      `1度ごと +${Number(params.stepYenPerKl).toLocaleString('ja-JP')}円/kl` +
      `${params.effectiveFrom ? `、${params.effectiveFrom}から` : ''}）`,
  });

  return saved;
}

function deleteRate(id, actor = null) {
  const db = getConnection();
  const row = db.prepare('SELECT * FROM liquor_tax_rates WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`酒税の税率が見つかりません (id=${id})`);

  db.prepare('DELETE FROM liquor_tax_rates WHERE id = ?').run(id);

  operationLogService.record({
    user: actor,
    action: 'liquor_tax_rate.delete',
    targetType: 'liquor_tax_rates',
    targetId: id,
    summary: `酒税の税率を削除（${row.category}${row.effective_from ? ` ${row.effective_from}から` : ''}）`,
  });

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// 税率の適用
// ---------------------------------------------------------------------------

/**
 * その区分の、その時点で有効な税率を返す。
 *
 * effective_from が対象日以前のもののうち一番新しいもの。
 * effective_from が空の行は「ずっと有効」として一番弱い候補にする
 * （改正で日付つきの行を足したら、そちらが勝つ）。
 */
function findRate(db, category, onDate) {
  if (!category) return null;
  return (
    db
      .prepare(
        `SELECT * FROM liquor_tax_rates
          WHERE category = @category
            AND (effective_from IS NULL OR effective_from <= @onDate)
          ORDER BY (effective_from IS NULL), effective_from DESC
          LIMIT 1`
      )
      .get({ category, onDate: onDate ?? '9999-12-31' }) ?? null
  );
}

/**
 * 度数から1klあたりの税額を出す。
 * 基準度数以下はどこでも基準税額のまま（max(0, …) がその段を作っている）。
 */
function yenPerKl(rate, abv) {
  if (!rate) return null;
  if (abv == null) return null;
  const over = Math.max(0, Math.floor(abv - rate.base_abv));
  return rate.base_yen_per_kl + over * rate.step_yen_per_kl;
}

/**
 * 1件ぶんの酒税額。
 *
 * 計算できない理由がある場合は金額を返さず reason を返す。
 * **呼び出し側でそれを見えるようにする責任がある**（黙って0円にしない）。
 *
 * @param {object} product - products の行（volume_ml, abv, tax_category, name）
 * @param {number} quantity - 本数
 * @param {string} onDate - この日時点の税率を使う（YYYY-MM-DD）
 */
function taxFor(db, product, quantity, onDate) {
  if (!product) return { amount: null, reason: '商品が見つかりません' };
  if (!product.tax_category) {
    return { amount: null, reason: '酒類区分が未設定です' };
  }
  if (product.volume_ml == null) {
    return { amount: null, reason: '容量(ml)が未設定です' };
  }
  if (product.abv == null) {
    return { amount: null, reason: '規定度数が未設定です' };
  }

  const rate = findRate(db, product.tax_category, onDate);
  if (!rate) {
    return { amount: null, reason: `酒類区分「${product.tax_category}」の税率が登録されていません` };
  }

  const perKl = yenPerKl(rate, product.abv);
  const volumeMl = product.volume_ml * quantity;
  return {
    amount: yen((volumeMl * perKl) / ML_PER_KL),
    volumeMl,
    yenPerKl: perKl,
    yenPerMl: perKl / ML_PER_KL,
    rate,
    reason: null,
  };
}

/**
 * 在庫変動履歴に書く課税額。
 *
 * 税率が引けなくても**出荷そのものは止めない**（在庫が動いた事実は記録する）。
 * 空のまま入り、酒税タブで名指しで出る。
 */
function ledgerTaxAmount(db, product, quantity, onDate) {
  return taxFor(db, product, quantity, onDate).amount;
}

// ---------------------------------------------------------------------------
// 月次集計
// ---------------------------------------------------------------------------

// 課税移出。受注の発送もサンプル送付も、txn_type は '出荷'
const TAXABLE_TYPE = '出荷';
// 参考として別枠に出すもの。未納税移出は相手先で課税されるので**除外**、
// 返品（戻入）は**今回は控除しない**（利用者が酒税法の改正を確かめてから判断する）
const REFERENCE_TYPES = ['未納税移出', '返品'];

function ledgerRows(db, month, txnType) {
  return db
    .prepare(
      `SELECT l.id, l.txn_date, l.quantity, l.order_id, l.sample_shipment_id,
              l.counterparty, l.tax_amount AS ledger_tax_amount,
              p.id AS product_id, p.name AS product_name, p.volume_ml, p.abv,
              p.tax_category
         FROM product_stock_ledger l
         JOIN products p ON p.id = l.product_id
        WHERE l.txn_type = @txnType
          AND l.is_cancelled = 0
          AND substr(l.txn_date, 1, 7) = @month
        ORDER BY p.name, l.txn_date, l.id`
    )
    .all({ month, txnType });
}

/**
 * 商品ごとにまとめる。
 *
 * 税率が引けない商品は金額に混ぜず unresolved に落とす。
 * **数量と容量だけは出す**（何がどれだけ抜けているのか分からないと直せない）。
 */
function summarize(db, rows, onDate) {
  const byProduct = new Map();
  const unresolved = new Map();

  for (const row of rows) {
    const calc = taxFor(db, row, row.quantity, onDate);
    const bucket = calc.reason ? unresolved : byProduct;
    const key = row.product_id;

    if (!bucket.has(key)) {
      bucket.set(key, {
        productId: row.product_id,
        productName: row.product_name,
        volumeMl: row.volume_ml,
        abv: row.abv,
        taxCategory: row.tax_category,
        quantity: 0,
        totalVolumeMl: 0,
        yenPerKl: calc.yenPerKl ?? null,
        rateNote: calc.rate?.note ?? null,
        effectiveFrom: calc.rate?.effective_from ?? null,
        taxAmount: calc.reason ? null : 0,
        reason: calc.reason,
        rowCount: 0,
      });
    }

    const entry = bucket.get(key);
    entry.quantity += row.quantity;
    entry.totalVolumeMl += (row.volume_ml ?? 0) * row.quantity;
    entry.rowCount += 1;
    if (!calc.reason) entry.taxAmount = yen(entry.taxAmount + calc.amount);
  }

  const resolved = [...byProduct.values()].map((entry) => ({
    ...entry,
    totalVolumeL: yen(entry.totalVolumeMl / 1000),
  }));
  const missing = [...unresolved.values()].map((entry) => ({
    ...entry,
    totalVolumeL: yen(entry.totalVolumeMl / 1000),
  }));

  return {
    rows: resolved,
    unresolved: missing,
    totals: {
      quantity: resolved.reduce((t, r) => t + r.quantity, 0),
      totalVolumeL: yen(resolved.reduce((t, r) => t + r.totalVolumeMl, 0) / 1000),
      taxAmount: yen(resolved.reduce((t, r) => t + r.taxAmount, 0)),
      productCount: resolved.length,
    },
  };
}

/**
 * 対象月の酒税。
 *
 * @param {string} month - YYYY-MM
 * @returns 課税移出（出荷）の内訳と合計、参考（未納税移出・返品）、
 *          税率が引けなかった商品
 */
function monthlyReport(month) {
  assertMonth(month);
  const db = getConnection();
  const onDate = endOfMonth(month);

  const taxable = summarize(db, ledgerRows(db, month, TAXABLE_TYPE), onDate);

  const reference = {};
  for (const type of REFERENCE_TYPES) {
    const summary = summarize(db, ledgerRows(db, month, type), onDate);
    reference[type] = {
      rows: [...summary.rows, ...summary.unresolved],
      totals: summary.totals,
    };
  }

  return {
    month,
    rateAsOf: onDate,
    taxable: { rows: taxable.rows, totals: taxable.totals },
    // 名指しにする。黙って0円にすると申告額が過少になる
    unresolved: taxable.unresolved,
    reference,
  };
}

// ---------------------------------------------------------------------------
// 過去分の課税額の入れ直し
// ---------------------------------------------------------------------------

/**
 * 台帳に入っている課税額を、いまの計算で入れ直す。
 *
 * マイグレーションではやらない（税率が登録されていないと計算できない）。
 * 画面のボタンから、件数を見せたうえで実行する。
 *
 * @param {object} [options]
 * @param {boolean} [options.apply] - false なら書き換えず件数だけ返す
 */
function backfillTaxAmounts({ apply = false } = {}, actor = null) {
  const db = getConnection();

  const rows = db
    .prepare(
      `SELECT l.id, l.txn_date, l.quantity, l.tax_amount,
              p.id AS product_id, p.name AS product_name,
              p.volume_ml, p.abv, p.tax_category
         FROM product_stock_ledger l
         JOIN products p ON p.id = l.product_id
        WHERE l.txn_type = @txnType
        ORDER BY l.txn_date, l.id`
    )
    .all({ txnType: TAXABLE_TYPE });

  const changes = [];
  const skipped = new Map();

  for (const row of rows) {
    // 税率は**その出荷日**時点のもので入れる（改正をまたいだ過去分を今の率で塗らない）
    const calc = taxFor(db, row, row.quantity, row.txn_date);
    if (calc.reason) {
      if (!skipped.has(row.product_id)) {
        skipped.set(row.product_id, {
          productName: row.product_name,
          reason: calc.reason,
          count: 0,
        });
      }
      skipped.get(row.product_id).count += 1;
      continue;
    }
    const before = row.tax_amount == null ? null : yen(row.tax_amount);
    if (before === calc.amount) continue;
    changes.push({
      ledgerId: row.id,
      txnDate: row.txn_date,
      productName: row.product_name,
      quantity: row.quantity,
      before,
      after: calc.amount,
    });
  }

  if (apply && changes.length) {
    const update = db.prepare(
      `UPDATE product_stock_ledger
          SET tax_amount = @taxAmount, updated_at = datetime('now')
        WHERE id = @id`
    );
    db.transaction(() => {
      for (const change of changes) {
        update.run({ id: change.ledgerId, taxAmount: change.after });
      }
    })();

    operationLogService.record({
      user: actor,
      action: 'liquor_tax.backfill',
      targetType: 'product_stock_ledger',
      summary: `商品在庫変動履歴の課税額を ${changes.length} 件入れ直した（容量×数量×税率で再計算）`,
      detail: { changed: changes.length, skipped: [...skipped.values()] },
    });
  }

  return {
    applied: apply,
    changedCount: changes.length,
    // 画面で先に見せる分。全件返すと重いので頭だけ
    changes: changes.slice(0, 200),
    totalLedgerRows: rows.length,
    skipped: [...skipped.values()],
  };
}

module.exports = {
  // 税率マスタ
  listRates,
  listCategories,
  saveRate,
  deleteRate,
  // 計算
  findRate,
  yenPerKl,
  taxFor,
  ledgerTaxAmount,
  // 集計
  monthlyReport,
  backfillTaxAmounts,
  // 日付
  previousMonth,
  endOfMonth,
  TAXABLE_TYPE,
  REFERENCE_TYPES,
};
