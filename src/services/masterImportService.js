// マスタのCSV一括登録（GAS版 README 3章「CSV一括登録」）。
// 得意先・資材・酒蔵を、テンプレートに沿ったCSVの貼り付けで一括登録する。
//
// 既存と同じ名前の行は「更新」として扱う（名前がUNIQUEなので、
// 取り込みのたびにエラーで止まるより、差分を反映できたほうが実務に合う）。

const { parse } = require('csv-parse/sync');
const { getConnection } = require('../db/connection');
const customerModel = require('../models/customerModel');
const breweryModel = require('../models/breweryModel');
const materialService = require('./materialService');
const productService = require('./productService');
const { normalizeName } = require('../utils/normalizeName');
const { BusinessRuleError } = require('../utils/errors');
const { parsePaymentTermMonths, ACCEPTED_WORDS } = require('../utils/paymentTerm');
const { parseLeadTimeDays } = require('../utils/leadTime');

// 製品レシピマスタ「ステータス」列に入る値（＝工程）
const RECIPE_PROCESSES = ['瓶詰', '箱詰'];

// CSVの見出し（日本語）→ APIの項目名。
//
// aliases には**現行スプレッドシートの実際の列名**を入れてある。
// シートからエクスポートしたCSVを、見出しを書き換えずにそのまま貼り付けられるようにするため
// （こちらの表記に直させると、直し忘れや列のずれで取り込みが失敗する）。
// 列の並び順は問わない。見出し名で対応づける。
const TEMPLATES = {
  customers: {
    label: '得意先',
    // 列と並びは得意先マスタシートのとおり
    columns: {
      顧客ID: { key: 'code', aliases: ['得意先コード', '得意先ID'] },
      得意先名: { key: 'name', required: true },
      区分: { key: 'segment' },
      業態: { key: 'businessType' },
      掛率: { key: 'markupRate', type: 'number', aliases: ['掛け率'] },
      住所: { key: 'address' },
      支払いサイト月数: { key: 'paymentTermMonths', type: 'paymentTerm' },
      支払いサイト日付: { key: 'paymentTermDay', aliases: ['支払いサイト日'] },
      請求日送付期日: { key: 'invoiceDueNote', aliases: ['請求書送付期日'] },
      備考: { key: 'note' },
      担当者: { key: 'salesRep' },
      サブ担当者: { key: 'salesSubRep' },
      流通経路: { key: 'salesChannel' },
      最終訪問日: { key: 'lastVisitedOn' },
      取引開始月: { key: 'onboardedMonth' },
    },
  },

  materials: {
    label: '資材',
    // 列と並びは資材マスタシートのとおり。
    // 「単価×ロット数(円)」はシート上の計算列なので取り込まない。
    columns: {
      資材ID: { key: 'code' },
      資材名: { key: 'name', required: true, aliases: ['資材名称'] },
      資材種別: { key: 'category' },
      単位: { key: 'unit' },
      '単価(円)': { key: 'unitPrice', type: 'number', aliases: ['単価', '基準単価'] },
      ロット数: { key: 'lotSize', type: 'int' },
      適正在庫数: { key: 'properStockQty', type: 'int', aliases: ['適正在庫'] },
      初期在庫数: { key: 'initialStock', type: 'number', aliases: ['初期在庫'] },
      発注先会社名: { key: 'supplierName', aliases: ['発注先', '仕入先'] },
      発注先住所: { key: 'supplierAddress' },
      発注先担当者名: { key: 'supplierContact', aliases: ['発注先担当者'] },
      備考: { key: 'note' },
      リードタイム: { key: 'leadTimeDays', type: 'leadTime', aliases: ['リードタイム(日)', 'リードタイム日数'] },
      // 「単価×ロット数(円)」はシート上の計算列。取り込まず、無視した列として報告する
    },
  },

  breweries: {
    label: '酒蔵',
    columns: {
      酒蔵ID: { key: 'code' },
      酒蔵名: { key: 'name', required: true },
      住所: { key: 'address' },
      電話番号: { key: 'phone' },
      担当者名: { key: 'contact', aliases: ['担当者'] },
      取引開始日: { key: 'startedOn' },
    },
  },

  products: {
    label: '商品',
    // 列と並びは商品マスタシートのとおり
    columns: {
      商品名称: { key: 'name', required: true, aliases: ['商品名'] },
      '容量(ml)': { key: 'volumeMl', type: 'int', aliases: ['容量'] },
      規定度数: { key: 'abv', type: 'number', aliases: ['アルコール度数', '度数'] },
      容器タイプ: { key: 'containerType' },
      単位: { key: 'unit' },
      上代: { key: 'listPrice', type: 'number' },
      JAN: { key: 'janCode', aliases: ['JANコード'] },
      目標エキス分基準: { key: 'targetExtractSpec' },
      備考: { key: 'note' },
      商品カテゴリ: { key: 'category' },
      商品ID: { key: 'code' },
      初期商品在庫数: { key: 'initialProductStock', type: 'int' },
      初期仕掛品在庫数: { key: 'initialWipStock', type: 'int' },
      課税額: { key: 'taxPerUnit', type: 'number' },
    },
  },

  productRecipes: {
    label: '製品レシピ',
    // 製品レシピマスタシートのとおり。商品と資材は名前で引く。
    // 「ステータス」列に瓶詰／箱詰が入っているので、それを工程として扱う。
    byName: false, // 名前1つでは特定できない（商品×資材×工程の組み合わせ）
    columns: {
      レシピID: { key: 'recipeCode' },
      商品名称: { key: 'productName', required: true, aliases: ['商品名'] },
      資材名: { key: 'materialName', required: true, aliases: ['資材名称'] },
      必要数量: { key: 'qtyRequired', type: 'number', required: true, aliases: ['必要数'] },
      ステータス: { key: 'process', required: true, aliases: ['工程'] },
    },
  },
};

/** 見出しの表記ゆれを吸収する（全角半角・空白・BOM・改行の残り） */
function normalizeHeader(header) {
  return String(header ?? '')
    .normalize('NFKC')
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u3000]/g, '')
    .trim();
}

/** 正式名と別名の両方から「見出し → 定義」を引ける表を作る */
function headerIndex(template) {
  const index = new Map();
  for (const [canonical, def] of Object.entries(template.columns)) {
    for (const name of [canonical, ...(def.aliases ?? [])]) {
      index.set(normalizeHeader(name), { ...def, canonical });
    }
  }
  return index;
}

// list / create / update だけ使う。資材はサービス側に業務ルール（ロット数等）が
// あるのでモデルではなくサービスを通す。
const MODELS = {
  customers: customerModel,
  materials: {
    list: () => getConnection().prepare('SELECT * FROM materials ORDER BY name').all(),
    create: (input) => materialService.createMaterial(input),
    update: (id, input) => materialService.updateMaterial(id, input),
  },
  breweries: breweryModel,
  products: {
    list: () => getConnection().prepare('SELECT * FROM products ORDER BY name').all(),
    create: (input) => productService.registerProductWithRecipe(input),
    update: (id, input) => productService.updateProduct(id, input),
  },
};

/** 画面に出す取り込みテンプレート（見出し行） */
function templateFor(kind) {
  const template = TEMPLATES[kind];
  if (!template) throw new BusinessRuleError(`対応していない種別です: ${kind}`);
  return {
    label: template.label,
    header: Object.keys(template.columns).join(','),
    required: Object.entries(template.columns)
      .filter(([, v]) => v.required)
      .map(([k]) => k),
    // 現行シートの列名でもそのまま取り込めることを画面に出すため
    aliases: Object.entries(template.columns)
      .filter(([, v]) => v.aliases?.length)
      .map(([canonical, v]) => ({ canonical, aliases: v.aliases })),
  };
}

/**
 * 区切り文字を推測する。
 * スプレッドシートから直接コピーするとタブ区切りになるので、
 * 「CSVなのに読めない」で詰まらないよう受け付ける。
 */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/** csv-parseの英語メッセージを、原因の見当がつく日本語に置き換える */
function describeParseError(err) {
  // 見出しと本文で列数が違う。テンプレートの見出しにシートの行を貼ったときに起きる
  const lengths = /columns length is (\d+), got (\d+) on line (\d+)/.exec(err.message ?? '');
  if (lengths) {
    const [, expected, got, line] = lengths;
    return (
      `見出し行は${expected}列ですが、${line}行目は${got}列あります。` +
      '見出し行とデータ行が別々のところから来ていないか確認してください' +
      '（こちらのテンプレートの見出しに、スプレッドシートの行をそのまま貼ると起きます）。' +
      'スプレッドシートの見出し行ごと貼り付ければ、そのまま取り込めます。'
    );
  }

  if (/Quote|quote/.test(err.message ?? '')) {
    return `引用符（"）の対応が取れていません: ${err.message}`;
  }
  return `CSVを読み取れませんでした: ${err.message}`;
}

/**
 * CSVを取り込む。dryRun なら検証だけして書き込まない。
 *
 * 見出しは正式名でも現行シートの列名でもよく、並び順も問わない。
 * 対応していない列は取り込まずに ignoredColumns で報告する
 * （シートには使わない列も混ざっているので、そこで止めない）。
 */
function importCsv(kind, csvText, { dryRun = false } = {}) {
  const template = TEMPLATES[kind];
  if (!template) throw new BusinessRuleError(`対応していない種別です: ${kind}`);
  const model = MODELS[kind];

  let records;
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      delimiter: detectDelimiter(csvText),
    });
  } catch (err) {
    throw new BusinessRuleError(describeParseError(err));
  }
  if (!records.length) throw new BusinessRuleError('データ行がありません');

  const index = headerIndex(template);
  const headers = Object.keys(records[0]);
  const mapped = new Map();       // 実際の見出し → 定義
  const ignoredColumns = [];
  for (const header of headers) {
    const def = index.get(normalizeHeader(header));
    if (def) mapped.set(header, def);
    else if (header.trim()) ignoredColumns.push(header);
  }

  const missingRequired = Object.entries(template.columns)
    .filter(([, def]) => def.required)
    .filter(([canonical]) => ![...mapped.values()].some((d) => d.canonical === canonical))
    .map(([canonical]) => canonical);

  if (missingRequired.length) {
    throw new BusinessRuleError(
      `必須の列がありません: ${missingRequired.join('・')}。` +
        `見出し行を含めて貼り付けているか確認してください（読み取れた見出し: ${headers.join('・') || 'なし'}）`
    );
  }

  const db = getConnection();

  // 製品レシピは「商品×資材×工程」の組み合わせで一意なので、名前1つでは引けない。
  // 専用の取り込みに分ける。
  if (kind === 'productRecipes') {
    return importRecipes(db, records, mapped, ignoredColumns, { dryRun });
  }

  const existing = new Map(model.list().map((r) => [normalizeName(r.name), r]));

  const errors = [];
  const parsed = [];

  records.forEach((record, i) => {
    const line = i + 2; // 見出し行のぶん
    const input = {};
    for (const [header, def] of mapped) {
      const raw = record[header];
      if (raw == null || raw === '') {
        if (def.required) errors.push({ line, message: `${def.canonical}は必須です` });
        continue;
      }
      if (def.type === 'leadTime') {
        const { days, ok } = parseLeadTimeDays(raw);
        if (!ok) {
          errors.push({
            line,
            message: `${def.canonical}を読み取れませんでした: "${raw}"（1日／3週間／1.5ヶ月 のように入力してください）`,
          });
          continue;
        }
        if (days != null) input[def.key] = days;
        continue;
      }
      if (def.type === 'paymentTerm') {
        const { months, ok } = parsePaymentTermMonths(raw);
        if (!ok) {
          errors.push({
            line,
            message:
              `${def.canonical}を読み取れませんでした: "${raw}"` +
              `（${ACCEPTED_WORDS.join('・')} か、月数の数字で入力してください）`,
          });
          continue;
        }
        if (months != null) input[def.key] = months;
        continue;
      }
      if (def.type === 'number' || def.type === 'int') {
        const value = Number(String(raw).replace(/[,，\s]/g, ''));
        if (!Number.isFinite(value)) {
          errors.push({ line, message: `${def.canonical}は数値で入力してください: "${raw}"` });
          continue;
        }
        input[def.key] = def.type === 'int' ? Math.trunc(value) : value;
      } else {
        input[def.key] = String(raw).trim();
      }
    }
    const failedThisLine = errors.some((e) => e.line === line);
    if (input.name && !failedThisLine) {
      parsed.push({ line, input, existing: existing.get(normalizeName(input.name)) ?? null });
    }
  });

  // 不備のある行は飛ばして、残りは取り込む。
  // 実データには必ず例外的な書き方の行が混ざるので、1行のために全部止めない。
  const summarize = (rows) => ({
    created: rows.filter((r) => !r.existing).length,
    updated: rows.filter((r) => r.existing).length,
    skipped: errors.length,
    errors,
    ignoredColumns,
    rows: rows.map((r) => ({
      line: r.line,
      name: r.input.name,
      action: r.existing ? '更新' : '新規',
    })),
  });

  if (dryRun) return summarize(parsed);

  const run = db.transaction(() => {
    for (const p of parsed) {
      if (p.existing) model.update(p.existing.id, p.input);
      else model.create(p.input);
    }
    return summarize(parsed);
  });

  return run();
}

/**
 * 製品レシピの取り込み。
 * 商品名・資材名でマスタを引き、（商品×資材×工程）が既にあれば数量を更新する。
 * マスタに無い名前はエラーにする。ここで勝手に商品や資材を作ると、
 * 表記ゆれの分だけマスタが増えて収拾がつかなくなるため。
 */
function importRecipes(db, records, mapped, ignoredColumns, { dryRun }) {
  const products = new Map(
    db.prepare('SELECT id, name FROM products').all().map((r) => [normalizeName(r.name), r])
  );
  const materials = new Map(
    db.prepare('SELECT id, name FROM materials').all().map((r) => [normalizeName(r.name), r])
  );

  const errors = [];
  const parsed = [];

  records.forEach((record, i) => {
    const line = i + 2;
    const row = {};
    for (const [header, def] of mapped) {
      const raw = record[header];
      if (raw == null || String(raw).trim() === '') {
        if (def.required) errors.push({ line, message: `${def.canonical}は必須です` });
        continue;
      }
      row[def.key] = def.type === 'number' ? Number(raw) : String(raw).trim();
    }
    if (row.productName == null || row.materialName == null || row.process == null) return;

    const product = products.get(normalizeName(row.productName));
    const material = materials.get(normalizeName(row.materialName));
    if (!product) {
      errors.push({ line, message: `商品マスタに「${row.productName}」がありません。先に商品を登録してください` });
      return;
    }
    if (!material) {
      errors.push({ line, message: `資材マスタに「${row.materialName}」がありません。先に資材を登録してください` });
      return;
    }
    if (!RECIPE_PROCESSES.includes(row.process)) {
      errors.push({
        line,
        message: `ステータスは ${RECIPE_PROCESSES.join('／')} のどちらかです: "${row.process}"`,
      });
      return;
    }
    if (!Number.isFinite(row.qtyRequired) || row.qtyRequired <= 0) {
      errors.push({ line, message: `必要数量は0より大きい数値で入力してください: "${row.qtyRequired}"` });
      return;
    }

    const current = db
      .prepare(
        'SELECT id FROM product_recipes WHERE product_id = ? AND material_id = ? AND process = ?'
      )
      .get(product.id, material.id, row.process);

    parsed.push({
      line,
      recipeCode: row.recipeCode ?? null,
      productId: product.id,
      materialId: material.id,
      qtyRequired: row.qtyRequired,
      process: row.process,
      existingId: current?.id ?? null,
      label: `${product.name} / ${material.name}（${row.process}）`,
    });
  });

  const summarize = () => ({
    created: parsed.filter((r) => !r.existingId).length,
    updated: parsed.filter((r) => r.existingId).length,
    skipped: errors.length,
    errors,
    ignoredColumns,
    rows: parsed.map((r) => ({
      line: r.line,
      name: r.label,
      action: r.existingId ? '更新' : '新規',
    })),
  });

  if (dryRun) return summarize();

  const run = db.transaction(() => {
    for (const r of parsed) {
      if (r.existingId) {
        db.prepare(
          'UPDATE product_recipes SET qty_required = ?, recipe_code = COALESCE(?, recipe_code) WHERE id = ?'
        ).run(r.qtyRequired, r.recipeCode, r.existingId);
      } else {
        db.prepare(
          `INSERT INTO product_recipes (recipe_code, product_id, material_id, qty_required, process)
           VALUES (?, ?, ?, ?, ?)`
        ).run(r.recipeCode, r.productId, r.materialId, r.qtyRequired, r.process);
      }
    }
    return summarize();
  });

  return run();
}

module.exports = { TEMPLATES, templateFor, importCsv, RECIPE_PROCESSES };
