/**
 * 週次報告の受け口（Googleスプレッドシートに貼るApps Script）。
 *
 * 受注管理システム（scripts/export-weekly-report.js）から送られた集計を、
 * このスプレッドシートに書き込む。手順は docs/WEEKLY-REPORT.md。
 *
 * シート
 *   推移         … 1日1行。同じ集計日は上書き（送り直しても行が増えない）
 *   最新サマリー … 最新の集計を項目ごとに縦に並べたもの（議事録づくりで読む）
 *   得意先別 / 商品別 / 商品在庫 / 要発注資材 / タンク / 原酒タンク / 入金遅れ
 *                … 最新の集計で毎回書き直す
 *
 * 合言葉は「プロジェクトの設定 → スクリプト プロパティ」の REPORT_SECRET に置く。
 * コードには書かない。
 */

const HISTORY_HEADERS = [
  '集計日', '集計対象(前日まで)', '対象月',
  '当月売上_受注日ベース(税抜・累計)', '当月目標', '当月進捗率(%)', '当月受注件数', '当月本数',
  '当月入金予定額(税込・入金予定日ベース)', 'うち入金済', 'うち未入金',
  '当月入金額(税込・入金日ベース・累計)',
  '前週期間', '前週売上_受注日ベース(税抜)', '前週受注件数', '前週入金額(税込)',
  '前月売上_受注日ベース(税抜・確定)', '前月目標', '前月進捗率(%)', '前月締め報告週',
  '入金遅れ件数', '入金遅れ額(税込)', '要発注資材数',
  '送信日時',
];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('REPORT_SECRET');
    if (!secret || payload.secret !== secret) {
      return json({ ok: false, error: '合言葉が一致しません' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      writeReport(payload.report);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true, message: payload.report.asOf + ' の集計を書き込みました' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function writeReport(r) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const c = r.current;
  const pm = r.previousMonth;

  // 推移（同じ集計日の行があれば上書き）
  const history = sheet(ss, '推移');
  if (history.getLastRow() === 0) {
    history.appendRow(HISTORY_HEADERS);
    history.setFrozenRows(1);
  }
  const row = [
    r.asOf, r.throughDate, r.month,
    c.ordered.salesExclTax, c.ordered.targetAmount, c.ordered.progressRate, c.ordered.orders, c.ordered.quantity,
    c.paymentDue.dueAmount, c.paymentDue.paidAmount, c.paymentDue.unpaidAmount,
    c.received.amount,
    r.week.from + '〜' + r.week.to, r.week.ordered.sales, r.week.ordered.orders, r.week.received.amount,
    pm.ordered.salesExclTax, pm.ordered.targetAmount, pm.ordered.progressRate, r.reportPreviousMonth ? 'はい' : '',
    r.overdue.count, r.overdue.amount, r.stock.materialsToOrder.length,
    r.generatedAt,
  ].map(blank);

  const last = history.getLastRow();
  let target = last + 1;
  if (last > 1) {
    const dates = history.getRange(2, 1, last - 1, 1).getDisplayValues().map((v) => v[0]);
    const found = dates.indexOf(r.asOf);
    if (found >= 0) target = found + 2;
  }
  // 日付は文字列のまま置く（日付型に変わると、次回の上書き判定で一致しなくなる）
  history.getRange(target, 1, 1, 3).setNumberFormat('@');
  history.getRange(target, 1, 1, row.length).setValues([row]);

  // 最新サマリー（議事録づくりで読む）
  const summary = [
    ['項目', '値'],
    ['集計日', r.asOf],
    ['集計対象', r.month + '-01 〜 ' + r.throughDate],
    ['当月売上（受注日ベース・税抜・月初から累計）', c.ordered.salesExclTax],
    ['　うち買取', c.ordered.purchaseSales],
    ['　うち委託（報告月）', c.ordered.consignmentSales],
    ['当月目標', c.ordered.targetAmount],
    ['当月進捗率(%)', c.ordered.progressRate],
    ['当月受注件数 / 本数', c.ordered.orders + '件 / ' + c.ordered.quantity + '本'],
    ['当月入金予定額（入金予定日ベース・税込）', c.paymentDue.dueAmount],
    ['　うち入金済', c.paymentDue.paidAmount],
    ['　うち未入金', c.paymentDue.unpaidAmount],
    ['当月入金額（入金日ベース・税込・月初から累計）', c.received.amount],
    ['前週（' + r.week.from + '〜' + r.week.to + '）売上（受注日ベース・税抜）', r.week.ordered.sales],
    ['前週受注件数 / 本数', r.week.ordered.orders + '件 / ' + r.week.ordered.quantity + '本'],
    ['前週入金額（税込）', r.week.received.amount],
    ['前月（' + pm.ordered.month + '）売上（受注日ベース・税抜・確定）', pm.ordered.salesExclTax],
    ['前月目標 / 進捗率(%)', blank(pm.ordered.targetAmount) + ' / ' + blank(pm.ordered.progressRate)],
    ['前月入金予定額 / うち未入金（税込）', pm.paymentDue.dueAmount + ' / ' + pm.paymentDue.unpaidAmount],
    ['今週の会議で前月の締めを報告する', r.reportPreviousMonth ? 'はい' : 'いいえ'],
    ['入金遅れ（件数 / 税込額）', r.overdue.count + '件 / ' + r.overdue.amount],
    ['要発注資材', r.stock.materialsToOrder.length + '件'],
    ['送信日時', r.generatedAt],
  ];
  rewrite(ss, '最新サマリー', summary.map((row) => row.map(blank)));

  rewrite(ss, '得意先別', [['得意先（' + r.month + ' 受注日ベース・税抜）', '本数', '売上']].concat(
    r.breakdown.byCustomer.map((x) => [x.name, x.quantity, x.salesExclTax])));
  rewrite(ss, '商品別', [['商品（' + r.month + ' 受注日ベース・税抜）', '本数', '売上']].concat(
    r.breakdown.byProduct.map((x) => [x.name, x.quantity, x.salesExclTax])));
  rewrite(ss, '商品在庫', [['商品名称', '商品（完成品）', '仕掛品']].concat(
    r.stock.products.map((x) => [x.name, x.productStock, x.wipStock])));
  rewrite(ss, '要発注資材', [['資材名', '現在庫', '単位', '適正在庫数', '発注先', 'リードタイム(日)']].concat(
    r.stock.materialsToOrder.map((x) => [x.name, x.currentStock, x.unit, x.properStock, x.supplier, x.leadTimeDays].map(blank))));
  rewrite(ss, 'タンク', [['容器ID', '容器名称', '現在液量(L)', '最大容量(L)', '貯蔵率(%)']].concat(
    r.stock.tanks.map((x) => [x.code, x.name, x.volumeL, x.maxVolumeL, x.fillRate].map(blank))));
  rewrite(ss, '原酒タンク', [['容器ID', '容器名称', '現在量(L)', '最大容量(L)']].concat(
    r.stock.rawSakeTanks.map((x) => [x.code, x.name, x.volumeL, x.maxVolumeL].map(blank))));
  rewrite(ss, '入金遅れ', [['伝票番号', '得意先', '入金予定日', '金額(税込)']].concat(
    r.overdue.items.map((x) => [x.no, x.customer, x.paymentDueOn, x.amount])));
}

function sheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** シートを空にして書き直す。1行目は見出し */
function rewrite(ss, name, rows) {
  const sh = sheet(ss, name);
  sh.clearContents();
  const width = Math.max.apply(null, rows.map((r) => r.length));
  const padded = rows.map((r) => r.concat(new Array(width - r.length).fill('')));
  sh.getRange(1, 1, padded.length, width).setValues(padded);
  sh.setFrozenRows(1);
}

function blank(v) {
  return v === null || v === undefined ? '' : v;
}
