// 経営数値シート（上司向け・閲覧専用のGoogleスプレッドシート）の中身を作る。
//
// 毎朝 scripts/export-management-sheet.js がこれを作り、スプレッドシートに貼った
// Apps Script（gas/management-sheet/Code.gs）へ送る。手順と数字の定義は docs/MANAGEMENT-SHEET.md。
//
// **読むだけ。** DBには何も書かない。
//
// シートは「表のまま」組み立てて送る（見出し行＋データ行）。Apps Script 側は貼るだけにして、
// 数え方はすべてこちら（＝試験が書ける側）に置く。Apps Script がするのは見た目だけ：
// 列の折りたたみ・赤色・数値の書式・保護。
//
// 金額の考え方は週次報告（weeklyReportService）と同じ。
//   - 売上は売価（sales_amount、税抜）。取消は数えない。
//   - 販売方法が「委託」の受注は預けただけなので売上に数えず、委託の報告を報告月で数える。
//   - 税込は「売価 ＋ 売価の消費税 ＋ 送料」で出し直す（total_amount は読まない）。
// 原価は productCostService のいまの値（過去の受注も、いまの単価で計算する）。

const { getConnection } = require('../db/connection');
const { today } = require('../utils/dateUtil');
const weekly = require('./weeklyReportService');
const { listProductCosts } = require('./productCostService');
const liquorTaxService = require('./liquorTaxService');

const { yen, taxIncluded, addDays, monthOf } = weekly;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function blank(v) {
  return v === null || v === undefined ? '' : v;
}

function ratio(numerator, denominator) {
  if (numerator == null || !denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** 月の末日 */
function lastDayOf(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** from〜to（YYYY-MM）の月を並べる */
function monthsBetween(from, to) {
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) months.push(m);
  return months;
}

// ---------------------------------------------------------------------------
// 日別の横並び（受注ベース売上高・入金ベース）
// ---------------------------------------------------------------------------

/**
 * 列を [月合計][その月の1日][2日]… の順に並べ、日の列を月ごとにまとめて畳めるようにする。
 *
 * @param {string[]} months
 * @param {string} throughDate - これより後の日は列を作らない（入金予定のように先の日付も見たいときは月末まで）
 * @param {object[]} lines - { label, byDay: Map<日付, 値>, byMonth?: Map<月, 値> }。
 *   月合計は byMonth があればそれ、なければ日の合計。
 * @param {string} currentMonth - この月だけは畳まずに開いておく
 */
function dailyMatrix(months, throughDate, lines, currentMonth) {
  const header = ['項目'];
  const columns = []; // { kind: 'month'|'day', key }
  const columnGroups = [];

  for (const month of months) {
    header.push(`${month.replace('-', '年')}月 合計`);
    columns.push({ kind: 'month', key: month });
    const start = columns.length + 2; // 1始まりの列番号（A列が項目）
    let count = 0;
    for (let d = 1; d <= lastDayOf(month); d++) {
      const day = `${month}-${String(d).padStart(2, '0')}`;
      if (day > throughDate) break;
      header.push(day);
      columns.push({ kind: 'day', key: day });
      count++;
    }
    if (count > 0) columnGroups.push({ start, count, collapsed: month !== currentMonth });
  }

  const rows = [header];
  for (const line of lines) {
    if (line.section) {
      rows.push([line.section]);
      continue;
    }
    const row = [line.label];
    for (const col of columns) {
      if (col.kind === 'day') {
        row.push(blank(line.byDay.get(col.key)));
      } else if (line.byMonth) {
        row.push(blank(line.byMonth.get(col.key)));
      } else {
        let sum = null;
        for (const [day, v] of line.byDay) if (monthOf(day) === col.key) sum = (sum ?? 0) + v;
        row.push(blank(sum == null ? null : yen(sum)));
      }
    }
    rows.push(row);
  }
  return { rows, columnGroups };
}

function addTo(map, key, value) {
  map.set(key, yen((map.get(key) ?? 0) + (value ?? 0)));
}

function orderedDailySheet(db, throughDate) {
  const orders = db
    .prepare(
      `SELECT o.ordered_on, o.order_no, o.quantity, o.sales_amount, p.name AS product
         FROM orders o JOIN products p ON p.id = o.product_id
        WHERE o.is_cancelled = 0 AND o.ordered_on <= @throughDate
          AND (o.sales_method IS NULL OR o.sales_method <> '委託')
        ORDER BY o.ordered_on`
    )
    .all({ throughDate });
  const consignments = db
    .prepare(
      `SELECT r.report_month, r.quantity, r.sales_amount, p.name AS product
         FROM consignment_reports r JOIN products p ON p.id = r.product_id
        WHERE r.report_month <= @month`
    )
    .all({ month: monthOf(throughDate) });

  const firstMonth = [
    ...orders.map((o) => monthOf(o.ordered_on)),
    ...consignments.map((c) => c.report_month),
  ].sort()[0];
  const currentMonth = monthOf(throughDate);
  const months = monthsBetween(firstMonth ?? currentMonth, currentMonth);

  const purchase = new Map();
  const consignment = new Map();
  const total = new Map();
  const orderNos = new Map(); // 日 → Set
  const productQty = new Map(); // 商品 → { byDay, byMonth }
  const productSales = new Map();

  const productLine = (store, name) => {
    if (!store.has(name)) store.set(name, { byDay: new Map(), byMonth: new Map() });
    return store.get(name);
  };

  for (const o of orders) {
    addTo(purchase, o.ordered_on, o.sales_amount);
    if (!orderNos.has(o.ordered_on)) orderNos.set(o.ordered_on, new Set());
    orderNos.get(o.ordered_on).add(o.order_no);
    const q = productLine(productQty, o.product);
    addTo(q.byDay, o.ordered_on, o.quantity);
    addTo(q.byMonth, monthOf(o.ordered_on), o.quantity);
    const s = productLine(productSales, o.product);
    addTo(s.byDay, o.ordered_on, o.sales_amount);
    addTo(s.byMonth, monthOf(o.ordered_on), o.sales_amount);
  }
  // 委託は報告月で数える。日が無いので月合計の列にだけ入る
  for (const c of consignments) {
    addTo(consignment, c.report_month, c.sales_amount);
    addTo(productLine(productQty, c.product).byMonth, c.report_month, c.quantity);
    addTo(productLine(productSales, c.product).byMonth, c.report_month, c.sales_amount);
  }

  const purchaseByMonth = new Map();
  for (const [day, v] of purchase) addTo(purchaseByMonth, monthOf(day), v);
  for (const month of months) {
    total.set(month, yen((purchaseByMonth.get(month) ?? 0) + (consignment.get(month) ?? 0)));
  }

  const countByDay = new Map([...orderNos].map(([day, set]) => [day, set.size]));
  const countByMonth = new Map();
  for (const o of orders) {
    const m = monthOf(o.ordered_on);
    if (!countByMonth.has(m)) countByMonth.set(m, new Set());
    countByMonth.get(m).add(o.order_no);
  }

  const names = [...new Set([...productQty.keys()])].sort();
  const lines = [
    { label: '売上合計（税抜）', byDay: purchase, byMonth: total },
    { label: 'うち買取（受注日）', byDay: purchase },
    { label: 'うち委託（報告月）', byDay: new Map(), byMonth: consignment },
    {
      label: '受注件数',
      byDay: countByDay,
      byMonth: new Map([...countByMonth].map(([m, set]) => [m, set.size])),
    },
    { section: '商品別の本数' },
    ...names.map((n) => ({ label: n, ...productQty.get(n) })),
    { section: '商品別の売上（税抜）' },
    ...names.map((n) => ({ label: n, ...productSales.get(n) })),
  ];

  const { rows, columnGroups } = dailyMatrix(months, throughDate, lines, currentMonth);
  return {
    name: '受注ベース売上高',
    rows,
    frozenRows: 1,
    frozenColumns: 1,
    columnGroups,
    note: '月の合計の列の上にある「+」で、その月の日別を開けます。委託は報告月の合計にだけ入ります',
  };
}

function paymentDailySheet(db, throughDate) {
  const rows = db
    .prepare(
      `SELECT payment_due_on, paid_on, sales_amount, shipping_fee FROM orders WHERE is_cancelled = 0
       UNION ALL
       SELECT payment_due_on, paid_on, sales_amount, shipping_fee FROM consignment_reports`
    )
    .all();

  const due = new Map();
  const unpaid = new Map();
  const received = new Map();
  for (const r of rows) {
    const amount = taxIncluded(r.sales_amount, r.shipping_fee);
    if (r.payment_due_on) {
      addTo(due, r.payment_due_on, amount);
      if (!r.paid_on) addTo(unpaid, r.payment_due_on, amount);
    }
    if (r.paid_on) addTo(received, r.paid_on, amount);
  }

  // 入金予定は先の日付もある。いちばん先の入金予定の月末まで列を作る
  const days = [...due.keys(), ...received.keys()].sort();
  const currentMonth = monthOf(throughDate);
  const lastDay = days.length ? days[days.length - 1] : throughDate;
  const endMonth = monthOf(lastDay > throughDate ? lastDay : throughDate);
  const months = monthsBetween(days.length ? monthOf(days[0]) : currentMonth, endMonth);

  const { rows: table, columnGroups } = dailyMatrix(
    months,
    `${endMonth}-31`,
    [
      { label: '入金予定額（税込・入金予定日）', byDay: due },
      { label: 'うち未入金', byDay: unpaid },
      { label: '入金額（税込・入金日）', byDay: received },
    ],
    currentMonth
  );
  return {
    name: '入金ベース',
    rows: table,
    frozenRows: 1,
    frozenColumns: 1,
    columnGroups,
    note: '税込＝売価＋売価の消費税＋送料。買取・委託の両方を含みます',
  };
}

// ---------------------------------------------------------------------------
// 一覧のシート
// ---------------------------------------------------------------------------

function ordersSheet(db, costs) {
  const costOf = new Map(costs.products.map((p) => [p.id, p]));
  const lines = db
    .prepare(
      `SELECT o.*, c.name AS customer_name, p.name AS product_name
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN products p ON p.id = o.product_id
        ORDER BY o.ordered_on DESC, o.order_no DESC, o.line_no`
    )
    .all();

  const header = [
    '受注番号', '行', '受注日', '得意先名', '商品名', '本数', '単価', '掛け率', '売価(税抜)', '送料',
    '合計(税込)', '納入希望日', '請求日', '入金予定日', '入金日', '販売方法', '納品方法', 'ステータス',
    '配送先', '納品日', '備考', '取消', '取消理由',
    '原価(1本)', '原価合計', '粗利', '粗利率(%)', '酒税', '粗利(酒税を引いた後)',
  ];
  const rows = lines.map((o) => {
    const cost = costOf.get(o.product_id);
    // 取消と委託（預けただけ）は売上に数えないので、粗利も出さない
    const counted = !o.is_cancelled && o.sales_method !== '委託';
    const totalCost = counted && cost?.totalCost != null ? yen(cost.totalCost * o.quantity) : null;
    const profit = totalCost != null && o.sales_amount != null ? yen(o.sales_amount - totalCost) : null;
    const tax = counted ? liquorTaxService.taxFor(db, cost, o.quantity, o.ordered_on).amount : null;
    return [
      o.order_no, o.line_no, o.ordered_on, o.customer_name, o.product_name, o.quantity, o.unit_price,
      o.markup_rate, o.sales_amount, o.shipping_fee, taxIncluded(o.sales_amount, o.shipping_fee),
      o.requested_delivery_on, o.invoiced_on, o.payment_due_on, o.paid_on, o.sales_method,
      o.delivery_method, o.status, o.delivery_address, o.delivered_on, o.note,
      o.is_cancelled ? '取消' : '', o.cancel_reason,
      counted ? cost?.totalCost : null, totalCost, profit, ratio(profit, o.sales_amount), tax,
      profit != null && tax != null ? yen(profit - tax) : null,
    ].map(blank);
  });
  return {
    name: '受注明細',
    rows: [header, ...rows],
    frozenRows: 1,
    frozenColumns: 3,
    filter: true,
    note: '原価はいまの単価で計算した目安です。取消と委託（預け）の行は粗利を出しません',
  };
}

function salesTargetSheet(db, throughDate) {
  const currentMonth = monthOf(throughDate);
  const months = new Set(
    db.prepare('SELECT target_month AS m FROM sales_targets').all().map((r) => r.m)
  );
  for (const r of db.prepare("SELECT DISTINCT substr(ordered_on, 1, 7) AS m FROM orders WHERE is_cancelled = 0").all()) {
    months.add(r.m);
  }
  const rows = [...months]
    .filter((m) => m <= currentMonth)
    .sort()
    .reverse()
    .map((m) => {
      const s = weekly.monthlyOrderedSales(db, m, m === currentMonth ? throughDate : null);
      return [
        m, s.targetAmount, s.salesExclTax, s.targetAmount != null ? yen(s.salesExclTax - s.targetAmount) : null,
        s.progressRate, s.purchaseSales, s.consignmentSales, s.orders, s.quantity,
        m === currentMonth ? `${throughDate}まで` : '',
      ].map(blank);
    });
  return {
    name: '売上目標',
    rows: [
      ['月', '目標(税抜)', '実績(税抜・受注日)', '差', '進捗率(%)', 'うち買取', 'うち委託', '受注件数', '本数', '備考'],
      ...rows,
    ],
    frozenRows: 1,
  };
}

function overdueSheet(db, asOf) {
  const o = weekly.overdue(db, asOf);
  return {
    name: '入金遅れ',
    rows: [
      ['伝票番号', '得意先', '入金予定日', '金額(税込)', '遅れ(日)'],
      ...o.items.map((x) => [
        x.no, x.customer, x.paymentDueOn, x.amount,
        Math.round((Date.parse(asOf) - Date.parse(x.paymentDueOn)) / 86400000),
      ]),
    ],
    frozenRows: 1,
  };
}

function consignmentSheet(db, costs) {
  const costOf = new Map(costs.products.map((p) => [p.id, p]));
  const rows = db
    .prepare(
      `SELECT r.*, c.name AS customer_name, p.name AS product_name
         FROM consignment_reports r
         JOIN customers c ON c.id = r.customer_id
         JOIN products p ON p.id = r.product_id
        ORDER BY r.report_month DESC, r.report_no DESC`
    )
    .all()
    .map((r) => {
      const unitCost = costOf.get(r.product_id)?.totalCost;
      const totalCost = unitCost != null ? yen(unitCost * r.quantity) : null;
      const profit = totalCost != null && r.sales_amount != null ? yen(r.sales_amount - totalCost) : null;
      return [
        r.report_no, r.report_month, r.customer_name, r.product_name, r.quantity, r.unit_price,
        r.markup_rate, r.sales_amount, r.shipping_fee, taxIncluded(r.sales_amount, r.shipping_fee),
        r.invoiced_on, r.payment_due_on, r.paid_on, r.note, totalCost, profit, ratio(profit, r.sales_amount),
      ].map(blank);
    });
  return {
    name: '委託販売実績',
    rows: [
      [
        '報告番号', '報告月', '得意先', '商品', '本数', '単価', '掛け率', '売価(税抜)', '送料', '合計(税込)',
        '請求日', '入金予定日', '入金日', '備考', '原価合計', '粗利', '粗利率(%)',
      ],
      ...rows,
    ],
    frozenRows: 1,
    filter: true,
  };
}

/** 商品＋仕掛品の在庫と、資材の在庫から「あと何本作れるか」 */
function productStockSheet(db, costs) {
  const stockOf = new Map(
    db.prepare('SELECT product_id, product_stock, wip_stock FROM v_product_stock').all().map((r) => [r.product_id, r])
  );
  const materialStock = new Map(
    db.prepare('SELECT name, current_stock FROM v_material_stock').all().map((r) => [r.name, r.current_stock])
  );

  const rows = costs.products.map((p) => {
    const s = stockOf.get(p.id);
    const stock = (s?.product_stock ?? 0) + (s?.wip_stock ?? 0);

    // 同じ資材が瓶詰と箱詰の両方に出ることがあるので、資材ごとに足してから割る
    const need = new Map();
    for (const m of p.materials) need.set(m.material, (need.get(m.material) ?? 0) + m.qty);
    let makeable = null;
    let bottleneck = [];
    for (const [name, qty] of need) {
      if (!(qty > 0)) continue;
      const n = Math.max(0, Math.floor((materialStock.get(name) ?? 0) / qty));
      if (makeable == null || n < makeable) {
        makeable = n;
        bottleneck = [name];
      } else if (n === makeable) {
        bottleneck.push(name);
      }
    }
    return [
      p.name, stock, s?.product_stock ?? 0, s?.wip_stock ?? 0, makeable, bottleneck.join('、'),
      p.totalCost, p.totalCost != null ? yen(p.totalCost * stock) : null,
    ].map(blank);
  });
  return {
    name: '商品在庫',
    rows: [
      ['商品名', '在庫(商品＋仕掛品)', 'うち商品', 'うち仕掛品', 'あと作れる本数(資材)', 'いちばん先に足りなくなる資材', '原価(1本)', '在庫金額(原価)'],
      ...rows,
    ],
    frozenRows: 1,
    note: 'あと作れる本数は資材の在庫とレシピだけで出しています（タンクの中身は数えていません）',
  };
}

function materialSheet(db) {
  const list = db
    .prepare(
      `SELECT m.*, s.current_stock FROM materials m JOIN v_material_stock s ON s.material_id = m.id
        ORDER BY m.category, m.name`
    )
    .all();
  const highlightRows = [];
  const rows = list.map((m, i) => {
    const toOrder = m.proper_stock_qty != null && m.current_stock < m.proper_stock_qty;
    if (toOrder) highlightRows.push(i + 2);
    return [
      m.code, m.name, m.category, m.unit, m.current_stock, m.proper_stock_qty, toOrder ? '要発注' : '',
      m.unit_price, m.unit_price != null ? yen(m.unit_price * m.current_stock) : null, m.lot_size,
      m.supplier_name, m.lead_time_days,
    ].map(blank);
  });
  return {
    name: '資材在庫',
    rows: [
      ['資材ID', '資材名', '種別', '単位', '現在庫', '適正在庫', '要発注', '単価(円)', '在庫金額', 'ロット数', '発注先', 'リードタイム(日)'],
      ...rows,
    ],
    frozenRows: 1,
    filter: true,
    highlightRows,
    note: '赤い行は適正在庫を下回った資材です（適正在庫が空の資材は判定しません）',
  };
}

function tankSheet(db) {
  const tanks = db
    .prepare(
      `SELECT t.code, v.name, t.container_type, t.location, v.current_volume_l, v.max_volume_l, v.fill_rate
         FROM v_tank_monitor v JOIN tanks t ON t.id = v.tank_id
        WHERE t.discarded_on IS NULL AND COALESCE(t.is_raw_sake_tank, 0) = 0
          AND ABS(v.current_volume_l) > 0.0001
        ORDER BY t.code`
    )
    .all();
  const rawTanks = db
    .prepare(
      `SELECT v.code, v.name, v.current_volume_l, v.max_volume_l
         FROM v_raw_sake_tank_volume v JOIN tanks t ON t.id = v.tank_id
        WHERE t.discarded_on IS NULL AND ABS(v.current_volume_l) > 0.0001
          AND EXISTS (SELECT 1 FROM raw_sake_ledger l WHERE l.from_tank_id = v.tank_id OR l.to_tank_id = v.tank_id)
        ORDER BY v.code`
    )
    .all();
  // 原酒のロット（銘柄＋ロット）ごとの残り＝受入 − 蒸留へ引き当てた量
  const lots = db
    .prepare(
      `SELECT b.code, b.name, b.produced_on, b.abv, b.unit_price_per_l, b.used_for_cost,
              COALESCE(SUM(l.quantity), 0) AS received,
              COALESCE(SUM((SELECT SUM(a.quantity) FROM raw_sake_lot_allocations a
                              JOIN raw_sake_ledger p ON p.id = a.payout_ledger_id
                             WHERE a.receipt_ledger_id = l.id AND p.is_cancelled = 0)), 0) AS used
         FROM raw_sake_brands b
         LEFT JOIN raw_sake_ledger l
           ON l.raw_sake_brand_id = b.id AND l.txn_type = '受入' AND l.is_cancelled = 0
        GROUP BY b.id
        ORDER BY b.code`
    )
    .all();

  const rows = [
    ['浄酎の容器'],
    ['容器ID', '容器名称', '種別', '設置場所', '液量(L)', '最大容量(L)', '貯蔵率(%)'],
    ...tanks.map((t) =>
      [t.code, t.name, t.container_type, t.location, yen(t.current_volume_l), t.max_volume_l,
        t.fill_rate != null ? Math.round(t.fill_rate * 1000) / 10 : null].map(blank)
    ),
    [],
    ['原酒の容器'],
    ['容器ID', '容器名称', '液量(L)', '最大容量(L)'],
    ...rawTanks.map((t) => [t.code, t.name, yen(t.current_volume_l), t.max_volume_l].map(blank)),
    [],
    ['原酒のロット（仕込み年度ごとの単価）'],
    ['原酒ID', '銘柄', '製造年月', '度数', '受入(L)', '蒸留に使った(L)', '残り(L)', '単価(円/L)', '残りの金額', '原価に使用中'],
    ...lots.map((l) => {
      const rest = yen(l.received - l.used);
      return [
        l.code, l.name, l.produced_on, l.abv, yen(l.received), yen(l.used), rest, l.unit_price_per_l,
        l.unit_price_per_l != null ? yen(rest * l.unit_price_per_l) : null, l.used_for_cost ? '使用中' : '',
      ].map(blank);
    }),
  ];
  return { name: 'タンク・原酒', rows };
}

function productCostSheet(costs) {
  const rawSake = costs.rawSake;
  const rows = [
    [
      '原価に使っている原酒',
      rawSake ? `${rawSake.code ?? ''} ${rawSake.name}（${rawSake.produced_on ?? '製造年月なし'}）` : '未選択',
      '単価(円/L)',
      blank(rawSake?.unit_price_per_l),
    ],
    ['倍率（原酒L÷浄酎L）', costs.rates.map((r) => `${r.abv}度: ${r.raw_l}L→${r.distillate_l}L`).join(' / ')],
    [],
    [
      '商品名', '容量(ml)', '度数', '倍率', '中身の原価', '資材の原価', '商品原価(1本)', '上代', '上代に対する原価率(%)',
      '酒税(1本)', '資材の内訳', '注意',
    ],
  ];
  const db = getConnection();
  for (const p of costs.products) {
    const tax = liquorTaxService.taxFor(db, p, 1, null).amount;
    rows.push(
      [
        p.name, p.volume_ml, p.abv, p.ratio != null ? Math.round(p.ratio * 1000) / 1000 : null, p.liquidCost,
        p.materialCost, p.totalCost, p.list_price, ratio(p.totalCost, p.list_price), tax,
        p.materials.map((m) => `${m.material}×${m.qty}=${m.amount ?? '単価なし'}`).join(' / '),
        p.reasons.join(' / '),
      ].map(blank)
    );
  }
  return {
    name: '商品原価',
    rows,
    frozenRows: 4,
    note: '中身の原価＝容量(L)×倍率×原酒の単価。資材の原価＝レシピの数量×資材の単価（瓶詰＋箱詰）',
  };
}

function materialMasterSheet(db) {
  const rows = db.prepare('SELECT * FROM materials ORDER BY code').all();
  return {
    name: '資材マスタ',
    rows: [
      ['資材ID', '資材名', '種別', '単位', '単価(円)', 'ロット数', '適正在庫数', '発注先', '発注先住所', '発注先担当者', 'リードタイム(日)', '備考'],
      ...rows.map((m) =>
        [m.code, m.name, m.category, m.unit, m.unit_price, m.lot_size, m.proper_stock_qty, m.supplier_name,
          m.supplier_address, m.supplier_contact, m.lead_time_days, m.note].map(blank)
      ),
    ],
    frozenRows: 1,
    filter: true,
  };
}

function customerMasterSheet(db) {
  const rows = db
    .prepare(
      `SELECT c.*, p.name AS parent_name FROM customers c
         LEFT JOIN customers p ON p.id = c.parent_id ORDER BY c.code`
    )
    .all();
  return {
    name: '得意先マスタ',
    rows: [
      [
        '得意先ID', '得意先名', '本店', '区分', '業態', '掛け率', '郵便番号', '住所', '電話', '支払いサイト(月)',
        '支払日', '請求の備考', '請求先メール', '請求担当', '発注メール', '発注電話', '発注担当', '営業担当',
        '営業サブ担当', '販路', '販売形態', '最終訪問日', '最終受注日', '初回接触日', '契約日', '取引開始月', '備考',
      ],
      ...rows.map((c) =>
        [
          c.code, c.name, c.parent_name, c.segment, c.business_type, c.markup_rate, c.postal_code, c.address,
          c.phone, c.payment_term_months, c.payment_term_day, c.invoice_due_note, c.invoice_email,
          c.invoice_contact, c.order_email, c.order_phone, c.order_contact, c.sales_rep, c.sales_sub_rep,
          c.sales_channel, c.sales_type, c.last_visited_on, c.last_ordered_on, c.first_contacted_on,
          c.contract_signed_on, c.onboarded_month, c.note,
        ].map(blank)
      ),
    ],
    frozenRows: 1,
    frozenColumns: 2,
    filter: true,
  };
}

function summarySheet(db, { asOf, throughDate, generatedAt }, overdueInfo, materials) {
  const month = monthOf(throughDate);
  const ordered = weekly.monthlyOrderedSales(db, month, throughDate);
  const due = weekly.monthlyPaymentDue(db, month);
  const received = weekly.receivedBetween(db, `${month}-01`, throughDate);
  const toOrder = materials.highlightRows.length;

  return {
    name: 'サマリー',
    rows: [
      ['項目', '値', '説明'],
      [
        '最終更新',
        new Date(generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
        '毎朝自動で書き直します。このシートは閲覧専用です',
      ],
      ['集計の対象', `${month}-01〜${throughDate}`, '朝に集計するので前日までを数えます'],
      ['当月売上（税抜・受注日）', ordered.salesExclTax, '買取は受注日、委託は報告月で数えます。取消は除きます'],
      ['当月目標', blank(ordered.targetAmount), ''],
      ['当月進捗率(%)', blank(ordered.progressRate), ''],
      ['当月受注件数', ordered.orders, ''],
      ['当月本数', ordered.quantity, ''],
      ['当月入金予定額（税込）', due.dueAmount, '入金予定日が当月のもの'],
      ['うち入金済', due.paidAmount, ''],
      ['うち未入金', due.unpaidAmount, ''],
      ['当月入金額（税込）', received.amount, '入金日が当月1日〜前日のもの'],
      ['入金遅れ', `${overdueInfo.count}件`, '入金予定日を過ぎて入金日がない伝票（「入金遅れ」シート）'],
      ['入金遅れ額（税込）', overdueInfo.amount, ''],
      ['要発注の資材', `${toOrder}件`, '適正在庫を下回った資材（「資材在庫」シートの赤い行）'],
    ],
    frozenRows: 1,
    asOf,
  };
}

/**
 * 経営数値シートの中身を作る。
 *
 * @param {object} [options]
 * @param {string} [options.asOf] - 集計日 YYYY-MM-DD（既定は今日）。前日までを数える
 */
function buildManagementSheets({ asOf } = {}) {
  const date = asOf ?? today();
  if (!DATE_RE.test(date)) throw new Error(`集計日はYYYY-MM-DD形式で指定してください: "${date}"`);

  const db = getConnection();
  const throughDate = addDays(date, -1);
  const generatedAt = new Date().toISOString();
  const costs = listProductCosts();
  const materials = materialSheet(db);
  const overdueInfo = weekly.overdue(db, date);

  const sheets = [
    summarySheet(db, { asOf: date, throughDate, generatedAt }, overdueInfo, materials),
    ordersSheet(db, costs),
    orderedDailySheet(db, throughDate),
    paymentDailySheet(db, throughDate),
    salesTargetSheet(db, throughDate),
    overdueSheet(db, date),
    consignmentSheet(db, costs),
    productStockSheet(db, costs),
    materials,
    tankSheet(db),
    productCostSheet(costs),
    materialMasterSheet(db),
    customerMasterSheet(db),
  ];
  return { generatedAt, asOf: date, throughDate, sheets };
}

module.exports = { buildManagementSheets, dailyMatrix, monthsBetween };
