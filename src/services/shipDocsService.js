// 送り状（Webゆうパックプリント）・納品書（マネーフォワード）に登録する受注を選び、CSVを作る。
//
// 方針（2026-10-12 菅井さんと決定）
//   - 毎朝8時に自動。FAXが追加で届いた日は手動でも実行する
//   - 対象はカナカン（支店を含む）とCOREZOの受注だけ
//   - **出荷前**（未着手）の受注を登録する。朝のうちに送り状を印刷して出荷できるように
//     納品書の納品日は納品希望日、納品ステータスは「未納品」
//   - 一度登録できた受注は ship_doc_uploads に残し、二度と登録しない
//
// ブラウザの操作は src/services/shipDocs/ 以下。ここはDBとCSVだけ。

const fs = require('node:fs');
const path = require('node:path');
const iconv = require('iconv-lite');
const { getConnection } = require('../db/connection');
const csvExportService = require('./csvExportService');

const TARGETS = ['yupack', 'moneyforward'];

/**
 * 対象の得意先。カナカンは本店の下の支店で受注が立つので、本店名でも拾う。
 * COREZOは名前の表記ゆれ（COREZO / コレゾ / 金沢楽座）を拾う。
 * .env の SHIP_DOCS_CUSTOMER_IDS（カンマ区切り）があれば、そちらだけを使う。
 */
function targetCustomers(db, env = process.env) {
  if (env.SHIP_DOCS_CUSTOMER_IDS) {
    const ids = env.SHIP_DOCS_CUSTOMER_IDS.split(',').map((s) => Number(s.trim())).filter(Boolean);
    const placeholders = ids.map(() => '?').join(',') || 'NULL';
    return db.prepare(`SELECT id, name FROM customers WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
  }
  return db
    .prepare(
      `SELECT c.id, c.name
         FROM customers c
         LEFT JOIN customers p ON p.id = c.parent_id
        WHERE c.name LIKE 'カナカン%' OR p.name LIKE 'カナカン%'
           OR UPPER(c.name) LIKE '%COREZO%' OR c.name LIKE '%コレゾ%' OR c.name LIKE '%金沢楽座%'
        ORDER BY c.id`
    )
    .all();
}

/**
 * まだ登録していない、未出荷のカナカン・COREZOの受注。
 * @returns {{customers: object[], orders: {orderNo: string, ids: number[], customerName: string,
 *   requestedDeliveryOn: string|null}[], pending: Record<'yupack'|'moneyforward', string[]>}}
 */
function findTargets(db = getConnection(), env = process.env) {
  const customers = targetCustomers(db, env);
  if (!customers.length) return { customers, orders: [], pending: { yupack: [], moneyforward: [] } };

  const placeholders = customers.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.requested_delivery_on, c.name AS customer_name
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.is_cancelled = 0
          AND o.status = '未着手'
          AND o.customer_id IN (${placeholders})
        ORDER BY o.order_no, o.line_no`
    )
    .all(...customers.map((c) => c.id));

  const byNo = new Map();
  for (const r of rows) {
    if (!byNo.has(r.order_no)) {
      byNo.set(r.order_no, {
        orderNo: r.order_no,
        ids: [],
        customerName: r.customer_name,
        requestedDeliveryOn: r.requested_delivery_on,
      });
    }
    byNo.get(r.order_no).ids.push(r.id);
  }
  const orders = [...byNo.values()];

  const done = db.prepare('SELECT 1 FROM ship_doc_uploads WHERE order_no = ? AND target = ?');
  const pending = {};
  for (const t of TARGETS) {
    pending[t] = orders.filter((o) => !done.get(o.orderNo, t)).map((o) => o.orderNo);
  }
  return { customers, orders, pending };
}

function exportFor(target, orderIds) {
  return target === 'yupack'
    ? csvExportService.exportYuPack({ orderIds })
    : csvExportService.exportMoneyForward({ orderIds }, { beforeShipping: true });
}

function problemsOf(result) {
  return [
    ...(result.unresolved ?? []).map((u) => ({ orderNo: u.orderNo, reason: u.reason })),
    ...(result.overflow ?? []).map((o) => ({
      orderNo: o.orderNo,
      reason: `明細が${o.itemCount}件あり、納品書に7件までしか載りません`,
    })),
  ];
}

function idsOf(db, orderNos) {
  if (!orderNos.length) return [];
  const placeholders = orderNos.map(() => '?').join(',');
  return db
    .prepare(`SELECT id FROM orders WHERE order_no IN (${placeholders}) AND is_cancelled = 0`)
    .all(...orderNos)
    .map((r) => r.id);
}

/**
 * アップロードするCSVを作って保存する。
 * 住所が分解できない・段ボールが決まらないなど、**そのまま登録すると送り状が間違う受注は
 * CSVから外し**、problems として返す（人が直してから次の実行で登録される）。
 *
 * @param {string} target - 'yupack' | 'moneyforward'
 * @param {string[]} orderNos
 * @param {string} outDir
 * @returns {{file: string|null, orderNos: string[], problems: {orderNo: string, reason: string}[]}}
 */
function buildCsv(target, orderNos, outDir, db = getConnection()) {
  const empty = { file: null, orderNos: [], problems: [] };
  if (!orderNos.length) return empty;

  const problems = problemsOf(exportFor(target, idsOf(db, orderNos)));
  const bad = new Set(problems.map((p) => p.orderNo));
  const good = orderNos.filter((no) => !bad.has(no));
  if (!good.length) return { ...empty, problems };

  const result = exportFor(target, idsOf(db, good));
  const buffer =
    target === 'yupack'
      ? iconv.encode(result.csv + '\r\n', 'Shift_JIS')
      : Buffer.from(result.csv + '\r\n', 'utf8');

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, result.filename);
  fs.writeFileSync(file, buffer);
  return { file, orderNos: good, problems };
}

/** 登録できた受注を記録する（以後の実行で対象から外れる） */
function markUploaded(target, orderNos, csvFile, db = getConnection()) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ship_doc_uploads (order_no, target, csv_file) VALUES (?, ?, ?)`
  );
  db.transaction(() => {
    for (const no of orderNos) insert.run(no, target, csvFile ?? null);
  })();
}

module.exports = { findTargets, buildCsv, markUploaded, targetCustomers, TARGETS };
