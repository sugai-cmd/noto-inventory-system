// 送料の自動計算（GAS版 README 3章「送料自動計算」）。
//
//   住所の都道府県 → 地帯（prefecture_zones）
//   商品 × 本数    → 段ボール（carton_rules ＝ 旧「段ボール対応表」）
//   地帯 × 段ボール → 料金（shipping_rates）
//
// 運賃表の中身（どの県がどの地帯か、いくらか）はこちらでは持たない。
// 推測で表を作ると実際の請求書に誤った金額が載るため、マスタとして登録してもらう。
// 対応表に無い組み合わせは「未設定」を返し、画面で段ボールを選んで
// 「対応表に追加」すると次回から自動で決まる（GAS版と同じ運用）。

const { getConnection } = require('../db/connection');
const { BusinessRuleError, NotFoundError } = require('../utils/errors');
const operationLogService = require('./operationLogService');

// 「石川県金沢市…」「北海道札幌市…」「〒920-3114 石川県…」いずれからも拾えるようにする。
// 都・道・府・県で終わる最長一致を先頭付近から探す。
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

/** 住所文字列から都道府県を取り出す。見つからなければ null */
function extractPrefecture(address) {
  if (!address) return null;
  const normalized = String(address).replace(/\s+/g, '');
  return PREFECTURES.find((p) => normalized.includes(p)) ?? null;
}

/**
 * 送料の見積り。決まらない要素は reasons に理由を入れて返し、画面で補ってもらう。
 *
 * @param {object} input
 * @param {string} [input.address]     - 配送先住所（都道府県を含む文字列）
 * @param {string} [input.prefecture]  - 都道府県を直接指定する場合
 * @param {string} [input.cartonSize]  - 段ボールを画面で選んだ場合
 * @param {{productId:number, quantity:number}[]} input.items
 */
/**
 * 消費税率。`csvExportService` の納品書CSVと同じ値を使う。
 *
 * この仕組みは金額を**税抜で持ち、出力するときに10%を足す**作りになっている。
 * 運賃表の金額も段ボールの単価も税抜なので、合計してから一度だけ掛ける。
 */
const TAX_RATE = 0.1;

/**
 * 送料は50円ごとに繰り上げる。
 * 811円 → 850円、795円 → 800円。**ちょうど800円は800円のまま**（繰り上げない）。
 */
function ceilTo50(amount) {
  return Math.ceil(amount / 50) * 50;
}

/**
 * サイズ区分の候補。**運賃表に登録されている区分から作る。**
 *
 * 固定の配列にしない。運賃表を直したら追従してほしいため
 * （いまは 60/80/100/120/140/160/170 の7つ）。
 */
function cartonSizeBands(db) {
  return db
    .prepare('SELECT DISTINCT carton_size FROM shipping_rates')
    .all()
    .map((r) => Number(r.carton_size))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

/**
 * 組み立てた荷物の外寸からサイズ区分を出す。ゆうパックは**3辺の合計**で決まる。
 *
 * 3辺が揃っていなければ null（呼び手が対応表の手入力に落とす）。
 * どの区分にも収まらないときは `size: null` と合計値を返し、呼び手が理由を出す。
 * **ここで手入力に落としてはいけない** — 黙って安い運賃で請求してしまう。
 */
function sizeFromDimensions(db, rule) {
  const dims = [rule.length_cm, rule.width_cm, rule.height_cm];
  if (dims.some((d) => d == null)) return null;

  const sum = dims.reduce((a, b) => a + b, 0);
  const band = cartonSizeBands(db).find((s) => sum <= s);
  return { sum, size: band != null ? String(band) : null };
}

/**
 * 送料の見積り。
 *
 *   送料 ＝ 繰り上げ50円( (運賃 × 荷物の個数 ＋ 段ボールの税抜単価 × 枚数) × 1.1 )
 *
 * **枚数と荷物の個数は別物。** 300ml 2本は1本用の箱を2枚使うが、
 * テープでくっつけて1つの荷物として送るので、在庫は2枚減るのに運賃は1回。
 * どちらも対応表の行が持っていて、注文本数 ÷ 行の本数 の倍率で伸ばす。
 *
 * 決まらない要素は reasons に理由を入れて返し、画面で補ってもらう。
 * 金額だけでなく**内訳も返す**（画面で根拠を出せないと、利用者が検算できない）。
 */
function quote(input) {
  const db = getConnection();
  const reasons = [];

  const prefecture = input.prefecture ?? extractPrefecture(input.address);
  if (!prefecture) reasons.push('住所から都道府県を判定できませんでした');

  const zoneRow = prefecture
    ? db.prepare('SELECT zone FROM prefecture_zones WHERE prefecture = ?').get(prefecture)
    : null;
  if (prefecture && !zoneRow) {
    reasons.push(`${prefecture} の地帯が未登録です（マスタ画面の「送料」タブで登録してください）`);
  }

  const items = input.items ?? [];
  const picked = input.cartonSize ?? null; // 画面で段ボールを選んだ場合
  let cartonSize = picked;
  let sizeFrom = picked ? '画面で選択' : null;
  let dimensionSum = null;
  let rule = null;
  let sheets = 1;
  let parcels = 1;

  if (items.length === 1) {
    rule = findCartonRule(db, items[0].productId, items[0].quantity);
    if (rule) {
      const multiplier = items[0].quantity / rule.quantity;
      sheets = rule.material_qty * multiplier;
      parcels = rule.parcels * multiplier;

      if (!cartonSize) {
        const byDim = sizeFromDimensions(db, rule);
        if (byDim) {
          dimensionSum = byDim.sum;
          if (byDim.size) {
            cartonSize = byDim.size;
            sizeFrom = '外寸';
          } else {
            // 手入力に落とすと、実際より小さい区分で安く請求してしまう
            reasons.push(
              `外寸の3辺合計 ${byDim.sum}cm は運賃表のどの区分にも収まりません（分けて送るか、運賃表に区分を足してください）`
            );
          }
        } else {
          cartonSize = rule.carton_size;
          sizeFrom = '対応表';
        }
      }
    } else if (!cartonSize) {
      reasons.push('この商品と本数の組み合わせが段ボール対応表にありません');
    }
  } else if (items.length > 1) {
    // 対応表は「商品×本数」の1対1なので、複数商品の組み合わせは自動で決められない。
    if (!cartonSize) {
      reasons.push('複数商品の受注は段ボールを選んでください（対応表は商品×本数の1対1のため）');
    }
  } else {
    reasons.push('商品が指定されていません');
  }

  // 段ボール代。資材が未設定でも運賃だけで出す（取り込んだ直後はほぼ全部この状態）
  let materialName = null;
  let materialUnitPrice = 0;
  if (rule?.material_id != null) {
    const material = db
      .prepare('SELECT name, unit_price FROM materials WHERE id = ?')
      .get(rule.material_id);
    if (material) {
      materialName = material.name;
      materialUnitPrice = material.unit_price ?? 0;
      if (material.unit_price == null) {
        reasons.push(`「${material.name}」に単価が入っていないので、段ボール代は0円で計算しています`);
      }
    }
  } else if (rule) {
    reasons.push('段ボール代は含んでいません（対応表に段ボール資材が未設定）');
  }

  const rateRow =
    zoneRow && cartonSize
      ? db
          .prepare('SELECT fee FROM shipping_rates WHERE zone = ? AND carton_size = ?')
          .get(zoneRow.zone, cartonSize)
      : null;
  if (zoneRow && cartonSize && !rateRow) {
    reasons.push(`地帯「${zoneRow.zone}」× 段ボール「${cartonSize}」の料金が未登録です`);
  }

  const freightPerParcel = rateRow?.fee ?? null;
  const freight = freightPerParcel != null ? freightPerParcel * parcels : null;
  const materialCost = materialUnitPrice * sheets;
  const subtotal = freight != null ? freight + materialCost : null;
  // 小数の誤差で境目がずれないよう、税込にした時点で銭まで丸めてから繰り上げる
  // （そうしないと 800.0000000001 が 850円になる）
  const taxed = subtotal != null ? Math.round(subtotal * (1 + TAX_RATE) * 100) / 100 : null;
  const fee = taxed != null ? ceilTo50(taxed) : null;

  return {
    prefecture,
    zone: zoneRow?.zone ?? null,
    cartonSize,
    sizeFrom,
    dimensionSum,
    sheets,
    parcels,
    materialName,
    materialUnitPrice,
    materialCost,
    freightPerParcel,
    freight,
    subtotal,
    taxed,
    fee,
    resolved: fee != null,
    reasons,
    // 画面の段ボール選択肢（料金表に登録済みのサイズ）
    cartonOptions: db
      .prepare('SELECT DISTINCT carton_size FROM shipping_rates ORDER BY carton_size')
      .all()
      .map((r) => r.carton_size),
  };
}

/** 出荷に使う段ボールの資材分類。個装（化粧箱・桐箱・プラケース）の「箱」とは別 */
const CARTON_CATEGORY = '外箱';

/**
 * 出荷に使える段ボールの一覧（現在庫つき）。発送画面の選択肢に出す。
 *
 * **分類が「外箱」のものだけを返す。** 化粧箱・桐箱・プラケースは分類が「箱」で、
 * 箱詰めのレシピで既に減らしている。ここに混ぜると二重に減る。
 */
function listCartonMaterials() {
  const db = getConnection();
  return db
    .prepare(
      `SELECT m.id, m.code, m.name, m.unit, s.current_stock
         FROM materials m
         JOIN v_material_stock s ON s.material_id = m.id
        WHERE m.category = @category
        ORDER BY m.name`
    )
    .all({ category: CARTON_CATEGORY });
}

/**
 * 商品×本数から対応表の行を1つ選ぶ。**発送画面とゆうパックCSVで同じものを使う。**
 *
 * 完全一致だけだと、12本用の行があっても24本の注文に当たらない。
 * **割り切れる行のうち一番大きい本数**（＝箱数が最少）を選び、箱数は quantity / rule.quantity。
 * 24本なら「12本用を2箱」。端数の詰め合わせまではやらない
 * （組み合わせの選び方に決まりが無く、推測で決めると実際の梱包とずれる）。
 *
 * ここを2か所に書くと、画面は「12本用×2箱」と言うのにCSVは「対応表にありません」と出る、
 * という食い違いが起きる（実際に一度そうなった）。
 */
function findCartonRule(db, productId, quantity) {
  const rules = db
    .prepare('SELECT * FROM carton_rules WHERE product_id = ? ORDER BY quantity DESC')
    .all(productId);
  // ORDER BY quantity DESC なので、最初に割り切れたものが一番大きい本数
  return rules.find((r) => r.quantity > 0 && quantity % r.quantity === 0) ?? null;
}

/**
 * 出荷に使う段ボールの**推奨**を出す。あくまで推奨で、実際に使うものは発送画面で選ぶ。
 *
 * 対応表は「商品×本数」の完全一致だが、それだけだと 12本用の行があっても
 * 24本の注文には当たらない（実データ111件のうち完全一致は69件）。
 * **割り切れる行のうち一番大きい本数**を使って箱数を出すと86件まで届く。
 * 24本なら「12本用×2箱」。端数の詰め合わせまではやらない（組み合わせの選び方に
 * 決まりが無く、推測で決めると実際の梱包とずれるため）。
 *
 * @returns {{suggestion: object|null, reason: string|null}}
 */
function suggestCartons({ productId, quantity, orderId = null }) {
  const db = getConnection();

  // 複数明細の受注は対象外。対応表は商品×本数の1対1で、
  // 明細ごとに箱を数えると1つの荷物に何箱も計上してしまう
  if (orderId) {
    const siblings = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
          WHERE order_no = (SELECT order_no FROM orders WHERE id = @orderId)`
      )
      .get({ orderId }).n;
    if (siblings > 1) {
      return { suggestion: null, reason: '複数明細の受注は段ボールを選んでください（対応表は商品×本数の1対1のため）' };
    }
  }

  const rule = findCartonRule(db, productId, quantity);
  if (!rule) {
    return { suggestion: null, reason: 'この商品と本数の組み合わせが段ボール対応表にありません' };
  }
  if (rule.material_id == null) {
    return {
      suggestion: null,
      reason: `対応表の「${rule.box_name ?? rule.carton_size}」に段ボールの資材が設定されていません（送料設定タブで設定してください）`,
    };
  }

  const material = db.prepare('SELECT id, name, category FROM materials WHERE id = ?').get(rule.material_id);
  if (!material) {
    return { suggestion: null, reason: '対応表に設定された資材が見つかりません' };
  }

  // **1組あたりの枚数を掛ける。** 300ml 2本は「1本用を2枚」なので、
  // 倍率（注文本数 ÷ 行の本数）だけだと1枚しか引かれない
  const multiplier = quantity / rule.quantity;

  return {
    suggestion: {
      materialId: material.id,
      materialName: material.name,
      boxes: rule.material_qty * multiplier,
      ruleQuantity: rule.quantity,
      materialQty: rule.material_qty,
      parcels: rule.parcels * multiplier,
      boxName: rule.box_name ?? null,
      cartonSize: rule.carton_size,
    },
    reason: null,
  };
}

/**
 * 「対応表に追加」。次回から同じ商品×本数で自動判定できるようにする。
 *
 * **呼び名（box_name）と段ボールの資材（material_id）も書く。**
 * 以前は carton_size しか書いていなかったので、画面から足した行は呼び名が常に空になり、
 * 資材とも繋がらないままだった（＝在庫が減らない）。
 *
 * 資材は**分類が「外箱」のものだけ**受ける。化粧箱・桐箱・プラケースは分類が「箱」で、
 * 箱詰めのレシピで既に減らしている。ここで通すと出荷時に二重に減る。
 */
function upsertCartonRule(
  {
    productId,
    quantity,
    cartonSize,
    boxName,
    materialId,
    materialQty,
    parcels,
    lengthCm,
    widthCm,
    heightCm,
    note,
  },
  actor = null
) {
  const db = getConnection();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new NotFoundError(`商品が見つかりません (id=${productId})`);
  if (!cartonSize) throw new BusinessRuleError('段ボールを指定してください');

  let material = null;
  if (materialId != null) {
    material = db.prepare('SELECT id, name, category FROM materials WHERE id = ?').get(materialId);
    if (!material) throw new NotFoundError(`資材が見つかりません (id=${materialId})`);
    assertCartonMaterial(material);
  }

  const before = db
    .prepare('SELECT * FROM carton_rules WHERE product_id = ? AND quantity = ?')
    .get(productId, quantity);

  // 枚数・荷物の個数は 1以上。空で来たら既存値を残す（COALESCE）
  for (const [label, value] of [['枚数', materialQty], ['荷物の個数', parcels]]) {
    if (value != null && !(Number.isInteger(value) && value >= 1)) {
      throw new BusinessRuleError(`${label}は1以上の整数で入力してください`);
    }
  }

  db.prepare(
    `INSERT INTO carton_rules
       (product_id, quantity, carton_size, box_name, material_id,
        material_qty, parcels, length_cm, width_cm, height_cm, note)
     VALUES
       (@productId, @quantity, @cartonSize, @boxName, @materialId,
        COALESCE(@materialQty, 1), COALESCE(@parcels, 1), @lengthCm, @widthCm, @heightCm, @note)
     ON CONFLICT(product_id, quantity)
     DO UPDATE SET carton_size  = excluded.carton_size,
                   box_name     = COALESCE(excluded.box_name, carton_rules.box_name),
                   material_id  = COALESCE(excluded.material_id, carton_rules.material_id),
                   material_qty = COALESCE(@materialQty, carton_rules.material_qty),
                   parcels      = COALESCE(@parcels, carton_rules.parcels),
                   length_cm    = COALESCE(@lengthCm, carton_rules.length_cm),
                   width_cm     = COALESCE(@widthCm, carton_rules.width_cm),
                   height_cm    = COALESCE(@heightCm, carton_rules.height_cm),
                   note         = excluded.note`
  ).run({
    productId,
    quantity,
    cartonSize,
    boxName: boxName ?? null,
    materialId: materialId ?? null,
    materialQty: materialQty ?? null,
    parcels: parcels ?? null,
    lengthCm: lengthCm ?? null,
    widthCm: widthCm ?? null,
    heightCm: heightCm ?? null,
    note: note ?? null,
  });

  const row = db
    .prepare('SELECT * FROM carton_rules WHERE product_id = ? AND quantity = ?')
    .get(productId, quantity);

  operationLogService.record({
    user: actor,
    action: 'carton.rule.upsert',
    targetType: 'carton_rules',
    targetId: row.id,
    summary:
      `段ボール対応表: ${product.name} ${quantity}本 → ${row.carton_size}サイズ` +
      (row.box_name ? `（${row.box_name}）` : '') +
      (material ? `／資材: ${material.name}` : '') +
      `／${row.material_qty}枚・${row.parcels}荷物` +
      (row.length_cm != null && row.width_cm != null && row.height_cm != null
        ? `／外寸 ${row.length_cm}×${row.width_cm}×${row.height_cm}cm`
        : '') +
      (before ? '（上書き）' : '（新規）'),
  });

  return row;
}

/** 出荷で減らしてよい資材かを確かめる。ここが唯一のガードになる */
function assertCartonMaterial(material) {
  if (material.category !== CARTON_CATEGORY) {
    throw new BusinessRuleError(
      `「${material.name}」は出荷用の段ボールではありません（資材の分類が「${material.category ?? '未設定'}」）。` +
        `分類が「${CARTON_CATEGORY}」の資材から選んでください。` +
        '化粧箱・桐箱・プラケースは箱詰めのときに減らしているので、ここで減らすと二重になります。'
    );
  }
}

function listCartonRules() {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT r.*, p.name AS product_name, m.name AS material_name, m.unit_price AS material_unit_price
       FROM carton_rules r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN materials m ON m.id = r.material_id
       ORDER BY p.name, r.quantity`
    )
    .all();

  // 外寸から出る区分も返す。手入力と食い違っていたら画面で気づけるようにするため
  return rows.map((r) => {
    const byDim = sizeFromDimensions(db, r);
    return {
      ...r,
      dimension_sum: byDim?.sum ?? null,
      size_from_dimensions: byDim?.size ?? null,
    };
  });
}

function deleteCartonRule(id) {
  const db = getConnection();
  return db.prepare('DELETE FROM carton_rules WHERE id = ?').run(id).changes > 0;
}

function listZones() {
  const db = getConnection();
  const registered = db.prepare('SELECT * FROM prefecture_zones').all();
  const byName = new Map(registered.map((r) => [r.prefecture, r.zone]));
  // 47件すべてを返し、未登録は zone を null にする（どこが埋まっていないか一目で分かるように）
  return PREFECTURES.map((prefecture) => ({ prefecture, zone: byName.get(prefecture) ?? null }));
}

function setZones(entries) {
  const db = getConnection();
  const stmt = db.prepare(
    `INSERT INTO prefecture_zones (prefecture, zone) VALUES (@prefecture, @zone)
     ON CONFLICT(prefecture) DO UPDATE SET zone = excluded.zone, updated_at = datetime('now')`
  );
  const clear = db.prepare('DELETE FROM prefecture_zones WHERE prefecture = ?');

  const run = db.transaction(() => {
    for (const e of entries) {
      if (!PREFECTURES.includes(e.prefecture)) {
        throw new BusinessRuleError(`都道府県名が正しくありません: ${e.prefecture}`);
      }
      if (e.zone == null || e.zone === '') clear.run(e.prefecture);
      else stmt.run({ prefecture: e.prefecture, zone: e.zone });
    }
  });
  run();
  return listZones();
}

function listRates() {
  const db = getConnection();
  return db.prepare('SELECT * FROM shipping_rates ORDER BY zone, carton_size').all();
}

function upsertRate({ zone, cartonSize, fee }) {
  const db = getConnection();
  if (!zone || !cartonSize) throw new BusinessRuleError('地帯と段ボールは必須です');
  db.prepare(
    `INSERT INTO shipping_rates (zone, carton_size, fee) VALUES (@zone, @cartonSize, @fee)
     ON CONFLICT(zone, carton_size)
     DO UPDATE SET fee = excluded.fee, updated_at = datetime('now')`
  ).run({ zone, cartonSize, fee });
  return db.prepare('SELECT * FROM shipping_rates WHERE zone = ? AND carton_size = ?').get(zone, cartonSize);
}

function deleteRate(id) {
  const db = getConnection();
  return db.prepare('DELETE FROM shipping_rates WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  PREFECTURES,
  extractPrefecture,
  quote,
  upsertCartonRule,
  listCartonRules,
  listCartonMaterials,
  assertCartonMaterial,
  suggestCartons,
  findCartonRule,
  sizeFromDimensions,
  cartonSizeBands,
  ceilTo50,
  TAX_RATE,
  CARTON_CATEGORY,
  deleteCartonRule,
  listZones,
  setZones,
  listRates,
  upsertRate,
  deleteRate,
};
