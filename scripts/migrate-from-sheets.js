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
const { readMergedAliases } = require('./lib/aliasFile');
const { suggest } = require('./lib/similarName');

// 置き場所は環境変数で差し替えられる。試験どうしが同じフォルダを取り合わないため
// （既定は本番と同じ scripts/data/csv・scripts/migration-report）。
const DATA_DIR = process.env.MIGRATION_CSV_DIR
  ? path.resolve(process.env.MIGRATION_CSV_DIR)
  : path.resolve(__dirname, 'data', 'csv');
const REPORT_DIR = process.env.MIGRATION_REPORT_DIR
  ? path.resolve(process.env.MIGRATION_REPORT_DIR)
  : path.resolve(__dirname, 'migration-report');
const ALIASES_PATH = process.env.MIGRATION_ALIASES
  ? path.resolve(process.env.MIGRATION_ALIASES)
  : path.resolve(__dirname, 'data', 'aliases.json');

// 8.0のフェーズ順序。依存関係があるため、この配列の順序を変えてはいけない。
const PHASE1_MASTERS = [
  require('./loaders/customers'),
  require('./loaders/customerContacts'), // 顧客リストの連絡先を得意先へ足す（customersの後）
  require('./loaders/products'),
  require('./loaders/materials'),
  require('./loaders/tanks'),
  require('./loaders/knownTanks'),       // シートに行が無い容器を足す（tanksの後）
  require('./loaders/productRecipes'),
  require('./loaders/breweries'),
  require('./loaders/rawSakeBrands'),    // 酒蔵の後（酒蔵名で紐付けるため）
  require('./loaders/cartonRules'),      // 商品の後（商品名で紐付けるため）
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
  // 台帳の行を指しているので、台帳を消すときに一緒に消さないと参照が宙に浮く
  'wip_lot_allocations',
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

/**
 * 補正表を組み立てる。
 *
 * 一度決めた読み替えは同梱の known-aliases.json に置いてあり、毎回書き直す
 * 必要はない。aliases.json はその上に重ねる**足し算**として扱う
 * （同じ列の同じ左辺があれば手元のファイルが勝つ）。
 */
function loadAliases() {
  try {
    const { aliases, userAliases, warnings } = readMergedAliases(ALIASES_PATH);
    for (const w of warnings) console.warn(`[aliases.json] ${w}`);
    return { aliases, userAliases };
  } catch (e) {
    console.error(`aliases.json を読み込めませんでした。\n${e.message}`);
    process.exit(1);
  }
}

/**
 * タンクの引き先に、CSVに無いDBの行を足す。
 *
 * tankIdByName / tankIdByCode は tanks.csv を読んだ行だけで組み立てている。
 * 画面から直接登録したタンクはDBにあってもシートに無いので、台帳が
 * その名前で参照していても引けず、「タンクが空の行」として入ってしまう。
 *
 * しかも checkAliases が見る namePools はDBから作っているため、
 * 「aliases.json は効くはず」と言われたのに実際は当たらない、という
 * 食い違いが起きる。ここで埋めて、両方をDBの実態に揃える。
 *
 * code も name も UNIQUE なので、どちらで引いても一意に決まる。
 * CSVで読んだ行が既に入っているキーは上書きしない（同じidになるはずだが、
 * シート側を正とする建て付けを崩さないため）。
 */
function fillTankLookupsFromDb(ctx, db) {
  let rows;
  try {
    rows = db.prepare('SELECT id, code, name FROM tanks').all();
  } catch {
    return; // tanks が無いDB（テスト用の最小構成など）では何もしない
  }

  for (const tank of rows) {
    const byName = ctx.normalize(tank.name);
    if (byName && !ctx.lookups.tankIdByName.has(byName)) {
      ctx.lookups.tankIdByName.set(byName, tank.id);
    }
    const byCode = ctx.normalize(tank.code);
    if (byCode && !ctx.lookups.tankIdByCode.has(byCode)) {
      ctx.lookups.tankIdByCode.set(byCode, tank.id);
    }
  }
}

/**
 * 名寄せで引けなかった名前に、似ている候補を出すための「引き先の一覧」。
 * ロールバックしても残るよう、投入直後に配列として控えておく。
 */
function captureNamePools(ctx, db) {
  const names = (sql) => {
    try {
      return db.prepare(sql).all().map((r) => r.name).filter(Boolean);
    } catch {
      return [];
    }
  };

  const customers = names('SELECT name FROM customers');
  const products = names('SELECT name FROM products');
  const materials = names('SELECT name FROM materials');
  const tanks = [
    ...names('SELECT name FROM tanks'),
    ...names('SELECT code AS name FROM tanks'),
  ];
  const distillations = names('SELECT distillation_code AS name FROM distillations');
  const orders = names('SELECT legacy_order_no AS name FROM orders');
  const productLedger = names('SELECT history_code AS name FROM product_stock_ledger');

  // ローダーが resolveId に渡している column の名前で引けるようにする
  Object.assign(ctx.report.namePools, {
    得意先名: customers,
    得意先: customers,
    商品名: products,
    商品: products,
    商品名称: products,
    資材名: materials,
    資材名称: materials,
    本店: customers,
    受入元: tanks,
    払出先: tanks,
    元容器ID: tanks,
    '受入元(投入元タンク)': tanks,
    '払出先(受入先タンク)': tanks,
    浄酎タンク: tanks, // タンクモニターの列名。答え合わせが使う
    '払出先(蒸留ID)': distillations,
    蒸留ID: distillations,
    受注番号: orders,
    商品履歴ID: productLedger,
  });
}

/**
 * aliases.json に書いた内容が実際に効くかを、マスタを読み込んだあとで確かめる。
 *
 * 「書いたのに効かない」が繰り返し起きている。
 *   ・右辺にマスタへ登録されていない名前を書いてしまう
 *   ・外側のキーを取り違える（得意先マスタは「得意先名」、顧客リストは「得意先」）
 * どちらも黙って不一致として残るだけなので、原因が分からない。
 * ここで名指しして、候補も添える。
 */
function checkAliases(ctx) {
  const pools = ctx.report.namePools;
  const known = Object.keys(pools);
  const warn = (msg) => console.warn(`[aliases.json] ${msg}`);

  // 見るのは**手元で書いた分だけ**。組み込みの補正表（known-aliases.json）は
  // 利用者が直せないので、そこへの注意を混ぜると直しようのない警告が並ぶ。
  for (const [column, table] of Object.entries(ctx.userAliases ?? {})) {
    if (column.startsWith('_') && column !== '__ignore__') continue;

    if (column === '__ignore__') {
      for (const [ignoreColumn, values] of Object.entries(table ?? {})) {
        const pool = pools[ignoreColumn];
        if (!pool) {
          warn(`__ignore__ の「${ignoreColumn}」はどの列にも当たりません。${nearestColumns(known)}`);
          continue;
        }
        const registered = new Set(pool.map((n) => ctx.normalize(n)));
        for (const value of Array.isArray(values) ? values : []) {
          if (registered.has(ctx.normalize(value))) {
            warn(
              `__ignore__ の「${ignoreColumn}」の「${value}」はマスタに登録されているので、` +
                '飛ばす必要がありません（この行は消せます）'
            );
          }
        }
      }
      continue;
    }

    const pool = pools[column];
    if (!pool) {
      warn(`「${column}」はどの列にも当たらないので、中身は使われません。${nearestColumns(known)}`);
      continue;
    }

    const registered = new Set(pool.map((n) => ctx.normalize(n)));
    for (const [from, to] of Object.entries(table ?? {})) {
      if (typeof to !== 'string' || from === to) continue; // 別途 collectWarnings が拾う

      // 左辺がマスタに登録されているなら、読み替えずにそのまま引ける
      if (registered.has(ctx.normalize(from))) {
        warn(`「${column}」の「${from}」はマスタに登録されているので、読み替えずにそのまま使います`);
        continue;
      }

      if (registered.has(ctx.normalize(to))) continue;

      const candidates = suggest(to, pool, { limit: 3 }).map((c) => c.name);
      warn(
        `「${column}」の「${from}」→「${to}」は、右辺がマスタに登録されていないので効きません。` +
          (candidates.length ? `似ている名前: ${candidates.join(' / ')}` : '似ている名前は見つかりませんでした')
      );
    }
  }
}

/**
 * シートのどの行にも対応しなくなったマスタ行を報告する。
 *
 * マスタは消さない作りなので、シートから外した商品が受注の選択肢に残り続ける。
 * 実データでも商品がDB21件・シート19件で2件取り残されていた。
 * 「投入／更新／スキップ」はシート側から見た数字なので、これは出てこない。
 *
 * 消すかどうかは人が決める（受注が紐付いている商品は消せない）ので、止めない。
 */
const ORPHAN_TABLES = {
  customers: '得意先',
  products: '商品',
  materials: '資材',
  tanks: '容器',
  breweries: '酒蔵',
  raw_sake_brands: '原酒',
};

function reportOrphanMasters(ctx, db) {
  for (const [table, label] of Object.entries(ORPHAN_TABLES)) {
    // 触れた記録が無い＝そのCSVを置いていない。置き忘れで全行を取り残しにしない
    const touched = ctx.touched?.[table];
    if (!touched) continue;

    let rows;
    try {
      rows = db.prepare(`SELECT id, code, name FROM ${table}`).all();
    } catch {
      continue;
    }

    for (const row of rows) {
      if (touched.has(row.id)) continue;
      ctx.report.recordOrphan(
        label,
        row.code,
        row.name,
        'シートに同じIDも同じ名前もありません（シートから消したか、IDと名前の両方を変えた行）'
      );
    }
  }
}

function nearestColumns(known) {
  return known.length ? `使える列: ${known.join(' / ')}` : '';
}

function buildContext(db, options) {
  // aliases は組み込みと手元を重ねたもの。userAliases は手元で書いた分だけで、
  // 「書いたのに効かない」を伝える検算（checkAliases）はこちらだけを見る
  const { aliases, userAliases } = loadAliases();

  return {
    db,
    options,
    dataDir: DATA_DIR,
    aliases,
    userAliases,
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
      breweryIdByName: new Map(),
      rawSakeBrandIdByName: new Map(),
      rawSakeBrandIdByCode: new Map(),
      // 同じ銘柄名の行が2つ以上あって、名前では決められないもの。
      // 黙ってどちらかを選ぶと度数の違うロットを取り違えるので、引かせない
      rawSakeBrandAmbiguousNames: new Set(),
    },
    // ローダーが1回の実行の中で持ち回る数え上げ（受注の明細行番号、伝票番号の採番など）
    counters: {},
  };
}

/**
 * 台帳に前回の投入分が残ったまま流そうとしていたら、先に知らせる。
 *
 * --reset を付けないと台帳は消えないので、受注番号や履歴IDが前回の行と
 * ぶつかって UNIQUE 違反になる。**シートにもデータにも問題が無いのに**
 * 「受注8件が落ちた」「原酒受払27件が落ちた」と出るので、
 * 表記ゆれの調査に何往復も費やすことになる（実際にそうなった）。
 */
function warnIfLedgersNotEmpty(db) {
  const filled = [];
  for (const table of RESETTABLE_TABLES) {
    try {
      const { c } = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
      if (c > 0) filled.push(`${table}(${c}件)`);
    } catch {
      // テーブルがまだ無いDBもある
    }
  }
  if (!filled.length) return;

  console.warn('\n[注意] 台帳に既にデータが入っています。');
  console.warn(`  ${filled.join(' / ')}`);
  console.warn('  このまま流すと前回投入した行と伝票番号がぶつかり、');
  console.warn('  シートに問題が無くても「UNIQUE constraint failed」が出ます。');
  console.warn('  流し直すときは --reset を付けてください（台帳だけ消し、マスタは残します）。');
  console.warn('  確認だけなら: node scripts/migrate-from-sheets.js --dry-run --reset\n');
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
    else warnIfLedgersNotEmpty(db);

    console.log('\n--- フェーズ1: マスタ系 ---');
    for (const loader of PHASE1_MASTERS) loader.load(ctx);
    // 画面から登録したタンクなど、シートに無いDBの行も引けるようにする
    fillTankLookupsFromDb(ctx, db);
    // 中止してロールバックしても候補を出せるよう、この時点で控える
    captureNamePools(ctx, db);
    // マスタが揃ったので、aliases.json が実際に効くかをここで確かめる
    checkAliases(ctx);
    // シートのどの行にも対応しなくなったマスタ行を拾う（止めない、報告だけ）
    reportOrphanMasters(ctx, db);

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

    // 蒸留記録の「使用原酒明細」はシートでは明細IDの羅列（DTL-0001 DTL-0002）。
    // 明細を入れ終わったので、一覧に出す文字列をタンク名＋投入量へ組み直す。
    require('./loaders/distillations').rebuildInputSummaries(ctx);
    captureNamePools(ctx, db);   // 台帳の伝票番号も候補に使えるようにする

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
