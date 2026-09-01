#!/usr/bin/env node
//
// 現行スプレッドシート（CSVエクスポート）→ SQLite への一括移行スクリプト。
// 設計は DB_SCHEMA_DESIGN.md 8章を参照。
//
// 使い方:
//   node scripts/migrate-from-sheets.js --dry-run       # 投入せずレポートだけ出す
//   node scripts/migrate-from-sheets.js                 # --strict（既定）で投入
//   node scripts/migrate-from-sheets.js --allow-partial # 名寄せ不一致を許容して投入
//   node scripts/migrate-from-sheets.js --reset         # 台帳・トランザクションを消してから再投入
//
// 注意: 酒蔵マスタ・原酒マスタは 8-2 の決定により移行対象外。
//       移行後に /api/breweries, /api/raw-sake-brands から順次登録する。

const fs = require('node:fs');
const path = require('node:path');

const { getConnection } = require('../src/db/connection');
const { migrate } = require('../src/db/migrate');
const { normalizeName } = require('../src/utils/normalizeName');
const { MigrationReport } = require('./lib/report');

const DATA_DIR = path.resolve(__dirname, 'data', 'csv');
const REPORT_DIR = path.resolve(__dirname, 'migration-report');
const ALIASES_PATH = path.resolve(__dirname, 'data', 'aliases.json');

// 8.0のフェーズ順序。依存関係があるため、この配列の順序を変えてはいけない。
const PHASE1_MASTERS = [
  require('./loaders/customers'),
  require('./loaders/products'),
  require('./loaders/materials'),
  require('./loaders/tanks'),
  require('./loaders/productRecipes'),
];

const PHASE3_TRANSACTIONS = [
  require('./loaders/orders'),
  require('./loaders/distillations'),
  require('./loaders/rawSakeLedger'),
  require('./loaders/distillationDetails'),
  require('./loaders/distillationResidues'),
  require('./loaders/productStockLedger'),
  require('./loaders/materialStockLedger'),
  require('./loaders/tankLedger'),
  require('./loaders/consignmentReports'),
  require('./loaders/sampleShipments'),
  require('./loaders/salesTargets'),
];

// --reset で削除する対象。マスタは対象外（8-5）。FK依存の逆順に並べる。
const RESETTABLE_TABLES = [
  'material_stock_ledger',
  'tank_ledger',
  'product_stock_ledger',
  'consignment_reports',
  'sample_shipments',
  'sales_targets',
  'distillation_residues',
  'distillation_details',
  'raw_sake_ledger',
  'distillations',
  'orders',
];

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const unknown = [...flags].filter(
    (f) => !['--dry-run', '--strict', '--allow-partial', '--reset'].includes(f)
  );
  if (unknown.length) {
    console.error(`不明なオプション: ${unknown.join(', ')}`);
    process.exit(1);
  }
  return {
    dryRun: flags.has('--dry-run'),
    // --allow-partial が指定されない限り strict（既定）
    strict: !flags.has('--allow-partial'),
    reset: flags.has('--reset'),
  };
}

function loadAliases() {
  if (!fs.existsSync(ALIASES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
  } catch (e) {
    console.error(`aliases.json の読み込みに失敗しました: ${e.message}`);
    process.exit(1);
  }
}

function buildContext(db, options) {
  return {
    db,
    options,
    dataDir: DATA_DIR,
    aliases: loadAliases(),
    normalize: normalizeName,
    report: new MigrationReport(REPORT_DIR),
    lookups: {
      customerIdByName: new Map(),
      productIdByName: new Map(),
      materialIdByName: new Map(),
      tankIdByName: new Map(),
      tankIdByCode: new Map(),
      orderIdByOrderNo: new Map(),
      distillationIdByCode: new Map(),
      rawSakeLedgerIdByLotCode: new Map(),
      productLedgerIdByHistoryCode: new Map(),
    },
  };
}

function resetTables(db) {
  console.log('[reset] トランザクション・台帳系テーブルを削除します（マスタは保持）');
  for (const table of RESETTABLE_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function verify(db) {
  console.log('\n=== 移行後の検証（8-7）===');

  const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
  if (fkIssues.length === 0) {
    console.log('  ✓ PRAGMA foreign_key_check: 0件');
  } else {
    console.log(`  ✗ PRAGMA foreign_key_check: ${fkIssues.length}件の不整合`);
    for (const issue of fkIssues.slice(0, 10)) {
      console.log(`     ${issue.table} rowid=${issue.rowid} -> ${issue.parent}`);
    }
  }

  const productStock = db.prepare('SELECT COUNT(*) AS c FROM v_product_stock').get();
  const materialStock = db.prepare('SELECT COUNT(*) AS c FROM v_material_stock').get();
  const tankMonitor = db.prepare('SELECT COUNT(*) AS c FROM v_tank_monitor').get();
  console.log(
    `  モニタービュー行数: 商品在庫=${productStock.c} / 資材在庫=${materialStock.c} / タンク=${tankMonitor.c}`
  );
  console.log('  ※ 旧シートの最終値との突合は、CSVを揃えた上で手動スポットチェックしてください');
}

function main() {
  const options = parseArgs(process.argv);
  console.log(
    `移行を開始します（dry-run=${options.dryRun} / strict=${options.strict} / reset=${options.reset}）`
  );

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`CSVディレクトリが見つかりません: ${DATA_DIR}`);
    console.error('scripts/data/csv/ に各シートのCSVエクスポートを配置してください。');
    process.exit(1);
  }

  migrate(); // スキーマ未適用のDBでも動くようにしておく
  const db = getConnection();
  const ctx = buildContext(db, options);

  let committed = false;
  try {
    db.exec('BEGIN');

    if (options.reset) resetTables(db);

    console.log('\n--- フェーズ1: マスタ系 ---');
    for (const loader of PHASE1_MASTERS) loader.load(ctx);

    // フェーズ2: 名寄せ事前チェック。
    // 実際の不一致検出は各ローダーがresolveId経由でreportに記録するため、
    // ここではフェーズ1完了時点の状態を見て、strictなら投入前に打ち切る。
    if (ctx.report.hasUnmatched() && options.strict) {
      throw new Error(
        `名寄せ不一致が${ctx.report.unmatchedNames.length}件あります。` +
          'unmatched-names.csv を確認し、aliases.json で補正するか --allow-partial を指定してください。'
      );
    }

    console.log('\n--- フェーズ3: トランザクション・台帳系 ---');
    for (const loader of PHASE3_TRANSACTIONS) loader.load(ctx);

    if (ctx.report.hasUnmatched() && options.strict) {
      throw new Error(
        `名寄せ不一致が${ctx.report.unmatchedNames.length}件あります。` +
          'unmatched-names.csv を確認し、aliases.json で補正するか --allow-partial を指定してください。'
      );
    }

    if (options.dryRun) {
      db.exec('ROLLBACK');
      console.log('\n[dry-run] 変更をロールバックしました（DBには何も投入されていません）');
    } else {
      db.exec('COMMIT');
      committed = true;
      console.log('\n[commit] 移行を確定しました');
    }
  } catch (e) {
    db.exec('ROLLBACK');
    ctx.report.write();
    ctx.report.printSummary();
    console.error(`\n移行を中止しました: ${e.message}`);
    console.error(`レポート: ${REPORT_DIR}`);
    process.exit(1);
  }

  ctx.report.write();
  ctx.report.printSummary();
  if (committed) verify(db);
  console.log(`\nレポート出力先: ${REPORT_DIR}`);
}

if (require.main === module) {
  main();
}
