// カナカンの発注書FAXを受注に登録する。
//
// 流れ: PDF → OCR（ocr.js）→ 項目の読み取り（kanakanParser.js）→ マスタと突合 → submitOrder
//
// 方針（2026-10-10 菅井さんと決定）
//   - 1発注＝1受注。複数商品は別FAXで届く前提
//   - 商品はJANコードで商品マスタと突合（FAXで商品名が崩れるため名前は使わない）
//   - 入庫日 → 納品希望日（requested_delivery_on）
//   - 得意先は納入倉庫の名前（「カナカン酒類石川」等）を、カナカンの支店の得意先名と照合
//   - 重複防止: noteの先頭に「カナカン発注番号：<8桁>」を書き、同じ番号があれば登録しない
//
// **決めきれないものは登録しない。** 得意先・商品が決まらない、項目が読めない場合は
// needs_review として理由と候補を返し、人が確認する（受注テーブルは得意先・商品が必須のため、
// 半端な行は作れない）。

const { getConnection } = require('../db/connection');
const { normalizeName } = require('../utils/normalizeName');
const { similarity } = require('../../scripts/lib/similarName');
const orderService = require('./orderService');
const { parseKanakanOrder } = require('./faxOrder/kanakanParser');
const { ocrPdf } = require('./faxOrder/ocr');

const NOTE_PREFIX = 'カナカン発注番号：';

/** 近い名前で得意先を決めてよい最低点と、2番手との差 */
const CUSTOMER_MIN_SCORE = 0.75;
const CUSTOMER_MIN_MARGIN = 0.1;

/** 入数・数量は同じ回の読み取り結果をまとめて採用する（混ぜると数字が食い違う） */
const QUANTITY_FIELDS = ['perCase', 'inner', 'cases', 'quantity', 'productNameRaw'];
const SIMPLE_FIELDS = ['orderNumber', 'orderedOn', 'deliveryOn', 'jan', 'warehouse', 'office'];

/**
 * 読み方を変えた複数回のOCR結果を1つにまとめる。項目ごとに最初に読めたものを使う。
 * 各項目は桁数・日付・チェックデジットで検算済みなので、別の回の値を混ぜても安全。
 */
function mergeParsed(parsedList) {
  const merged = { isKanakan: parsedList.some((p) => p.isKanakan), warnings: [], sources: {} };

  for (const field of SIMPLE_FIELDS) {
    const hit = parsedList.find((p) => p[field] != null);
    merged[field] = hit ? hit[field] : null;
  }
  const qtyHit = parsedList.find((p) => p.quantity != null);
  for (const field of QUANTITY_FIELDS) merged[field] = qtyHit ? qtyHit[field] : null;
  if (qtyHit) merged.warnings.push(...qtyHit.warnings);

  // まだ読めていない項目のエラーだけ残す
  const stillMissing = (field) =>
    field === 'isKanakan' ? !merged.isKanakan : merged[field] == null;
  const errors = [];
  for (const p of parsedList) {
    p.missing.forEach((field, i) => {
      if (stillMissing(field) && !errors.includes(p.errors[i])) errors.push(p.errors[i]);
    });
  }
  merged.errors = errors;
  merged.missing = [...new Set(parsedList.flatMap((p) => p.missing))].filter(stillMissing);
  return merged;
}

/** 同じ発注番号の受注がすでにあるか（取消済みも含む。取り消したものを勝手に復活させない） */
function findExistingOrder(db, orderNumber) {
  return db
    .prepare(
      `SELECT order_no, is_cancelled FROM orders WHERE note LIKE ? ORDER BY id LIMIT 1`
    )
    .get(`${NOTE_PREFIX}${orderNumber}%`);
}

/** JANで商品を引く。1件に決まったときだけ返す */
function matchProduct(db, jan) {
  const rows = db
    .prepare(
      `SELECT id, name, jan_code FROM products
        WHERE REPLACE(REPLACE(jan_code, ' ', ''), '-', '') = ?`
    )
    .all(jan);
  if (rows.length === 1) return { product: rows[0] };
  if (rows.length === 0) return { reason: `JAN ${jan} の商品が商品マスタにありません` };
  return {
    reason: `JAN ${jan} の商品が商品マスタに${rows.length}件あります`,
    candidates: rows.map((r) => r.name),
  };
}

/**
 * 納入倉庫の名前から得意先（カナカンの支店）を決める。
 * 候補は「カナカン」で始まる得意先と、本店がカナカンの得意先。本店そのものは除く
 * （受注・納品は支店単位。請求は customerService.resolveBilling が本店から引き継ぐ）。
 */
function matchCustomer(db, { warehouse, office }) {
  const rows = db
    .prepare(
      `SELECT c.id, c.name
         FROM customers c
         LEFT JOIN customers p ON p.id = c.parent_id
        WHERE (c.name LIKE 'カナカン%' OR p.name LIKE 'カナカン%')
          AND NOT EXISTS (SELECT 1 FROM customers ch WHERE ch.parent_id = c.id)`
    )
    .all();
  if (!rows.length) return { reason: 'カナカンの得意先がマスタにありません' };

  const squash = (s) => normalizeName(s).replace(/\s+/g, '');
  // 「酒類石川営業所」→「カナカン酒類石川」も照合に使う
  const queries = [warehouse, office && `カナカン${office.replace(/営業所$/, '')}`].filter(Boolean);

  for (const q of queries) {
    const exact = rows.find((r) => squash(r.name) === squash(q));
    if (exact) return { customer: exact };
  }

  const scored = rows
    .map((r) => ({ ...r, score: Math.max(...queries.map((q) => similarity(q, r.name))) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (
    best.score >= CUSTOMER_MIN_SCORE &&
    (!second || best.score - second.score >= CUSTOMER_MIN_MARGIN)
  ) {
    return {
      customer: best,
      warning: `得意先名が完全一致しなかったため、近い「${best.name}」を選びました（読取: ${warehouse}）`,
    };
  }
  return {
    reason: `納入倉庫「${warehouse ?? '?'}」に当たる得意先を決められませんでした`,
    candidates: scored.slice(0, 3).map((r) => r.name),
  };
}

/**
 * 読み取り結果から受注を登録する。
 * @param {object} parsed - parseKanakanOrder / mergeParsed の結果
 * @param {{dryRun?: boolean, sourceName?: string, actor?: object}} [opts]
 * @returns {{status: 'registered'|'dry_run'|'duplicate'|'needs_review'|'not_kanakan',
 *            parsed: object, order?: object, plan?: object, reasons?: string[],
 *            candidates?: object, warnings: string[]}}
 */
function importParsed(parsed, { dryRun = false, sourceName = null, actor = null } = {}) {
  const warnings = [...(parsed.warnings ?? [])];
  if (!parsed.isKanakan) return { status: 'not_kanakan', parsed, warnings };

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
          `発注番号 ${parsed.orderNumber} は受注 ${existing.order_no} として登録済みです` +
            (existing.is_cancelled ? '（取消済み）' : ''),
        ],
      };
    }
  }

  let product = null;
  if (parsed.jan) {
    const m = matchProduct(db, parsed.jan);
    if (m.product) product = m.product;
    else {
      reasons.push(m.reason);
      if (m.candidates) candidates.product = m.candidates;
    }
  }

  let customer = null;
  if (parsed.warehouse || parsed.office) {
    const m = matchCustomer(db, parsed);
    if (m.customer) {
      customer = m.customer;
      if (m.warning) warnings.push(m.warning);
    } else {
      reasons.push(m.reason);
      if (m.candidates) candidates.customer = m.candidates;
    }
  }

  if (reasons.length) return { status: 'needs_review', parsed, reasons, candidates, warnings };

  const noteLines = [`${NOTE_PREFIX}${parsed.orderNumber}`];
  noteLines.push(
    `FAX自動取込${sourceName ? `（${sourceName}）` : ''}: ${parsed.cases}ケース×${parsed.perCase}本` +
      (parsed.inner !== 1 ? `×${parsed.inner}` : '')
  );

  const plan = {
    orderedOn: parsed.orderedOn,
    customerId: customer.id,
    customerName: customer.name,
    productId: product.id,
    productName: product.name,
    quantity: parsed.quantity,
    requestedDeliveryOn: parsed.deliveryOn,
    note: noteLines.join('\n'),
  };

  if (dryRun) return { status: 'dry_run', parsed, plan, warnings };

  const order = orderService.submitOrder(
    {
      orderedOn: plan.orderedOn,
      customerId: plan.customerId,
      productId: plan.productId,
      quantity: plan.quantity,
      requestedDeliveryOn: plan.requestedDeliveryOn,
      note: plan.note,
    },
    actor
  );
  return { status: 'registered', parsed, plan, order, warnings };
}

/** OCRテキスト（1回分でも複数回分でも）から登録する */
function importFromTexts(texts, opts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(parseKanakanOrder);
  return importParsed(mergeParsed(list), opts);
}

/** PDFから登録する。OCRは読み方を変えて数回走らせ、結果をまとめる */
async function importFromPdf(pdfPath, opts = {}) {
  const runs = await ocrPdf(pdfPath, {
    ...opts.ocr,
    stopWhen: (text) => parseKanakanOrder(text).errors.length === 0,
  });
  return importParsed(mergeParsed(runs.map((r) => parseKanakanOrder(r.text))), opts);
}

module.exports = {
  importFromPdf,
  importFromTexts,
  importParsed,
  mergeParsed,
  matchCustomer,
  matchProduct,
  NOTE_PREFIX,
};
