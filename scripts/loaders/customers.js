// 得意先マスタ → customers（フェーズ1）

const { parsePaymentTermMonths } = require('../../src/utils/paymentTerm');
const { loadCsvTable, existingByName } = require('../lib/loadHelper');
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

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '得意先マスタ',
    csvFile: 'customers.csv',
    insertSql: INSERT_SQL,
    findExistingId: existingByName('customers', '得意先名'),
    mapRow(row) {
      const name = (row['得意先名'] || '').trim();
      if (!name) throw new Error('得意先名が空です');

      return {
        uid: generateUid(ctx.db, 'customers'),
        code: row['顧客ID'] || null,
        name,
        segment: row['区分'] || null,
        businessType: row['業態'] || null,
        markupRate: row['掛率'] ? Number(row['掛率']) : 1,
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
    },
  });
}

module.exports = { load };
