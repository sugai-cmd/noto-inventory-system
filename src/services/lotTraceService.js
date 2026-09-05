// ロット追跡。「どのタンクに、どの蒸留ロットの液体が入っているか」を出す。
//
// 台帳（tank_ledger / raw_sake_ledger）を古い順に再生して、
// タンクごとの中身の内訳を求める。新しい表は作っていない。
// 継足の行が既に蒸留IDを持っているので、そこから先は移動を追えば分かる。
//
// 【混ざり方の考え方】
// タンクの中の液体は物理的に混ざるので、移した後に「この50Lはロット○○」とは言えない。
// そこで**割合**で持つ。100Lのタンクが D-1:60L / D-2:40L のとき、
// そこから50L出せば D-1:30L / D-2:20L が出ていったものとして扱う。
// 現行シートの浄酎容器変動履歴でも、移動の行に蒸留IDは残らないので、
// 割合で追う以外に方法がない。

const { getConnection } = require('../db/connection');

// 由来が分からない液体の入れ物。
// 移行前からタンクにあったぶん（タンクマスタの初期在庫量）と、
// 棚卸で増えたぶん（理論値より実測が多かった場合）を分けて持つ。
const INITIAL = '__initial__';
const ADJUSTED = '__adjusted__';

const LABELS = {
  [INITIAL]: '移行前からの在庫',
  [ADJUSTED]: '棚卸で増えたぶん（由来不明）',
};

/** 小数の誤差が積もらないよう、0.001L単位に丸める */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** 中身の合計 */
function total(composition) {
  let sum = 0;
  for (const litres of composition.values()) sum += litres;
  return sum;
}

/**
 * タンクから quantity を取り出す。中身の割合に応じて按分する。
 * @returns {Map<string, number>} 取り出したぶんの内訳
 */
function take(composition, quantity) {
  const current = total(composition);
  const taken = new Map();
  if (quantity <= 0) return taken;

  // 台帳のほうが多く払い出している（移行データの取りこぼしなど）場合は、
  // 足りないぶんを「由来不明」として扱う。ここで止めると画面が出せなくなる。
  if (current <= 0) {
    taken.set(ADJUSTED, quantity);
    return taken;
  }

  const ratio = Math.min(1, quantity / current);
  let assigned = 0;
  const keys = [...composition.keys()];
  keys.forEach((key, i) => {
    // 最後の1つは残り全部にして、按分の端数で合計がずれないようにする
    const amount =
      i === keys.length - 1 && ratio === 1
        ? composition.get(key)
        : round(composition.get(key) * ratio);
    if (amount > 0) {
      taken.set(key, amount);
      composition.set(key, round(composition.get(key) - amount));
      assigned += amount;
    }
    if (composition.get(key) <= 0) composition.delete(key);
  });

  const shortage = round(quantity - assigned);
  if (shortage > 0) taken.set(ADJUSTED, (taken.get(ADJUSTED) ?? 0) + shortage);
  return taken;
}

/** 別のタンクへ足す */
function pour(composition, incoming) {
  for (const [key, litres] of incoming) {
    composition.set(key, round((composition.get(key) ?? 0) + litres));
  }
}

/**
 * 浄酎タンクの中身を、蒸留ロット別に求める。
 * v_tank_monitor と同じ規則（to_tank_id で増え、from_tank_id で減る）で再生するので、
 * 内訳の合計はモニターの現在液量と一致する。
 */
function computeTankCompositions(db = getConnection()) {
  const tanks = db.prepare('SELECT id, code, name, initial_volume_l FROM tanks ORDER BY id').all();

  const compositions = new Map();
  for (const tank of tanks) {
    const composition = new Map();
    if (tank.initial_volume_l > 0) composition.set(INITIAL, tank.initial_volume_l);
    compositions.set(tank.id, composition);
  }

  const rows = db
    .prepare(
      `SELECT id, txn_date, txn_type, from_tank_id, to_tank_id, quantity_l,
              distillation_id, product_ledger_id
       FROM tank_ledger
       WHERE is_cancelled = 0
       ORDER BY txn_date, id`
    )
    .all();

  // 瓶詰めがどの蒸留ロットから来たかも、同じ再生の中で拾っておく
  const bottlingSources = new Map();   // product_ledger_id -> Map<key, litres>

  for (const row of rows) {
    let moved = null;

    if (row.from_tank_id != null && compositions.has(row.from_tank_id)) {
      moved = take(compositions.get(row.from_tank_id), row.quantity_l);
      if (row.txn_type === '瓶詰' && row.product_ledger_id != null) {
        bottlingSources.set(row.product_ledger_id, moved);
      }
    }

    if (row.to_tank_id != null && compositions.has(row.to_tank_id)) {
      const target = compositions.get(row.to_tank_id);
      if (row.distillation_id != null) {
        // 蒸留の完了による継足。ここが蒸留ロットの入口になる
        pour(target, new Map([[`D:${row.distillation_id}`, row.quantity_l]]));
      } else if (moved) {
        // 容器移動。移した液体の内訳をそのまま持っていく
        pour(target, moved);
      } else {
        // 棚卸で増えたぶんなど、入口の分からない液体
        pour(target, new Map([[ADJUSTED, row.quantity_l]]));
      }
    }
  }

  return { compositions, bottlingSources };
}

/** 蒸留ロットの表示名（D2609-0001 など）を引く表 */
function distillationLabels(db) {
  const map = new Map();
  for (const d of db
    .prepare('SELECT id, distillation_code, completed_on, output_abv FROM distillations')
    .all()) {
    map.set(`D:${d.id}`, {
      code: d.distillation_code,
      completedOn: d.completed_on,
      abv: d.output_abv,
    });
  }
  return map;
}

/** 内訳のMapを、画面に出しやすい配列にする（多い順） */
function toBreakdown(composition, labels) {
  const sum = total(composition);
  return [...composition.entries()]
    .filter(([, litres]) => litres > 0.0005)
    .map(([key, litres]) => {
      const lot = labels.get(key);
      return {
        key,
        distillationId: key.startsWith('D:') ? Number(key.slice(2)) : null,
        label: lot ? lot.code : (LABELS[key] ?? key),
        completedOn: lot?.completedOn ?? null,
        abv: lot?.abv ?? null,
        volumeL: round(litres),
        share: sum > 0 ? Math.round((litres / sum) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.volumeL - a.volumeL);
}

/**
 * タンク一覧＋中身の内訳。
 * 廃棄済みと、中身も容量も無いタンクは既定で出さない（並べても読めなくなるため）。
 */
function listTankLots({ includeEmpty = false } = {}) {
  const db = getConnection();
  const { compositions } = computeTankCompositions(db);
  const labels = distillationLabels(db);

  const tanks = db
    .prepare(
      `SELECT t.id, t.code, t.name, t.container_type, t.max_volume_l, t.status,
              t.discarded_on, v.current_volume_l
       FROM tanks t
       LEFT JOIN v_tank_monitor v ON v.tank_id = t.id
       ORDER BY t.code`
    )
    .all();

  return tanks
    .filter((t) => !t.discarded_on)
    .map((t) => ({
      tankId: t.id,
      code: t.code,
      name: t.name,
      containerType: t.container_type,
      status: t.status,
      maxVolumeL: t.max_volume_l,
      currentVolumeL: round(t.current_volume_l ?? 0),
      lots: toBreakdown(compositions.get(t.id) ?? new Map(), labels),
    }))
    .filter((t) => includeEmpty || t.currentVolumeL > 0 || t.lots.length);
}

/**
 * 蒸留ロットの行方。
 * 「D2609-0001 で作った液体が、いまどのタンクに何L残っていて、
 * どれだけ瓶詰めされたか」を出す。
 */
function listDistillationLots({ limit = 100 } = {}) {
  const db = getConnection();
  const { compositions, bottlingSources } = computeTankCompositions(db);

  const tanks = new Map(
    db.prepare('SELECT id, code, name FROM tanks').all().map((t) => [t.id, t])
  );

  // タンクに残っているぶんを蒸留ロットごとに集める
  const remaining = new Map();   // 'D:1' -> [{tank, volumeL}]
  for (const [tankId, composition] of compositions) {
    for (const [key, litres] of composition) {
      if (!key.startsWith('D:') || litres <= 0.0005) continue;
      if (!remaining.has(key)) remaining.set(key, []);
      remaining.get(key).push({
        tankId,
        code: tanks.get(tankId)?.code ?? '',
        name: tanks.get(tankId)?.name ?? '',
        volumeL: round(litres),
      });
    }
  }

  // 瓶詰めされたぶんを蒸留ロットごとに集める
  const bottled = new Map();     // 'D:1' -> [{productName, quantity, volumeL, date}]
  const ledgerRows = new Map(
    db
      .prepare(
        `SELECT l.id, l.history_code, l.txn_date, l.quantity, p.name AS product_name
         FROM product_stock_ledger l
         JOIN products p ON p.id = l.product_id
         WHERE l.txn_type = '瓶詰' AND l.is_cancelled = 0`
      )
      .all()
      .map((r) => [r.id, r])
  );
  for (const [productLedgerId, composition] of bottlingSources) {
    const ledger = ledgerRows.get(productLedgerId);
    if (!ledger) continue;
    const sum = total(composition);
    for (const [key, litres] of composition) {
      if (!key.startsWith('D:') || litres <= 0.0005) continue;
      if (!bottled.has(key)) bottled.set(key, []);
      bottled.get(key).push({
        historyCode: ledger.history_code,
        txnDate: ledger.txn_date,
        productName: ledger.product_name,
        // 1回の瓶詰めが複数ロットにまたがるときは、本数もその割合で見る
        quantity: sum > 0 ? Math.round((ledger.quantity * litres) / sum) : 0,
        volumeL: round(litres),
      });
    }
  }

  return db
    .prepare(
      `SELECT d.id, d.distillation_code, d.status, d.completed_on, d.output_l, d.output_abv,
              d.input_summary, t.code AS output_tank_code, t.name AS output_tank_name
       FROM distillations d
       LEFT JOIN tanks t ON t.id = d.output_tank_id
       ORDER BY d.completed_on DESC, d.id DESC
       LIMIT ?`
    )
    .all(limit)
    .map((d) => {
      const key = `D:${d.id}`;
      const inTanks = remaining.get(key) ?? [];
      const usedFor = bottled.get(key) ?? [];
      return {
        distillationId: d.id,
        distillationCode: d.distillation_code,
        status: d.status,
        completedOn: d.completed_on,
        outputL: d.output_l,
        outputAbv: d.output_abv,
        inputSummary: d.input_summary,
        outputTank: d.output_tank_code
          ? `${d.output_tank_code} ${d.output_tank_name}`
          : null,
        remainingL: round(inTanks.reduce((s, r) => s + r.volumeL, 0)),
        bottledL: round(usedFor.reduce((s, r) => s + r.volumeL, 0)),
        inTanks,
        bottled: usedFor,
      };
    });
}

/**
 * 原酒タンクの中身を銘柄別に出す。
 * 原酒は蒸留の前段なので台帳が別（raw_sake_ledger）。
 * 受入で銘柄が入り、払出（蒸留への投入）で減る。
 */
function listRawSakeTankLots({ includeEmpty = false } = {}) {
  const db = getConnection();

  const tanks = db
    .prepare(
      `SELECT t.id, t.code, t.name, t.container_type, t.max_volume_l, t.initial_volume_l,
              t.discarded_on, v.current_volume_l
       FROM tanks t
       LEFT JOIN v_raw_sake_tank_volume v ON v.tank_id = t.id
       ORDER BY t.code`
    )
    .all();

  const compositions = new Map();
  for (const t of tanks) {
    const composition = new Map();
    if (t.initial_volume_l > 0) composition.set(INITIAL, t.initial_volume_l);
    compositions.set(t.id, composition);
  }

  const brands = new Map(
    db
      .prepare(
        `SELECT b.id, b.name, br.name AS brewery_name
         FROM raw_sake_brands b
         LEFT JOIN breweries br ON br.id = b.brewery_id`
      )
      .all()
      .map((b) => [`B:${b.id}`, b])
  );

  const rows = db
    .prepare(
      `SELECT id, txn_date, txn_type, from_tank_id, to_tank_id, quantity,
              raw_sake_brand_id, source_ref, spec_note
       FROM raw_sake_ledger
       ORDER BY txn_date, id`
    )
    .all();

  // 銘柄が未登録の受入は、受入元やスペックの自由記述で見分けられるようにする
  const freeLabels = new Map();

  for (const row of rows) {
    if (row.txn_type === '払出' && row.from_tank_id != null && compositions.has(row.from_tank_id)) {
      take(compositions.get(row.from_tank_id), row.quantity);
      continue;
    }
    if (row.txn_type === '受入' && row.to_tank_id != null && compositions.has(row.to_tank_id)) {
      let key;
      if (row.raw_sake_brand_id != null) {
        key = `B:${row.raw_sake_brand_id}`;
      } else {
        // 銘柄マスタに無いぶんは、書かれている内容をそのまま見出しにする
        const text = row.spec_note || row.source_ref || '銘柄の記録なし';
        key = `F:${text}`;
        freeLabels.set(key, text);
      }
      pour(compositions.get(row.to_tank_id), new Map([[key, row.quantity]]));
    }
  }

  const labels = new Map();
  for (const [key, brand] of brands) {
    labels.set(key, {
      code: brand.brewery_name ? `${brand.name}（${brand.brewery_name}）` : brand.name,
    });
  }
  for (const [key, text] of freeLabels) labels.set(key, { code: text });

  return tanks
    .filter((t) => !t.discarded_on)
    .map((t) => ({
      tankId: t.id,
      code: t.code,
      name: t.name,
      containerType: t.container_type,
      maxVolumeL: t.max_volume_l,
      currentVolumeL: round(t.current_volume_l ?? 0),
      lots: toBreakdown(compositions.get(t.id) ?? new Map(), labels),
    }))
    .filter((t) => includeEmpty || t.currentVolumeL > 0 || t.lots.length);
}

/**
 * 仕掛品ロット（瓶詰め1件＝1ロット）の一覧。
 * 残数だけでなく、どの箱詰めに何本使ったかまで出す。
 * 引当の記録（wip_lot_allocations）は既にあるが、画面から見えていなかった。
 */
function listWipLots({ includeEmpty = false } = {}) {
  const db = getConnection();

  const lots = db
    .prepare(
      `SELECT l.id, l.history_code, l.txn_date, l.quantity, p.name AS product_name,
              t.code AS tank_code, t.name AS tank_name,
              COALESCE((
                SELECT SUM(a.quantity) FROM wip_lot_allocations a
                JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
                WHERE a.bottling_ledger_id = l.id AND b.is_cancelled = 0
              ), 0) AS allocated
       FROM product_stock_ledger l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN tank_ledger tl
              ON tl.product_ledger_id = l.id AND tl.txn_type = '瓶詰' AND tl.is_cancelled = 0
       LEFT JOIN tanks t ON t.id = tl.from_tank_id
       WHERE l.txn_type = '瓶詰' AND l.is_cancelled = 0
       ORDER BY l.txn_date DESC, l.id DESC`
    )
    .all();

  const boxings = db
    .prepare(
      `SELECT a.bottling_ledger_id, a.quantity, b.history_code, b.txn_date
       FROM wip_lot_allocations a
       JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
       WHERE b.is_cancelled = 0
       ORDER BY b.txn_date, b.id`
    )
    .all();

  const byLot = new Map();
  for (const b of boxings) {
    if (!byLot.has(b.bottling_ledger_id)) byLot.set(b.bottling_ledger_id, []);
    byLot.get(b.bottling_ledger_id).push({
      historyCode: b.history_code,
      txnDate: b.txn_date,
      quantity: b.quantity,
    });
  }

  // 瓶詰めの元になった蒸留ロットも出す（タンク→蒸留ロットまで遡れるようにする）
  const { bottlingSources } = computeTankCompositions(db);
  const distLabels = distillationLabels(db);

  return lots
    .map((l) => ({
      bottlingLedgerId: l.id,
      historyCode: l.history_code,
      txnDate: l.txn_date,
      productName: l.product_name,
      tank: l.tank_code ? `${l.tank_code} ${l.tank_name}` : null,
      quantity: l.quantity,
      allocated: l.allocated,
      remaining: l.quantity - l.allocated,
      boxings: byLot.get(l.id) ?? [],
      sourceLots: toBreakdown(bottlingSources.get(l.id) ?? new Map(), distLabels),
    }))
    .filter((l) => includeEmpty || l.remaining > 0);
}

module.exports = {
  listTankLots,
  listDistillationLots,
  listRawSakeTankLots,
  listWipLots,
  // テストと他のサービスから使う
  computeTankCompositions,
};
