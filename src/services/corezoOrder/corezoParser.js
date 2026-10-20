// COREZO（金沢楽座）の注文確認メールを読み取る。
//
// メールは support@corezo.co.jp から届く自動配信で、**書式が毎回同じ**。
// カナカンのFAXと違いOCRが要らないので、本文をそのまま読む。
//
// 読み取る項目（実物 2026-08〜10 の7通で確認）
//   ご注文番号：141709            … 二重登録を防ぐ鍵
//   ご注文商品明細                … 商品名／商品コード（13桁）／数量／金額(税抜)
//   配送情報 ◎お届け先           … お名前・郵便番号・住所・電話番号・お届け日・お届け時間
//
// **金額は読まない。** メールに載っているのは消費者が払った額で、COREZOから当社に入る額
// ではない（売価は上代×得意先の掛け率で出す。corezoOrderImportService を参照）。
//
// 本文は全角スペースを含む（「お名前　：」「送　料」）。ラベルの照合では空白を無視する。

/** 「商品代金」「小　計」のように全角スペースが混ざるラベルを素直に書けるようにする */
function labelRe(label, rest) {
  return new RegExp(label.split('').map((c) => `${c}[\\s　]*`).join('') + rest);
}

/** 「￥ 4,209」→ 4209。読めなければ null */
function toAmount(text) {
  if (text == null) return null;
  const m = String(text).replace(/[,\s　]/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/** 「2026/10/16」→「2026-10-16」。「指定なし」や空は null */
function toDate(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 行頭・行末の空白（全角を含む）を落とす */
const trim = (text) => String(text ?? '').replace(/^[\s　]+|[\s　]+$/g, '');

/**
 * 「ご注文商品明細」の節から商品を拾う。
 *
 * 1通に複数商品が入る（実物で2商品の例あり）。節の終わりは罫線（-----）。
 * 「配送情報」の節にも商品コードと数量が出てくるが、そちらは**お届け先ごとの内訳**なので
 * ここでは読まない（混ぜると数量が二重になる）。
 */
function parseItems(body) {
  const start = body.search(labelRe('ご注文商品明細', ''));
  if (start === -1) return [];
  const rest = body.slice(start);
  const end = rest.search(/^-{5,}/m);
  const section = end === -1 ? rest : rest.slice(0, end);

  const items = [];
  const re = /商品名[:：]\s*(.+?)\r?\n\s*商品コード[:：]\s*([0-9]+)[\s\S]*?数量[:：]\s*(\d+)/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    items.push({ productName: trim(m[1]), productCode: m[2], quantity: Number(m[3]) });
  }
  return items;
}

/**
 * 「◎お届け先」の節を、**本文のまま**返す。
 *
 * 送り状CSV（csvExportService.exportYuPack）は orders.delivery_address を
 * utils/shippingAddress.parseShippingAddress で分解する。あちらは
 * 「お名前：」「郵便番号：」「〒」「様」「お届け日：」「指定なし」「18時～20時」を
 * すでに解釈できるので、**組み立て直さずそのまま渡すのが一番崩れない**。
 */
function parseDeliveries(body) {
  const blocks = body.split(/◎お届け先/).slice(1);
  return blocks.map((block) => {
    // 次の節（商品コードの繰り返し、または「注文者情報」）の手前まで
    const cut = block.search(/(商品コード[:：])|(\*{5,})/);
    const raw = trim(cut === -1 ? block : block.slice(0, cut));
    const field = (label) => {
      const m = raw.match(new RegExp(`${label}[\\s　]*[:：][\\s　]*(.*)`));
      return m ? trim(m[1]) : null;
    };
    return {
      raw,
      name: field('お名前')?.replace(/[\s　]*様$/, '') ?? null,
      zip: field('郵便番号'),
      address: field('住所'),
      phone: field('電話番号'),
      deliveryOn: toDate(field('お届け日')),
      deliveryTime: field('お届け時間'),
    };
  });
}

/**
 * COREZOのメール本文を読み取る。
 *
 * 判定できなかった項目は missing/errors に理由を入れて返す。
 * **決めきれないものは呼び手が登録しない**（faxOrderImportService と同じ方針）。
 *
 * @param {string} text - メール本文（corezo-saver が保存したファイルの中身）
 * @returns {{kind, orderNumber, items, deliveries, receivedAt, errors, missing, warnings}}
 */
function parseCorezoOrder(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');

  // corezo-saver が付けるヘッダ（受信日時・件名）。無ければ null
  const header = (name) => {
    const m = body.match(new RegExp(`^X-COREZO-${name}:[ \\t]*(.*)$`, 'm'));
    return m ? trim(m[1]) : null;
  };
  const subject = header('Subject') ?? '';
  const receivedAt = header('Received');

  const isCorezo = /COREZO/i.test(body) || /金沢楽座/.test(body);
  const isOrderMail =
    isCorezo && labelRe('ご注文番号', '').test(body) && labelRe('ご注文商品明細', '').test(body);

  if (!isOrderMail) {
    // COREZOからの注文以外のメール（配送先変更などの連絡）は、人に見てもらう
    const isNotice = isCorezo;
    return {
      kind: isNotice ? 'notice' : 'other',
      subject,
      receivedAt,
      orderNumber: (body.match(/注文番号[:：]?\s*(\d+)/) ?? [])[1] ?? null,
      items: [],
      deliveries: [],
      errors: [],
      missing: [],
      warnings: [],
    };
  }

  const errors = [];
  const missing = [];
  const warnings = [];

  const orderNumber = (body.match(labelRe('ご注文番号', '[:：]\\s*(\\d+)')) ?? [])[1] ?? null;
  if (!orderNumber) {
    missing.push('orderNumber');
    errors.push('ご注文番号を読み取れませんでした');
  }

  const items = parseItems(body);
  if (!items.length) {
    missing.push('items');
    errors.push('ご注文商品明細から商品を読み取れませんでした');
  }
  for (const item of items) {
    if (!(item.quantity > 0)) {
      missing.push('quantity');
      errors.push(`商品「${item.productName}」の数量を読み取れませんでした`);
    }
  }

  const deliveries = parseDeliveries(body);
  if (!deliveries.length) {
    missing.push('delivery');
    errors.push('お届け先を読み取れませんでした');
  } else if (deliveries.length > 1) {
    // 1注文を複数の宛先に分けて送る形。受注1件にまとめると送り状が1枚しか出ない
    errors.push(`お届け先が${deliveries.length}件あります（分けて登録してください）`);
    missing.push('delivery');
  } else if (!deliveries[0].address) {
    missing.push('delivery');
    errors.push('お届け先の住所を読み取れませんでした');
  }

  const received = toDate(receivedAt);
  if (!received) {
    missing.push('receivedAt');
    errors.push('受信日時（X-COREZO-Received）が読み取れませんでした');
  }

  return {
    kind: 'order',
    subject,
    receivedAt,
    orderedOn: received,
    orderNumber,
    items,
    deliveries,
    delivery: deliveries[0] ?? null,
    errors,
    missing,
    warnings,
  };
}

module.exports = { parseCorezoOrder, parseItems, parseDeliveries, toDate, toAmount };
