// カナカンの発注書FAX（OCR済みテキスト）から受注に必要な項目を取り出す。
//
// 入力はTesseractの出力そのまま。日本語モデルは次の癖があるので、ここで吸収する。
//   - 数字を丸数字で返す（「①0月」「⑫X」）→ NFKCで普通の数字に戻す
//   - 1文字ごとに空白が入る（「発 注 番 号」）→ 行ごとに空白を全部消してから読む
//   - FAXのかすれで商品名が崩れる（「ホワイト」→「ホワノト」）→ 商品名は使わず、JANで引く
//
// ここは文字列を読むだけで、DBには触らない（突合と登録は faxOrderImportService）。

/** OCRテキストを「空白なし・半角」の行の配列にする */
function normalizeLines(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ''))
    .filter(Boolean);
}

/** カナカンの発注書かどうか。社名に加えて「発注」の見出しか番号欄があること */
function isKanakanOrder(text) {
  const joined = normalizeLines(text).join('\n');
  const hasName = joined.includes('カナカン') || joined.includes('076-266-2220');
  const hasOrderMark = joined.includes('発注書') || joined.includes('発注番号');
  return hasName && hasOrderMark;
}

/** 「26年10月15日」「2026年10月15日」→ '2026-10-15'。読めなければ null */
function toDate(yearText, month, day) {
  let year = Number(yearText);
  if (yearText.length <= 2) year += 2000;
  const m = Number(month);
  const d = Number(day);
  if (!(year >= 2000 && year < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(year, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 2月30日などの読み違い
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function findDate(joined, label) {
  const m = joined.match(new RegExp(`${label}(\\d{2,4})年(\\d{1,2})月(\\d{1,2})日`));
  return m ? toDate(m[1], m[2], m[3]) : null;
}

/** JAN（EAN-13）のチェックデジットが合うか。OCRの読み違いはここでほぼ弾ける */
function isValidJan(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const sum = digits
    .slice(0, 12)
    .reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/** 行の中から、チェックデジットの合う13桁を探す（前後に数字が続いていても拾う） */
function findJan(lines) {
  for (const line of lines) {
    for (const run of line.match(/\d{13,}/g) ?? []) {
      for (let i = 0; i + 13 <= run.length; i++) {
        const candidate = run.slice(i, i + 13);
        if (isValidJan(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * 入数と発注数量。帳票では「12X 1   2 C」と並ぶが、空白を消すと「12X12C」になる。
 * 入数の右側（内側の数）は1桁と決め打ちして切り分ける（実物はいつも「X 1」）。
 * 入数の左に商品名の容量がくっつく（「300ML12X」「30012X」）ことがあるので、
 * 3桁以上つながっていたら末尾2桁を入数とみなし、警告を付ける。
 */
function findQuantity(lines, warnings) {
  for (const line of lines) {
    const m = line.match(/(\d+)[XxＸ×](\d)(\d{1,3})[CcＣケ]/);
    if (!m) continue;
    let perCaseText = m[1];
    if (perCaseText.length > 2) {
      warnings.push(`入数の読み取りがあいまいです（"${perCaseText}X"）。末尾2桁を入数としました`);
      perCaseText = perCaseText.slice(-2);
    }
    const perCase = Number(perCaseText);
    const inner = Number(m[2]);
    const cases = Number(m[3]);
    if (!perCase || !inner || !cases) continue;
    return { perCase, inner, cases, quantity: perCase * inner * cases, line };
  }
  return null;
}

/** 納入倉庫の名前（＝得意先の支店名）。「納入倉庫」のあとの文字列 */
function findWarehouse(lines) {
  const idx = lines.findIndex((l) => l.includes('納入倉庫'));
  if (idx < 0) return { warehouse: null, office: null };
  const warehouse = lines[idx].split('納入倉庫')[1] || null;
  const office = lines[idx + 1]?.includes('営業所') ? lines[idx + 1] : null;
  return { warehouse, office };
}

/**
 * @param {string} text - OCRの生テキスト
 * @returns {{
 *   isKanakan: boolean, orderNumber: string|null, orderedOn: string|null,
 *   deliveryOn: string|null, warehouse: string|null, office: string|null,
 *   jan: string|null, perCase: number|null, inner: number|null, cases: number|null,
 *   quantity: number|null, productNameRaw: string|null,
 *   errors: string[], warnings: string[], missing: string[]
 * }}
 */
function parseKanakanOrder(text) {
  const lines = normalizeLines(text);
  const joined = lines.join('\n');
  const errors = [];
  const warnings = [];
  const missing = [];
  const fail = (field, message) => {
    missing.push(field);
    errors.push(message);
  };

  const isKanakan = isKanakanOrder(text);
  if (!isKanakan) fail('isKanakan', 'カナカンの発注書と判定できませんでした');

  const orderNumber = joined.match(/発注番号(\d{8})(?!\d)/)?.[1] ?? null;
  if (!orderNumber) fail('orderNumber', '発注番号（8桁）が読み取れませんでした');

  const orderedOn = findDate(joined, '発注日');
  if (!orderedOn) fail('orderedOn', '発注日が読み取れませんでした');

  const deliveryOn = findDate(joined, '入庫日');
  if (!deliveryOn) fail('deliveryOn', '入庫日が読み取れませんでした');

  const jan = findJan(lines);
  if (!jan) fail('jan', 'JANコード（チェックデジットの合う13桁）が読み取れませんでした');

  const qty = findQuantity(lines, warnings);
  if (!qty) fail('quantity', '入数・発注数量が読み取れませんでした');

  const { warehouse, office } = findWarehouse(lines);
  if (!warehouse) fail('warehouse', '納入倉庫（得意先）が読み取れませんでした');

  // 商品名は照合には使わない。人が確認するときの手がかりとして残すだけ
  const productNameRaw = qty ? qty.line.split(/\d+[XxＸ×]/)[0] || null : null;

  if (orderedOn && deliveryOn && deliveryOn < orderedOn) {
    warnings.push(`入庫日（${deliveryOn}）が発注日（${orderedOn}）より前になっています`);
  }

  return {
    isKanakan,
    orderNumber,
    orderedOn,
    deliveryOn,
    warehouse,
    office,
    jan,
    perCase: qty?.perCase ?? null,
    inner: qty?.inner ?? null,
    cases: qty?.cases ?? null,
    quantity: qty?.quantity ?? null,
    productNameRaw,
    errors,
    warnings,
    missing,
  };
}

module.exports = { parseKanakanOrder, isKanakanOrder, isValidJan, normalizeLines };
