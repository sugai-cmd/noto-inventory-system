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
const { readMergedAliases, aliasTarget } = require('./lib/aliasFile');
const { suggest } = require('./lib/similarName');

// 移行スクリプトと同じ環境変数で置き場を差し替えられる。
// 試験が実データのフォルダを退避して戻す作りにならないようにするため
// （退避の途中で落ちると利用者のCSVが戻らない）。
const DATA_DIR = process.env.MIGRATION_CSV_DIR
  ? path.resolve(process.env.MIGRATION_CSV_DIR)
  : path.resolve(__dirname, 'data', 'csv');
const ALIASES_PATH = process.env.MIGRATION_ALIASES
  ? path.resolve(process.env.MIGRATION_ALIASES)
  : path.resolve(__dirname, 'data', 'aliases.json');

/**
 * モニターの名前を、こちらのマスタ名に寄せるための補正表。
 *
 * 移行と**同じ表**を使う。片方だけが読み替えを知らないと、移行では正しく
 * 寄っているのに答え合わせだけ「こちらに同じ名前がありません」と出て、
 * 直すところが無いものを探すことになる（タンクモニターの「タンク1」で実際に起きた）。
 */
function loadAliases() {
  try {
    const { aliases, warnings } = readMergedAliases(ALIASES_PATH);
    for (const w of warnings) console.warn(`[aliases.json] ${w}`);
    return aliases;
  } catch (e) {
    console.warn(`[aliases.json] 補正表を読めませんでした（読み替えなしで続けます）: ${e.message}`);
    return {};
  }
}

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

/**
 * モニターの1行を、こちらのどの行と突き合わせるかを決める。
 * そのままの名前 → 補正表 の順に試す（移行の resolveId と同じ順序）。
 */
function matchRow(computed, aliases, aliasColumns, raw) {
  const direct = computed.get(normalizeName(raw));
  if (direct) return { row: direct, key: normalizeName(raw) };

  const target = aliasTarget(aliases, aliasColumns, raw, normalizeName);
  if (target) {
    const row = computed.get(normalizeName(target));
    if (row) return { row, key: normalizeName(target), via: target };
  }
  return { row: null };
}

/** 差のある行だけを表にして出す */
function compare(
  title,
  monitor,
  computed,
  fields,
  { note, aliases = {}, aliasColumns = [], breakdown } = {}
) {
  console.log(`\n=== ${title} ===`);
  if (!monitor) {
    console.log('  （突合用のCSVが無いので飛ばしました）');
    return { skipped: true, rows: 0, matched: 0, unmatched: 0, diff: 0 };
  }
  if (note) console.log(`  ${note}`);

  const diffs = [];
  const missing = [];
  const resolved = [];
  const seen = new Map(); // こちらの行 → 突き合わせたモニターの名前（重複を見つけるため）
  let matched = 0;

  for (const [, { key: raw, values }] of monitor) {
    const hit = matchRow(computed, aliases, aliasColumns, raw);
    if (!hit.row) {
      const candidates = suggest(raw, [...computed.keys()], { limit: 3 }).map((c) => c.name);
      missing.push({ name: raw, candidates });
      continue;
    }
    matched++;
    if (hit.via) resolved.push({ name: raw, to: hit.via });

    const before = seen.get(hit.key);
    if (before) missing.push({ name: raw, sameAs: before });
    else seen.set(hit.key, raw);

    for (const [name, label] of Object.entries(fields)) {
      const a = values[name];
      const b = hit.row[name];
      if (a == null || b == null) continue;
      if (Math.abs(a - b) < 0.005) continue;
      diffs.push({ name: raw, label, sheet: a, ours: b, delta: b - a, id: hit.row.id, field: name });
    }
  }

  const unmatched = missing.filter((m) => !m.sameAs).length;
  const duplicated = missing.length - unmatched;
  console.log(
    `  シート${monitor.size}件 → 突合${matched}件` +
      (unmatched ? ` / 名前が一致せず${unmatched}件` : '') +
      (duplicated ? ` / 同じ行に重なり${duplicated}件` : '')
  );

  for (const r of resolved) {
    console.log(`  ［補正表］${r.name} → ${r.to} として突き合わせました`);
  }

  if (diffs.length) {
    console.log(`  ${diffs.length}件に差がありました`);
    console.log(`  ${'名前'.padEnd(38)} ${'項目'.padEnd(8)} ${'シート'.padStart(10)} ${'こちら'.padStart(10)} ${'差'.padStart(10)}`);
    for (const d of diffs) {
      const f = (n) => (n == null ? '-' : String(Math.round(n * 100) / 100));
      console.log(
        `  ${d.name.slice(0, 36).padEnd(38)} ${d.label.padEnd(8)} ` +
          `${f(d.sheet).padStart(10)} ${f(d.ours).padStart(10)} ${(d.delta > 0 ? '+' : '') + f(d.delta)}`.padStart(10)
      );
      // 「こちら」の数字がどこから来たのかを、その場で出す。
      // 内訳が無いと「差がある」で止まってしまい、初期値なのか台帳なのかを
      // 毎回SQLで調べ直すことになる（実データの仕掛品で実際にそうなった）。
      if (breakdown) {
        const detail = breakdown(d.id, d.field);
        if (detail) console.log(`      内訳: ${detail}`);
      }
    }
  } else if (matched) {
    console.log('  突き合わせた行に差はありません');
  }

  for (const m of missing) {
    if (m.sameAs) {
      // シートの2行が、こちらの1行に寄っている。片方だけ見て「合っている」と
      // 早合点しないよう、必ず言う（資材の「30mlミニボトル」で実際に起きた）
      console.log(`  ［重複］${m.name} は「${m.sameAs}」と同じ行に寄っています。シート側で分かれています`);
      continue;
    }
    const hint = m.candidates.length ? `似ている名前: ${m.candidates.join(' / ')}` : '似ている名前はありません';
    console.log(`  ［未対応］${m.name} … こちらに同じ名前がありません（${hint}）`);
  }

  return { rows: monitor.size, matched, unmatched, diff: diffs.length };
}

/** 「初期100 + 入荷20 - 消費5 = 115」の形に組み立てる */
function formatBreakdown(initial, moves) {
  const round = (n) => Math.round(n * 100) / 100;
  let total = initial;
  let text = `初期${round(initial)}`;
  for (const { label, sign, quantity } of moves) {
    if (!quantity) continue;
    total += sign * quantity;
    text += ` ${sign > 0 ? '+' : '-'} ${label}${round(quantity)}`;
  }
  return `${text} = ${round(total)}`;
}

/** v_product_stock と同じ式を、項目ごとに並べ直す */
function productBreakdown(db, productId, field) {
  const p = db
    .prepare('SELECT initial_product_stock, initial_wip_stock FROM products WHERE id = ?')
    .get(productId);
  if (!p) return null;

  const sums = new Map(
    db
      .prepare(
        `SELECT txn_type, SUM(quantity) AS q FROM product_stock_ledger
          WHERE product_id = ? AND is_cancelled = 0 GROUP BY txn_type`
      )
      .all(productId)
      .map((r) => [r.txn_type, r.q])
  );
  const q = (type) => sums.get(type) ?? 0;

  if (field === '仕掛品') {
    return formatBreakdown(p.initial_wip_stock, [
      { label: '瓶詰', sign: 1, quantity: q('瓶詰') },
      { label: '箱詰', sign: -1, quantity: q('箱詰') },
      { label: '棚卸調整', sign: 1, quantity: q('棚卸調整_仕掛品') },
      { label: '欠損', sign: -1, quantity: q('欠損_仕掛品') },
    ]);
  }
  return formatBreakdown(p.initial_product_stock, [
    { label: '箱詰', sign: 1, quantity: q('箱詰') },
    { label: '返品', sign: 1, quantity: q('返品') },
    { label: '出荷', sign: -1, quantity: q('出荷') },
    { label: '棚卸調整', sign: 1, quantity: q('棚卸調整_商品') },
    { label: '欠損', sign: -1, quantity: q('欠損_商品') },
  ]);
}

/** v_material_stock と同じ式 */
function materialBreakdown(db, materialId) {
  const m = db.prepare('SELECT initial_stock FROM materials WHERE id = ?').get(materialId);
  if (!m) return null;

  const sums = new Map(
    db
      .prepare(
        `SELECT txn_type, SUM(quantity) AS q FROM material_stock_ledger
          WHERE material_id = ? AND is_cancelled = 0 GROUP BY txn_type`
      )
      .all(materialId)
      .map((r) => [r.txn_type, r.q])
  );
  const q = (type) => sums.get(type) ?? 0;

  return formatBreakdown(m.initial_stock, [
    { label: '入荷', sign: 1, quantity: q('入荷') },
    { label: '消費', sign: -1, quantity: q('消費') },
    { label: '棚卸調整', sign: 1, quantity: q('棚卸調整') },
    { label: '欠損', sign: -1, quantity: q('欠損') },
  ]);
}

/** v_tank_monitor と同じ式（受入＝to_tank、払出＝from_tank） */
function tankBreakdown(db, tankId) {
  const t = db.prepare('SELECT initial_volume_l FROM tanks WHERE id = ?').get(tankId);
  if (!t) return null;

  const io = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN to_tank_id   = ? THEN quantity_l END), 0) AS came,
         COALESCE(SUM(CASE WHEN from_tank_id = ? THEN quantity_l END), 0) AS went
       FROM tank_ledger
       WHERE is_cancelled = 0 AND (to_tank_id = ? OR from_tank_id = ?)`
    )
    .get(tankId, tankId, tankId, tankId);

  return formatBreakdown(t.initial_volume_l ?? 0, [
    { label: '受入', sign: 1, quantity: io.came },
    { label: '払出', sign: -1, quantity: io.went },
  ]);
}

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--exclude-order-prefix');
  const excludePrefix = idx >= 0 ? args[idx + 1] : null;

  const db = getConnection();
  const aliases = loadAliases();

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
      .prepare('SELECT product_id, name, product_stock, wip_stock FROM v_product_stock')
      .all()
      .map((r) => [
        normalizeName(r.name),
        { id: r.product_id, 商品: r.product_stock, 仕掛品: r.wip_stock },
      ])
  );
  const p = compare(
    '商品在庫',
    loadMonitor('product_stock_monitor.csv', '商品名称', { 商品: '商品', 仕掛品: '仕掛品' }),
    productComputed,
    { 商品: '商品', 仕掛品: '仕掛品' },
    {
      aliases,
      aliasColumns: ['商品名称', '商品名', '商品'],
      breakdown: (id, field) => productBreakdown(db, id, field),
    }
  );

  // --- 資材在庫 ---
  const materialComputed = new Map(
    db
      .prepare('SELECT material_id, name, current_stock FROM v_material_stock')
      .all()
      .map((r) => [normalizeName(r.name), { id: r.material_id, 現在庫: r.current_stock }])
  );
  const m = compare(
    '資材在庫',
    loadMonitor('material_stock_monitor.csv', '資材名', { 現在庫: '現在庫数' }),
    materialComputed,
    { 現在庫: '現在庫' },
    {
      aliases,
      aliasColumns: ['資材名', '資材名称'],
      breakdown: (id) => materialBreakdown(db, id),
    }
  );

  // --- タンク ---
  // 容器IDでも引けるようにする。モニターが「T-001」と書いていることがある
  const tankComputed = new Map();
  const tankRows = db
    .prepare(
      'SELECT v.tank_id, t.code, v.name, v.current_volume_l FROM v_tank_monitor v JOIN tanks t ON t.id = v.tank_id'
    )
    .all();
  for (const r of tankRows) {
    const row = { id: r.tank_id, 現在液量: r.current_volume_l };
    tankComputed.set(normalizeName(r.name), row);
    if (r.code) tankComputed.set(normalizeName(r.code), row);
  }
  const t = compare(
    'タンクの現在液量',
    loadMonitor('tank_monitor.csv', '浄酎タンク', { 現在液量: '現在液量' }),
    tankComputed,
    { 現在液量: '現在液量' },
    {
      aliases,
      aliasColumns: ['浄酎タンク', '受入元', '払出先', '元容器ID'],
      note: 'モニターの名前（タンク1）と容器マスタの名前（ステンレスタンク1）が違うときは、補正表で寄せます',
      breakdown: (id) => tankBreakdown(db, id),
    }
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
  const line = (label, r) =>
    r.skipped
      ? `  ${label}: 突合用のCSVが無いので飛ばしました`
      : `  ${label}: シート${r.rows}件 → 突合${r.matched}件 / 差${r.diff}件` +
        (r.unmatched ? ` / 名前が一致せず${r.unmatched}件` : '');
  console.log(line('商品在庫', p));
  console.log(line('資材在庫', m));
  console.log(line('タンク  ', t));
  console.log('\n差を消す方法は棚卸です（/stocktaking.html）。');
  console.log('実際に数えた数を入れると、差が調整の記録として台帳に残ります。');
}

main();
