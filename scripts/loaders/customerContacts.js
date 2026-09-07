// 顧客リスト → customers の連絡先列（フェーズ1、得意先マスタの後）
//
// 得意先の情報は2つのシートに分かれている。
//   得意先マスタ（156行）… 顧客ID・掛率・支払いサイト。受注が実際に参照している正本
//   顧客リスト（90行）  … メール・電話・郵便番号・担当者。営業側で管理している表
// 掛け率と請求／入金の期日は**得意先マスタを正とする**。
// 顧客リストの掛け率は 60 / 80 の％表記で、マスタの 0.6 / 0.8 とは別物なので取り込まない。
//
// 新しい行は作らない。得意先マスタに無い名前は名寄せ不一致として報告するだけにする
// （営業用の表にしか無い先を得意先マスタへ勝手に増やさない）。

const path = require('node:path');
const { readCsv } = require('../lib/csvReader');
const { resolveId, SkipRow } = require('../lib/loadHelper');
const { aliasesForSheet, aliasRow } = require('../lib/columnAliases');
const { parseDateOnly } = require('../lib/parseDate');

const SHEET = '顧客リスト';

const UPDATE_SQL = `
  UPDATE customers SET
    postal_code        = COALESCE(@postalCode, postal_code),
    phone              = COALESCE(@phone, phone),
    invoice_email      = COALESCE(@invoiceEmail, invoice_email),
    invoice_contact    = COALESCE(@invoiceContact, invoice_contact),
    order_email        = COALESCE(@orderEmail, order_email),
    order_phone        = COALESCE(@orderPhone, order_phone),
    order_contact      = COALESCE(@orderContact, order_contact),
    sales_type         = COALESCE(@salesType, sales_type),
    last_ordered_on    = COALESCE(@lastOrderedOn, last_ordered_on),
    first_contacted_on = COALESCE(@firstContactedOn, first_contacted_on),
    contract_signed_on = COALESCE(@contractSignedOn, contract_signed_on),
    updated_at         = datetime('now')
  WHERE id = @id
`;

// 「次回todo/課題」は列ではなく営業メモとして持つ（種別はGAS版のプルダウンに合わせる）
//
// 営業メモは --reset の対象ではない（手で書いたメモを消せない）ので、
// 流し直すたびに同じ課題が積み上がらないよう、同じ内容が既にあれば入れない。
const NOTE_SQL = `
  INSERT INTO customer_notes (customer_id, noted_on, category, body)
  SELECT @customerId, @notedOn, '課題', @body
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_notes
     WHERE customer_id = @customerId AND category = '課題' AND body = @body
  )
`;

function load(ctx) {
  const summary = ctx.report.touchSummary(SHEET);
  const rows = readCsv(path.join(ctx.dataDir, 'customer_list.csv'));
  if (rows === null) {
    console.warn(`[skip] customer_list.csv が見つからないため「${SHEET}」の取り込みをスキップします`);
    return;
  }

  const aliases = aliasesForSheet(SHEET);
  const update = ctx.db.prepare(UPDATE_SQL);
  const addNote = ctx.db.prepare(NOTE_SQL);
  const blank = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

  rows.forEach((rawRow, i) => {
    const row = aliasRow(rawRow, aliases);
    summary.read++;
    const rowNumber = i + 2;

    const name = blank(row['得意先']);
    if (!name) {
      // 得意先名が空の行（シートの余白や小計行）。数だけ数えて中身を残さないと、
      // 「スキップ47」と出ているのにどの47行か調べようがなくなる。
      ctx.report.recordSkip(SHEET, rowNumber, '得意先名が空欄です', blank(row['No.']) ?? '');
      summary.skipped++;
      return;
    }

    // 名寄せは他のシートと同じ仕組みを通す（aliases.json の別名と __ignore__ が効く）
    let id;
    try {
      id = resolveId(ctx, {
        sheet: SHEET,
        column: '得意先',
        rawValue: name,
        idMap: ctx.lookups.customerIdByName,
        required: false,
      });
    } catch (e) {
      if (e instanceof SkipRow) {
        summary.ignored = (summary.ignored ?? 0) + 1;
        return;
      }
      throw e;
    }
    if (id == null) {
      // 名寄せできなかった分は resolveId が unmatched-names.csv に記録済み。
      // どの行だったかはこちらで残す（得意先マスタに無い先は勝手に増やさない方針）。
      ctx.report.recordSkip(SHEET, rowNumber, '得意先マスタに無い名前です', name);
      summary.skipped++;
      return;
    }

    try {
      update.run({
        id,
        postalCode: blank(row['郵便番号']),
        phone: blank(row['電話番号']),
        invoiceEmail: blank(row['メールアドレス（請求書送付先）']),
        invoiceContact: blank(row['担当者氏名（請求書）']),
        orderEmail: blank(row['メールアドレス（発注者、進行案件窓口）']),
        orderPhone: blank(row['電話番号（発注者、進行案件窓口）']),
        orderContact: blank(row['担当者氏名（発注者、進行案件窓口）']),
        salesType: blank(row['販売形態']),
        lastOrderedOn: parseDateOnly(row['最終注文日']),
        firstContactedOn: parseDateOnly(row['初回接触日']),
        contractSignedOn: parseDateOnly(row['売買契約書締結日']),
      });
      summary.inserted++;

      const todo = blank(row['次回todo/課題']);
      if (todo) {
        addNote.run({
          customerId: id,
          notedOn: parseDateOnly(row['最新訪問日']) ?? new Date().toISOString().slice(0, 10),
          body: todo,
        });
      }
    } catch (e) {
      ctx.report.recordError(SHEET, rowNumber, e.message);
      summary.skipped++;
    }
  });
}

module.exports = { load };
