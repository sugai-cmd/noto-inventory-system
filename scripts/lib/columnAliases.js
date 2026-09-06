// シートの列名の揺れを吸収する。
//
// ローダーは row['資材名'] のように正式名で列を引いている。
// 実際のシートは同じ意味の列を別の名前で持っていることがあり
// （資材マスタは「資材名」、資材在庫変動履歴は「資材名称」）、
// そのままだと undefined になって値が黙って落ちる。
//
// マスタ系の別名は、画面のCSV取り込みが持っている表をそのまま使う。
// 画面では読めるのに移行では読めない、という食い違いを作らないため。

const { TEMPLATES, normalizeHeader } = require('../../src/services/masterImportService');

// シート名 → 画面の取り込みテンプレート
const TEMPLATE_BY_SHEET = {
  得意先マスタ: 'customers',
  商品マスタ: 'products',
  資材マスタ: 'materials',
  タンクマスタ: 'tanks',
  製品レシピマスタ: 'productRecipes',
  酒蔵マスタ: 'breweries',
};

// 台帳系シートの別名（画面の取り込み対象ではないのでここに書く）。
// 正式名（ローダーが書いている名前）→ シート側で使われうる名前。
const EXTRA = {
  受注リスト: {
    受注番号: ['注文番号'],
    得意先名: ['得意先', '顧客名'],
    商品名: ['商品名称', '商品'],
    本数: ['数量'],
    '掛け率': ['掛率'],
    '合計(税込)': ['合計', '合計金額'],
    '納品日（発送日、配達日）': ['納品日', '発送日'],
  },
  商品在庫変動履歴: {
    商品: ['商品名称', '商品名'],
    '受入元/払出先': ['受入元／払出先', '受入元・払出先'],
  },
  資材在庫変動履歴: {
    資材名称: ['資材名'],
    '受入元/払出先': ['受入元／払出先', '受入元・払出先'],
  },
  浄酎容器変動履歴: {
    '数量(L)': ['数量', '受払量'],
    瓶詰め商品: ['商品', '商品名称'],
  },
  蒸留記録: {
    蒸留日: ['日付', '投入開始日'],
    '投入量合計': ['投入量'],
  },
  蒸留明細記録: {
    '投入数量(L)': ['投入量', '投入数量'],
    元容器ID: ['元容器', '投入元タンク'],
  },
  原料受払記録: {
    受払量: ['数量', '数量(L)'],
    原酒受払ID: ['受払ID'],
  },
  残渣回収記録: {
    回収量: ['残渣回収量', '数量'],
  },
  '委託販売実績報告': {
    得意先名: ['得意先'],
    商品名: ['商品名称', '商品'],
    本数: ['数量'],
  },
  'サンプル、販促資料送付': {
    得意先名: ['得意先'],
    商品名: ['商品名称', '商品'],
    本数: ['数量'],
  },
  '原酒マスタ': {
    銘柄: ['原酒銘柄', '原酒名'],
    酒蔵: ['酒蔵名'],
  },
  '顧客リスト': {
    得意先: ['得意先名', '顧客名'],
  },
};

/** シート名に対する「正式名 → 別名の配列」を返す */
function aliasesForSheet(sheetName) {
  const result = { ...(EXTRA[sheetName] ?? {}) };

  const kind = TEMPLATE_BY_SHEET[sheetName];
  if (kind && TEMPLATES[kind]) {
    for (const [canonical, def] of Object.entries(TEMPLATES[kind].columns)) {
      if (!def.aliases?.length) continue;
      result[canonical] = [...(result[canonical] ?? []), ...def.aliases];
    }
  }

  // 逆向きも張る。「資材名 ⇔ 資材名称」はどちらの名前で聞かれても引けるほうが安全で、
  // 表を書くときに向きを気にしなくてよくなる。
  for (const [canonical, alts] of Object.entries({ ...result })) {
    for (const alt of alts) {
      result[alt] = [...new Set([...(result[alt] ?? []), canonical])];
    }
  }
  return result;
}

/**
 * CSVの1行を、別名でも引けるように包む。
 * ローダー側は row['資材名'] のままでよく、実際の見出しが「資材名称」でも読める。
 * 見出しの表記ゆれ（全角半角・空白・BOM）も normalizeHeader で吸収する。
 */
function aliasRow(row, aliases) {
  // 正規化した見出し → 実際の見出し
  const index = new Map();
  for (const key of Object.keys(row)) index.set(normalizeHeader(key), key);

  const resolve = (name) => {
    const direct = index.get(normalizeHeader(name));
    if (direct !== undefined) return direct;
    for (const alt of aliases[name] ?? []) {
      const hit = index.get(normalizeHeader(alt));
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  return new Proxy(row, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      if (prop in target) return target[prop];
      const key = resolve(prop);
      return key === undefined ? undefined : target[key];
    },
    has(target, prop) {
      if (typeof prop !== 'string') return Reflect.has(target, prop);
      return prop in target || resolve(prop) !== undefined;
    },
  });
}

module.exports = { aliasesForSheet, aliasRow };
