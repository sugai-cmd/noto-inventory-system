// 得意先マスタ → customers（フェーズ1）

const { parsePaymentTermMonths } = require('../../src/utils/paymentTerm');
const { loadCsvTable, existingByCodeOrName } = require('../lib/loadHelper');
const { parseNumber } = require('../lib/parseNumber');
const { parseDateOnly, parseMonthOnly } = require('../lib/parseDate');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO customers
    (uid, code, name, segment, business_type, markup_rate, address,
     payment_term_months, payment_term_day, invoice_due_note,
     sales_rep, sales_sub_rep, sales_channel, last_visited_on, onboarded_month, note)
  VALUES
    (@uid, @code, @name, @segment, @businessType, @markupRate, @address,
     @paymentTermMonths, @paymentTermDay, @invoiceDueNote,
     @salesRep, @salesSubRep, @salesChannel, @lastVisitedOn, @onboardedMonth, @note)
`;

// 既に同じ名前の行があるときは、シートの内容で更新する。
// 在庫計算の起点になる列（初期在庫など）は当てない（createOnlyKeys で外す）。
const UPDATE_SQL = `
  UPDATE customers SET
       name = @name,
       code = COALESCE(@code, code), segment = @segment, business_type = @businessType,
       markup_rate = @markupRate, address = @address,
       payment_term_months = @paymentTermMonths, payment_term_day = @paymentTermDay,
       invoice_due_note = @invoiceDueNote, sales_rep = @salesRep, sales_sub_rep = @salesSubRep,
       sales_channel = @salesChannel, last_visited_on = @lastVisitedOn,
       onboarded_month = @onboardedMonth, note = @note, updated_at = datetime('now')
  WHERE id = @id
`;

/**
 * 「本店」列を、名前から親のIDに紐付ける（取り込みの2周目）。
 * 本店の行がCSVの後ろにあっても引けるよう、全行を入れ終わってから実行する。
 * シートにこの列が無ければ何もしない（移行後に画面から設定する運用）。
 */
function linkParents(ctx, rows) {
  const withParent = rows.filter((r) => (r['本店'] || '').trim());
  if (!withParent.length) return;

  const byName = new Map(
    ctx.db.prepare('SELECT id, name FROM customers').all()
      .map((c) => [ctx.normalize(c.name), c.id])
  );
  const update = ctx.db.prepare('UPDATE customers SET parent_id = ? WHERE id = ?');

  for (const row of withParent) {
    const selfId = byName.get(ctx.normalize(row['得意先名']));
    const parentId = byName.get(ctx.normalize(row['本店']));
    if (parentId == null) {
      ctx.report.recordUnmatched('得意先マスタ', '本店', row['本店'], ctx.normalize(row['本店']));
      continue;
    }
    if (selfId != null && parentId !== selfId) update.run(parentId, selfId);
  }
}

function load(ctx) {
  const seen = [];

  loadCsvTable(ctx, {
    sheetName: '得意先マスタ',
    csvFile: 'customers.csv',
    insertSql: INSERT_SQL,
    updateSql: UPDATE_SQL,
    updateTable: 'customers',
    createOnlyKeys: ['uid'],
    findExistingId: existingByCodeOrName('customers', '顧客ID', '得意先名'),
    mapRow(row) {
      const name = (row['得意先名'] || '').trim();
      if (!name) throw new Error('得意先名が空です');

      return {
        uid: generateUid(ctx.db, 'customers'),
        code: row['顧客ID'] || null,
        name,
        segment: row['区分'] || null,
        businessType: row['業態'] || null,
        // 空欄は空欄のまま入れる。1.0（上代どおり）は消費者向けで実在する値なので、
        // 空を1で埋めてしまうと「まだ決めていない」支店が上代どおりに見えてしまい、
        // 本店から掛率を引き継げなくなる（0014のコメント参照）。
        markupRate: parseNumber(row['掛率'], '掛率'),
        address: row['住所'] || null,
        // 「当月」「翌月」「翌々月」で入っているので月数に読み替える。
        // Number()のままだとNaNになり、支払いサイトが黙って全件失われる。
        paymentTermMonths: parsePaymentTermMonths(row['支払いサイト月数']).months,
        paymentTermDay: row['支払いサイト日付'] || null,
        invoiceDueNote: row['請求日送付期日'] || null,
        salesRep: row['担当者'] || null,
        salesSubRep: row['サブ担当者'] || null,
        salesChannel: row['流通経路'] || null,
        lastVisitedOn: parseDateOnly(row['最終訪問日']),
        onboardedMonth: parseMonthOnly(row['取引開始月']),
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.customerIdByName.set(context.normalize(row['得意先名']), id);
      seen.push({ 得意先名: row['得意先名'], 本店: row['本店'] });
    },
  });

  linkParents(ctx, seen);
}

module.exports = { load };
