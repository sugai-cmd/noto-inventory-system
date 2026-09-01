// 委託販売実績報告 → consignment_reports（フェーズ3-9、ordersの後に実行）

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseDateOnly, parseMonthOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO consignment_reports
    (order_id, report_month, customer_id, product_id, quantity, unit_price, markup_rate,
     sales_amount, shipping_fee, invoiced_on, payment_due_on, paid_on, note)
  VALUES
    (@orderId, @reportMonth, @customerId, @productId, @quantity, @unitPrice, @markupRate,
     @salesAmount, @shippingFee, @invoicedOn, @paymentDueOn, @paidOn, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '委託販売実績報告',
    csvFile: 'consignment_reports.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const orderNo = (row['受注番号'] || '').trim();
      const orderId = context.lookups.orderIdByOrderNo.get(orderNo) ?? null;
      if (orderNo && orderId == null) {
        context.report.recordUnmatched('委託販売実績報告', '受注番号', orderNo, orderNo);
        throw new Error(`受注番号「${orderNo}」が受注リストに見つかりません`);
      }
      if (!orderNo) throw new Error('受注番号が空です');

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
        orderId,
        reportMonth: parseMonthOnly(row['対象月']),
        customerId,
        productId,
        quantity: Number(row['本数']),
        unitPrice: row['単価'] ? Number(row['単価']) : null,
        markupRate: row['掛け率'] ? Number(row['掛け率']) : null,
        salesAmount: row['売価'] ? Number(row['売価']) : null,
        shippingFee: row['送料'] ? Number(row['送料']) : null,
        invoicedOn: parseDateOnly(row['請求日']),
        paymentDueOn: parseDateOnly(row['入金予定日']),
        paidOn: parseDateOnly(row['入金日']),
        note: row['備考'] || null,
      };
    },
  });
}

module.exports = { load };
