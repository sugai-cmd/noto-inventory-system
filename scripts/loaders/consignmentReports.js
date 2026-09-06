// 委託販売実績報告 → consignment_reports（フェーズ3-9、ordersの後に実行）
//
// シートの「受注番号」列に入っているのは C2606-0001 のような**この報告自身の番号**で、
// 受注リストの受注番号ではない（実データ18件すべてC始まりで、得意先と商品の
// 組み合わせも受注リストに無いものが多い）。
// そのため報告番号として report_no に持ち、受注への紐付けは
// たまたま同じ番号の受注があるときだけにする。

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseInteger, parseNumber } = require('../lib/parseNumber');
const { parseDateOnly, parseMonthOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO consignment_reports
    (report_no, order_id, report_month, customer_id, product_id, quantity, unit_price, markup_rate,
     sales_amount, shipping_fee, invoiced_on, payment_due_on, paid_on, note)
  VALUES
    (@reportNo, @orderId, @reportMonth, @customerId, @productId, @quantity, @unitPrice, @markupRate,
     @salesAmount, @shippingFee, @invoicedOn, @paymentDueOn, @paidOn, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '委託販売実績報告',
    csvFile: 'consignment_reports.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const reportNo = (row['受注番号'] || '').trim() || null;
      if (!reportNo) throw new Error('受注番号（報告番号）が空です');
      // 受注リストに同じ番号があれば紐付ける。無いのが普通なので、無くても止めない。
      const orderId = context.lookups.orderIdByOrderNo.get(reportNo) ?? null;

      const customerId = resolveId(context, {
        sheet: '委託販売実績報告',
        column: '得意先名',
        rawValue: row['得意先名'],
        idMap: context.lookups.customerIdByName,
        required: true,
      });
      const productId = resolveId(context, {
        sheet: '委託販売実績報告',
        column: '商品名',
        rawValue: row['商品名'],
        idMap: context.lookups.productIdByName,
        required: true,
      });

      return {
        reportNo,
        orderId,
        reportMonth: parseMonthOnly(row['対象月']),
        customerId,
        productId,
        quantity: parseInteger(row['本数'], '本数', { required: true }),
        unitPrice: parseNumber(row['単価'], '単価'),
        markupRate: parseNumber(row['掛け率'], '掛け率'),
        salesAmount: parseNumber(row['売価'], '売価'),
        shippingFee: parseNumber(row['送料'], '送料'),
        invoicedOn: parseDateOnly(row['請求日']),
        paymentDueOn: parseDateOnly(row['入金予定日']),
        paidOn: parseDateOnly(row['入金日']),
        note: row['備考'] || null,
      };
    },
  });
}

module.exports = { load };
