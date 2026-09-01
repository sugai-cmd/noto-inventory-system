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
  let cartonSize = input.cartonSize ?? null;

  if (!cartonSize) {
    if (items.length === 1) {
      const rule = db
        .prepare('SELECT carton_size FROM carton_rules WHERE product_id = ? AND quantity = ?')
        .get(items[0].productId, items[0].quantity);
      if (rule) cartonSize = rule.carton_size;
      else reasons.push('この商品と本数の組み合わせが段ボール対応表にありません');
    } else if (items.length > 1) {
      // 対応表は「商品×本数」の1対1なので、複数商品の組み合わせは自動で決められない。
      reasons.push('複数商品の受注は段ボールを選んでください（対応表は商品×本数の1対1のため）');
    } else {
      reasons.push('商品が指定されていません');
    }
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

  return {
    prefecture,
    zone: zoneRow?.zone ?? null,
    cartonSize,
    fee: rateRow?.fee ?? null,
    resolved: rateRow != null,
    reasons,
    // 画面の段ボール選択肢（料金表に登録済みのサイズ）
    cartonOptions: db
      .prepare('SELECT DISTINCT carton_size FROM shipping_rates ORDER BY carton_size')
      .all()
      .map((r) => r.carton_size),
  };
}

/** 「対応表に追加」。次回から同じ商品×本数で自動判定できるようにする */
function upsertCartonRule({ productId, quantity, cartonSize, note }, actor = null) {
  const db = getConnection();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new NotFoundError(`商品が見つかりません (id=${productId})`);
  if (!cartonSize) throw new BusinessRuleError('段ボールを指定してください');

  db.prepare(
    `INSERT INTO carton_rules (product_id, quantity, carton_size, note)
     VALUES (@productId, @quantity, @cartonSize, @note)
     ON CONFLICT(product_id, quantity)
     DO UPDATE SET carton_size = excluded.carton_size, note = excluded.note`
  ).run({ productId, quantity, cartonSize, note: note ?? null });

  return db
    .prepare('SELECT * FROM carton_rules WHERE product_id = ? AND quantity = ?')
    .get(productId, quantity);
}

function listCartonRules() {
  const db = getConnection();
  return db
    .prepare(
      `SELECT r.*, p.name AS product_name
       FROM carton_rules r JOIN products p ON p.id = r.product_id
       ORDER BY p.name, r.quantity`
    )
    .all();
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
  deleteCartonRule,
  listZones,
  setZones,
  listRates,
  upsertRate,
  deleteRate,
};
