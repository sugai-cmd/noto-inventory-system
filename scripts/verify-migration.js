#!/usr/bin/env node
// 移行の答え合わせ。
//
// 新システムは在庫を**台帳から計算する**（v_product_stock / v_material_stock / v_tank_monitor）。
// 一方、現行シートのモニターは GAS が操作のたびにセルへ足し引きしていた**別建ての数字**で、
// 台帳から計算し直したものではない。そのため両者は一致しないのが普通で、
// このスクリプトはどこがどれだけ違うかを並べて出す。
//
// 使い方:
//   node scripts/verify-migration.js
//   node scripts/verify-migration.js --exclude-order-prefix O2609   （テスト入力を除いて見る）
//
// 突合に使うシートは scripts/data/csv/ に置く（無ければその項目は飛ばす）:
//   product_stock_monitor.csv   商品在庫モニター（商品名称・商品・仕掛品）
//   material_stock_monitor.csv  資材在庫モニター（資材名・現在庫数）
//   tank_monitor.csv            タンクモニター（浄酎タンク・現在液量）

const path = require('node:path');
const { getConnection } = require('../src/db/connection');
const { readCsv } = require('./lib/csvReader');
const { parseNumber } = require('./lib/parseNumber');
const { normalizeName } = require('../src/utils/normalizeName');

const DATA_DIR = path.resolve(__dirname, 'data', 'csv');

function loadMonitor(file, keyColumn, valueColumns) {
  const rows = readCsv(path.join(DATA_DIR, file));
  if (rows === null) return null;

  const map = new Map();
  for (const row of rows) {
    const key = String(row[keyColumn] ?? '').trim();
    if (!key) continue;
    const values = {};
    for (const [name, column] of Object.entries(valueColumns)) {
      try {
        values[name] = parseNumber(row[column], column);
      } catch {
        values[name] = null; // 「-」など数値でないセルは比較しない
      }
    }
    map.set(normalizeName(key), { key, values });
  }
  return map;
}

/** 差のある行だけを表にして出す */
function compare(title, monitor, computed, fields, note) {
  console.log(`\n=== ${title} ===`);
  if (!monitor) {
    console.log('  （突合用のCSVが無いので飛ばしました）');
    return { checked: 0, diff: 0 };
  }
  if (note) console.log(`  ${note}`);

  const diffs = [];
  let checked = 0;
  for (const [key, { key: raw, values }] of monitor) {
    const mine = computed.get(key);
    if (!mine) {
      diffs.push({ name: raw, reason: 'こちらに同じ名前がありません' });
      continue;
    }
    checked++;
    for (const [name, label] of Object.entries(fields)) {
      const a = values[name];
      const b = mine[name];
      if (a == null || b == null) continue;
      if (Math.abs(a - b) < 0.005) continue;
      diffs.push({ name: raw, label, sheet: a, ours: b, delta: b - a });
    }
  }

  if (!diffs.length) {
    console.log(`  差はありません（${checked}件を突合）`);
  } else {
    console.log(`  ${checked}件を突合し、${diffs.length}件に差がありました`);
    console.log(`  ${'名前'.padEnd(38)} ${'項目'.padEnd(8)} ${'シート'.padStart(10)} ${'こちら'.padStart(10)} ${'差'.padStart(10)}`);
    for (const d of diffs) {
      if (d.reason) {
        console.log(`  ${d.name.padEnd(38)} ${d.reason}`);
        continue;
      }
      const f = (n) => (n == null ? '-' : String(Math.round(n * 100) / 100));
      console.log(
        `  ${d.name.slice(0, 36).padEnd(38)} ${d.label.padEnd(8)} ` +
          `${f(d.sheet).padStart(10)} ${f(d.ours).padStart(10)} ${(d.delta > 0 ? '+' : '') + f(d.delta)}`.padStart(10)
      );
    }
  }
  return { checked, diff: diffs.length };
}

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--exclude-order-prefix');
  const excludePrefix = idx >= 0 ? args[idx + 1] : null;

  const db = getConnection();

  console.log('=== 移行の答え合わせ ===');
  console.log('新システムは在庫を台帳から計算します。現行シートのモニターは');
  console.log('操作のたびにセルへ足し引きしていた別建ての数字なので、差が出るのが普通です。');
  console.log('差の理由を1件ずつ確かめて、最後は棚卸で合わせてください。');

  if (excludePrefix) {
    console.log(`\n（${excludePrefix} で始まる受注ぶんを除いた数字も併記します）`);
  }

  // --- 商品在庫 ---
  const productComputed = new Map(
    db
      .prepare('SELECT name, product_stock, wip_stock FROM v_product_stock')
      .all()
      .map((r) => [normalizeName(r.name), { 商品: r.product_stock, 仕掛品: r.wip_stock }])
  );
  const p = compare(
    '商品在庫',
    loadMonitor('product_stock_monitor.csv', '商品名称', { 商品: '商品', 仕掛品: '仕掛品' }),
    productComputed,
    { 商品: '商品', 仕掛品: '仕掛品' }
  );

  // --- 資材在庫 ---
  const materialComputed = new Map(
    db
      .prepare('SELECT name, current_stock FROM v_material_stock')
      .all()
      .map((r) => [normalizeName(r.name), { 現在庫: r.current_stock }])
  );
  const m = compare(
    '資材在庫',
    loadMonitor('material_stock_monitor.csv', '資材名', { 現在庫: '現在庫数' }),
    materialComputed,
    { 現在庫: '現在庫' }
  );

  // --- タンク ---
  const tankComputed = new Map(
    db
      .prepare('SELECT name, current_volume_l FROM v_tank_monitor')
      .all()
      .map((r) => [normalizeName(r.name), { 現在液量: r.current_volume_l }])
  );
  const t = compare(
    'タンクの現在液量',
    loadMonitor('tank_monitor.csv', '浄酎タンク', { 現在液量: '現在液量' }),
    tankComputed,
    { 現在液量: '現在液量' },
    'モニターの名前（タンク1）と容器マスタの名前（ステンレスタンク1）が違うと「同じ名前がありません」になります'
  );

  // --- テスト入力の影響 ---
  if (excludePrefix) {
    const rows = db
      .prepare(
        `SELECT p.name, SUM(l.quantity) AS qty
           FROM product_stock_ledger l
           JOIN products p ON p.id = l.product_id
           JOIN orders o ON o.id = l.order_id
          WHERE o.order_no LIKE ? AND l.is_cancelled = 0
          GROUP BY p.id`
      )
      .all(`${excludePrefix}%`);
    console.log(`\n=== ${excludePrefix} で始まる受注ぶんの出荷（既知の差） ===`);
    if (!rows.length) console.log('  ありません');
    for (const r of rows) console.log(`  ${r.name}: ${r.qty}本`);
  }

  // --- 台帳が合っていないタンク ---
  const negative = db
    .prepare('SELECT name, current_volume_l FROM v_tank_monitor WHERE current_volume_l < 0 ORDER BY current_volume_l')
    .all();
  if (negative.length) {
    console.log('\n=== 残量がマイナスになっているタンク ===');
    console.log('  台帳の払出が入庫を上回っています。移行前の在庫が容器マスタに入っていないか、');
    console.log('  払出の記録が多すぎるかのどちらかです。棚卸で実際の量を入れてください。');
    for (const r of negative) console.log(`  ${r.name}: ${Math.round(r.current_volume_l * 100) / 100}L`);
  }

  console.log('\n=== まとめ ===');
  console.log(`  商品在庫: ${p.checked}件中 ${p.diff}件に差`);
  console.log(`  資材在庫: ${m.checked}件中 ${m.diff}件に差`);
  console.log(`  タンク  : ${t.checked}件中 ${t.diff}件に差`);
  console.log('\n差を消す方法は棚卸です（/stocktaking.html）。');
  console.log('実際に数えた数を入れると、差が調整の記録として台帳に残ります。');
}

main();
