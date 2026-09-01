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
const { normalizeName } = require('../utils/normalizeName');
const { BusinessRuleError } = require('../utils/errors');

// CSVの見出し（日本語）→ APIの項目名
const TEMPLATES = {
  customers: {
    label: '得意先',
    columns: {
      得意先コード: { key: 'code' },
      得意先名: { key: 'name', required: true },
      区分: { key: 'segment' },
      業態: { key: 'businessType' },
      掛率: { key: 'markupRate', type: 'number' },
      住所: { key: 'address' },
      支払いサイト月数: { key: 'paymentTermMonths', type: 'int' },
      支払いサイト日: { key: 'paymentTermDay' },
      請求書送付期日: { key: 'invoiceDueNote' },
      担当者: { key: 'salesRep' },
      サブ担当者: { key: 'salesSubRep' },
      流通経路: { key: 'salesChannel' },
      取引開始月: { key: 'onboardedMonth' },
      備考: { key: 'note' },
    },
  },
  materials: {
    label: '資材',
    columns: {
      資材ID: { key: 'code' },
      資材名: { key: 'name', required: true },
      単位: { key: 'unit' },
      単価: { key: 'unitPrice', type: 'number' },
      ロット数: { key: 'lotSize', type: 'int' },
      適正在庫数: { key: 'properStockQty', type: 'int' },
      初期在庫数: { key: 'initialStock', type: 'number' },
      発注先: { key: 'supplierName' },
      リードタイム: { key: 'leadTimeDays', type: 'int' },
    },
  },
  breweries: {
    label: '酒蔵',
    columns: {
      酒蔵名: { key: 'name', required: true },
      住所: { key: 'address' },
      電話番号: { key: 'phone' },
      担当者: { key: 'contact' },
      取引開始日: { key: 'startedOn' },
    },
  },
};

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
  };
}

/**
 * CSVを取り込む。dryRun なら検証だけして書き込まない。
 * @returns {{created:number, updated:number, errors:{line:number,message:string}[], rows:object[]}}
 */
function importCsv(kind, csvText, { dryRun = false } = {}) {
  const template = TEMPLATES[kind];
  if (!template) throw new BusinessRuleError(`対応していない種別です: ${kind}`);
  const model = MODELS[kind];

  let records;
  try {
    records = parse(csvText, { columns: true, skip_empty_lines: true, bom: true, trim: true });
  } catch (err) {
    throw new BusinessRuleError(`CSVを読み取れませんでした: ${err.message}`);
  }
  if (!records.length) throw new BusinessRuleError('データ行がありません');

  const unknown = Object.keys(records[0]).filter((h) => !(h in template.columns));
  if (unknown.length) {
    throw new BusinessRuleError(
      `見出しが違います（不明な列: ${unknown.join('・')}）。テンプレートに合わせてください`
    );
  }

  const db = getConnection();
  const existing = new Map(
    model.list().map((r) => [normalizeName(r.name), r])
  );

  const errors = [];
  const parsed = [];

  records.forEach((record, index) => {
    const line = index + 2; // 見出し行のぶん
    const input = {};
    for (const [header, def] of Object.entries(template.columns)) {
      const raw = record[header];
      if (raw == null || raw === '') {
        if (def.required) errors.push({ line, message: `${header}は必須です` });
        continue;
      }
      if (def.type === 'number' || def.type === 'int') {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          errors.push({ line, message: `${header}は数値で入力してください: "${raw}"` });
          continue;
        }
        input[def.key] = def.type === 'int' ? Math.trunc(value) : value;
      } else {
        input[def.key] = String(raw);
      }
    }
    if (input.name) {
      parsed.push({ line, input, existing: existing.get(normalizeName(input.name)) ?? null });
    }
  });

  if (errors.length) return { created: 0, updated: 0, errors, rows: [] };
  if (dryRun) {
    return {
      created: parsed.filter((p) => !p.existing).length,
      updated: parsed.filter((p) => p.existing).length,
      errors: [],
      rows: parsed.map((p) => ({ line: p.line, name: p.input.name, action: p.existing ? '更新' : '新規' })),
    };
  }

  const run = db.transaction(() => {
    const rows = [];
    let created = 0;
    let updated = 0;
    for (const p of parsed) {
      if (p.existing) {
        model.update(p.existing.id, p.input);
        updated += 1;
        rows.push({ line: p.line, name: p.input.name, action: '更新' });
      } else {
        model.create(p.input);
        created += 1;
        rows.push({ line: p.line, name: p.input.name, action: '新規' });
      }
    }
    return { created, updated, errors: [], rows };
  });

  return run();
}

module.exports = { TEMPLATES, templateFor, importCsv };
