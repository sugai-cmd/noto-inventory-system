// COREZO（金沢楽座）の注文確認メールを受注に登録する。
//
// 流れ: メール本文 → 項目の読み取り（corezoParser）→ マスタと突合 → submitOrder
//       → 翌朝の ship-docs が送り状（Webゆうパックプリント）と納品書（マネーフォワード）を作る
//
// 方針（2026-10-20 菅井さんと決定）
//   - 得意先は「金沢楽座（COREZO）」の1社。お届け先は消費者なので delivery_address に入れる
//   - 商品はメールの商品コード（13桁）を商品マスタの jan_code と突合。
//     商品名では引かない（表記がCOREZO側の都合で変わるため）
//   - 売価は**上代 × 得意先マスタの掛け率**（卸8掛け）。
//     メールの金額は消費者が払った額で、COREZOから当社に入る額ではないので使わない
//   - 送料は1注文あたり一律1,000円（税込）
//   - 1通に複数商品が入るので、**同じ受注番号の複数明細**で登録する
//   - 重複防止: note に「COREZO注文番号：<番号>」を書き、同じ番号があれば登録しない
//
// **決めきれないものは登録しない。** 得意先・商品が決まらない、項目が読めない場合は
// needs_review として理由と候補を返す（faxOrderImportService と同じ方針）。

const fs = require('node:fs');
const { getConnection } = require('../db/connection');
const { similarity } = require('../../scripts/lib/similarName');
const orderService = require('./orderService');
const { parseCorezoOrder } = require('./corezoOrder/corezoParser');

const NOTE_PREFIX = 'COREZO注文番号：';

/**
 * 1注文あたりの送料。**税抜で持つ。**
 *
 * COREZOと取り決めている送料は1,000円（税込）だが、請求額の式（invoiceAmount.js）は
 * `(売価 + 送料) × 1.1` で、送料にも税を掛ける。税込1,000をそのまま入れると
 * 1,100円ぶん請求してしまうので、**ここだけ税抜909円**で入れて請求額を合わせる。
 *
 *   (2,640 + 909) × 1.1 = 3,904 … 取り決めどおりの額
 *
 * ほかの受注の送料は税込で入っている（shippingFeeService が税込で返す）。
 * 送料の二重課税そのものは別件の課題で、直すときはここも併せて見直す。
 */
const SHIPPING_FEE_EXCL_TAX = 909;

/** 得意先「金沢楽座」を探す条件。shipDocsService.targetCustomers と同じ表記ゆれを拾う */
const CUSTOMER_WHERE = `UPPER(name) LIKE '%COREZO%' OR name LIKE '%コレゾ%' OR name LIKE '%金沢楽座%'`;

/**
 * 同じ注文番号の受注がすでにあるか（取消済みも含む。取り消したものを勝手に復活させない）。
 * 手で登録した分は「注文番号：141709」とだけ書かれていることがあるので、そちらも拾う。
 */
function findExistingOrder(db, orderNumber) {
  return db
    .prepare(
      `SELECT order_no, is_cancelled FROM orders
        WHERE note LIKE ? OR note LIKE ?
        ORDER BY id LIMIT 1`
    )
    .get(`%注文番号：${orderNumber}%`, `%注文番号:${orderNumber}%`);
}

/** COREZOの商品コード → 商品マスタのJAN（corezoProductMap.json） */
function loadCodeMap() {
  try {
    return require('./corezoOrder/corezoProductMap.json').map ?? {};
  } catch {
    return {};
  }
}

/**
 * 商品を決める。商品コードを**そのままJANとして**引き、当たらなければ読み替え表を見る。
 * どちらでも決まらなければ登録しない（違う商品で送り状を作らないため）。
 */
function matchProduct(db, item) {
  const map = loadCodeMap();
  const codes = [item.productCode, map[item.productCode]].filter(Boolean);

  for (const code of codes) {
    const product = db.prepare('SELECT * FROM products WHERE jan_code = ?').get(code);
    if (product) {
      return {
        product,
        warning:
          code === item.productCode
            ? null
            : `商品コード ${item.productCode} を読み替え表で ${code} として扱いました`,
      };
    }
  }

  const candidates = db
    .prepare('SELECT name FROM products')
    .all()
    .map((r) => ({ name: r.name, score: similarity(item.productName, r.name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.name);

  return {
    reason:
      `商品コード ${item.productCode}（${item.productName}）に当たる商品がありません。` +
      'マスタのJANコードを入れるか、corezoProductMap.json に読み替えを書いてください',
    candidates,
  };
}

/** 得意先「金沢楽座」を決める */
function matchCustomer(db) {
  const rows = db.prepare(`SELECT * FROM customers WHERE ${CUSTOMER_WHERE} ORDER BY id`).all();
  if (!rows.length) {
    return { reason: '得意先「金沢楽座（COREZO）」がマスタにありません' };
  }
  if (rows.length === 1) return { customer: rows[0] };

  const exact = rows.find((r) => r.name === '金沢楽座');
  if (exact) return { customer: exact };
  return {
    reason: `得意先「金沢楽座（COREZO）」の候補が${rows.length}件あり、どれか決められません`,
    candidates: rows.map((r) => r.name),
  };
}

/**
 * 読み取り結果から受注を登録する。
 *
 * @param {object} parsed - parseCorezoOrder の結果
 * @returns {{status:'registered'|'dry_run'|'duplicate'|'needs_review'|'notice'|'not_corezo',
 *            parsed, order?, plan?, reasons?, candidates?, warnings}}
 */
function importParsed(parsed, { dryRun = false, actor = null } = {}) {
  const warnings = [...(parsed.warnings ?? [])];

  if (parsed.kind === 'other') return { status: 'not_corezo', parsed, warnings };
  if (parsed.kind === 'notice') {
    // 配送先の変更など、注文以外のCOREZOからの連絡。**自動では直さない**（2026-10-20 決定）。
    // 送り状をすでに作ったあとだと機械では直せないので、人が見て判断する
    return {
      status: 'notice',
      parsed,
      warnings,
      reasons: [
        `COREZOからの連絡です（${parsed.subject || '件名なし'}）` +
          (parsed.orderNumber ? `／注文番号 ${parsed.orderNumber}` : ''),
      ],
    };
  }

  const db = getConnection();
  const reasons = [...parsed.errors];
  const candidates = {};

  if (parsed.orderNumber) {
    const existing = findExistingOrder(db, parsed.orderNumber);
    if (existing) {
      return {
        status: 'duplicate',
        parsed,
        warnings,
        reasons: [
          `注文番号 ${parsed.orderNumber} は受注 ${existing.order_no} として登録済みです` +
            (existing.is_cancelled ? '（取消済み）' : ''),
        ],
      };
    }
  }

  const items = [];
  for (const item of parsed.items) {
    const m = matchProduct(db, item);
    if (m.product) {
      items.push({ productId: m.product.id, productName: m.product.name, quantity: item.quantity });
      if (m.warning) warnings.push(m.warning);
    } else {
      reasons.push(m.reason);
      if (m.candidates) candidates.product = [...(candidates.product ?? []), ...m.candidates];
    }
  }

  const mc = matchCustomer(db);
  if (!mc.customer) {
    reasons.push(mc.reason);
    if (mc.candidates) candidates.customer = mc.candidates;
  }

  if (reasons.length) return { status: 'needs_review', parsed, reasons, candidates, warnings };

  const customer = mc.customer;
  if (customer.markup_rate == null) {
    // 掛け率が無いと submitOrder は1倍（＝上代そのまま）で売価を出す。黙って通さない
    warnings.push(
      `得意先「${customer.name}」に掛け率が登録されていないため、売価が上代のままになります`
    );
  }

  const delivery = parsed.delivery;
  const plan = {
    orderedOn: parsed.orderedOn,
    customerId: customer.id,
    customerName: customer.name,
    items,
    requestedDeliveryOn: delivery.deliveryOn,
    shippingFee: SHIPPING_FEE_EXCL_TAX,
    // 送り状CSVは delivery_address を utils/shippingAddress で分解する。
    // メールの「◎お届け先」の節は、その形のまま読めるので組み立て直さない
    deliveryAddress: delivery.raw,
    note: `${NOTE_PREFIX}${parsed.orderNumber}`,
  };

  if (dryRun) return { status: 'dry_run', parsed, plan, warnings };

  const order = orderService.submitOrder(
    {
      orderedOn: plan.orderedOn,
      customerId: plan.customerId,
      items: plan.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      requestedDeliveryOn: plan.requestedDeliveryOn,
      shippingFee: plan.shippingFee,
      deliveryAddress: plan.deliveryAddress,
      note: plan.note,
    },
    actor
  );
  return { status: 'registered', parsed, plan, order, warnings };
}

/** メール本文から登録する */
function importFromText(text, opts) {
  return importParsed(parseCorezoOrder(text), opts);
}

/** corezo-saver が保存したファイルから登録する（fileInbox から呼ばれる） */
async function importFromFile(filePath, opts = {}) {
  return importFromText(fs.readFileSync(filePath, 'utf8'), opts);
}

module.exports = {
  importFromFile,
  importFromText,
  importParsed,
  matchCustomer,
  matchProduct,
  findExistingOrder,
  NOTE_PREFIX,
  SHIPPING_FEE_EXCL_TAX,
};
