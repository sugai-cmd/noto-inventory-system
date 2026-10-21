#!/usr/bin/env node
// 1つの受注番号に、別々のお客様の明細が入っているものを分ける（一度きりの修正）。
//
//   node scripts/split-mixed-customer-orders.js           # dry-run。何も書き換えず、対応表だけ出す
//   node scripts/split-mixed-customer-orders.js --apply   # バックアップを取ってから書き換える
//
// 旧台帳で番号が重なっていた別々の受注が、移行のとき同じ受注番号の1行目・2行目になった
// （legacy_order_no が同じ D2606-00xx）。消し込み欄は受注番号ごとに MIN(customer_id) で
// お客様を1つに決めるので、片方のお客様の候補から消え、もう片方には2行の合算で出ていた。
//
// 1行目は番号をそのまま残し、2行目に新しい受注番号を振って line_no を 1 にする。
// 在庫台帳は orders.id でつながっているので、番号を変えても影響しない。
// legacy_order_no は残す（どの旧番号から来たかの跡）。
//
// **何も付けなければ dry-run。** 既存スクリプトの --dry-run とは逆にしてある
// （一度きりの書き換えなので、うっかり流しても本番が変わらない側に倒す）。

const fs = require('node:fs');
const path = require('node:path');
const { nextOrderNo, toYymm } = require('../src/utils/codeGenerator');

/** 取消されていない行のうち、受注番号の中に別のお客様が混ざっているもの */
function findMixedOrders(db) {
  const orderNos = db
    .prepare(
      `SELECT order_no FROM orders
        WHERE is_cancelled = 0
        GROUP BY order_no
       HAVING COUNT(DISTINCT customer_id) > 1
        ORDER BY order_no`
    )
    .all()
    .map((r) => r.order_no);

  const lines = db.prepare(
    `SELECT o.id, o.order_no, o.line_no, o.ordered_on, o.customer_id, c.name AS customer_name,
            p.name AS product_name, o.quantity, o.total_amount, o.legacy_order_no
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN products p ON p.id = o.product_id
      WHERE o.order_no = ? AND o.is_cancelled = 0
      ORDER BY o.line_no`
  );
  return orderNos.map((orderNo) => ({ orderNo, lines: lines.all(orderNo) }));
}

/**
 * 分け方を決める。DBは読むだけ。
 * 想定した形（取消されていない行が2行で、line_no 1 と 2、お客様が違う）以外があれば、
 * 何も決めずに problems に入れて返す。1件でもあれば呼び出し側は書き換えない。
 */
function planSplit(db) {
  const mixed = findMixedOrders(db);
  const problems = [];
  const moves = [];

  for (const { orderNo, lines } of mixed) {
    const [first, second] = lines;
    if (lines.length !== 2 || first.line_no !== 1 || second.line_no !== 2) {
      problems.push({ orderNo, reason: `取消されていない行が ${lines.length} 行（line_no ${lines.map((l) => l.line_no).join(',')}）`, lines });
      continue;
    }
    if (first.customer_id === second.customer_id) {
      problems.push({ orderNo, reason: '1行目と2行目のお客様が同じ', lines });
      continue;
    }
    moves.push({ orderNo, keep: first, move: second, newOrderNo: null });
  }

  // 採番は nextOrderNo と同じく「その月の最大連番+1」。dry-run では書かないので、
  // 同じ月の2件目以降はここで1つずつ進める
  const nextSeq = new Map();
  for (const m of moves) {
    const yymm = toYymm(m.move.ordered_on);
    if (!nextSeq.has(yymm)) {
      const first = nextOrderNo(db, m.move.ordered_on);
      nextSeq.set(yymm, Number.parseInt(first.slice(first.indexOf('-') + 1), 10));
    }
    const seq = nextSeq.get(yymm);
    m.newOrderNo = `O${yymm}-${String(seq).padStart(4, '0')}`;
    nextSeq.set(yymm, seq + 1);
  }

  return { moves, problems };
}

/** 決めた分け方で書き換える。全件を1つのトランザクションで行う */
function applySplit(db, plan) {
  if (plan.problems.length) throw new Error('想定外の形の受注番号があるので書き換えません');

  const update = db.prepare(
    `UPDATE orders SET order_no = @newOrderNo, line_no = 1, updated_at = datetime('now')
      WHERE id = @id AND order_no = @orderNo AND line_no = 2 AND is_cancelled = 0`
  );
  const taken = db.prepare('SELECT 1 FROM orders WHERE order_no = ?');

  db.transaction(() => {
    for (const m of plan.moves) {
      // 計画を作ってから書き換えるまでの間に、同じ番号が使われていないか
      if (taken.get(m.newOrderNo)) throw new Error(`${m.newOrderNo} はすでに使われています`);
      const { changes } = update.run({ id: m.move.id, orderNo: m.orderNo, newOrderNo: m.newOrderNo });
      if (changes !== 1) throw new Error(`${m.orderNo} の2行目（id ${m.move.id}）を書き換えられませんでした`);
    }
    if (findMixedOrders(db).length) throw new Error('書き換えた後も、お客様が混ざった受注番号が残っています');
  })();
}

const yen = (n) => (n == null ? '-' : `${Number(n).toLocaleString('ja-JP')}円`);
const describe = (l) => `${l.customer_name}／${l.product_name ?? '?'} ×${l.quantity}／${yen(l.total_amount)}（${l.ordered_on}）`;

function printPlan(plan) {
  for (const m of plan.moves) {
    console.log(`${m.orderNo}（旧 ${m.keep.legacy_order_no ?? '-'}）`);
    console.log(`  1行目 そのまま        ${describe(m.keep)}`);
    console.log(`  2行目 → ${m.newOrderNo}  ${describe(m.move)}`);
  }
  for (const p of plan.problems) {
    console.log(`${p.orderNo}: 想定外の形のため分けません — ${p.reason}`);
    for (const l of p.lines) console.log(`  行${l.line_no} ${describe(l)}`);
  }
  console.log(`\n分ける受注番号: ${plan.moves.length}件／想定外: ${plan.problems.length}件`);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const Database = require('better-sqlite3');
  const { dbPath } = require('../src/config');
  const apply = process.argv.includes('--apply');

  if (!fs.existsSync(dbPath)) throw new Error(`DBが見つかりません: ${dbPath}`);
  console.log(`DB: ${dbPath}${apply ? '' : '（dry-run・読み取り専用で開いています）'}\n`);

  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    if (apply) db.pragma('foreign_keys = ON');
    const plan = planSplit(db);
    printPlan(plan);

    if (!plan.moves.length) return;
    if (plan.problems.length) {
      console.log('\n想定外の形があるので、書き換えません。');
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      console.log('\ndry-run なので何も書き換えていません。書き換えるときは --apply を付けてください。');
      return;
    }

    // DBの隣の backups/（db/database.sqlite なら backups/）。worktree から流しても本番の横に残す
    const backupDir = path.resolve(path.dirname(dbPath), '..', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `before-split-orders-${stamp()}.sqlite`);
    await db.backup(backupFile);
    console.log(`\nバックアップ: ${backupFile}`);

    applySplit(db, plan);
    console.log(`${plan.moves.length}件の2行目に新しい受注番号を振りました。`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { findMixedOrders, planSplit, applySplit };
