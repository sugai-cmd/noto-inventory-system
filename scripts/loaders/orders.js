// 受注リスト → orders（フェーズ3-1）

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO orders
    (order_no, ordered_on, customer_id, product_id, quantity, unit_price, markup_rate,
     sales_amount, shipping_fee, total_amount, requested_delivery_on, invoiced_on,
     payment_due_on, paid_on, sales_method, delivery_method, status, delivery_address,
     delivered_on, note)
  VALUES
    (@orderNo, @orderedOn, @customerId, @productId, @quantity, @unitPrice, @markupRate,
     @salesAmount, @shippingFee, @totalAmount, @requestedDeliveryOn, @invoicedOn,
     @paymentDueOn, @paidOn, @salesMethod, @deliveryMethod, @status, @deliveryAddress,
     @deliveredOn, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '受注リスト',
    csvFile: 'orders.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const orderNo = (row['受注番号'] || '').trim();
      if (!orderNo) throw new Error('受注番号が空です');

      const customerId = resolveId(context, {
        sheet: '受注リスト',
        column: '得意先名',
        rawValue: row['得意先名'],
        idMap: context.lookups.customerIdByName,
        required: true,
      });
      const productId = resolveId(context, {
        sheet: '受注リスト',
        column: '商品名',
        rawValue: row['商品名'],
        idMap: context.lookups.productIdByName,
        required: true,
      });

      return {
        orderNo,
        orderedOn: parseDateOnly(row['受注日']),
        customerId,
        productId,
        quantity: Number(row['本数']),
        unitPrice: row['単価'] ? Number(row['単価']) : null,
        markupRate: row['掛け率'] ? Number(row['掛け率']) : null,
        salesAmount: row['売価'] ? Number(row['売価']) : null,
        shippingFee: row['送料'] ? Number(row['送料']) : 0,
        totalAmount: row['合計(税込)'] ? Number(row['合計(税込)']) : null,
        requestedDeliveryOn: parseDateOnly(row['納入希望日']),
        invoicedOn: parseDateOnly(row['請求日']),
        paymentDueOn: parseDateOnly(row['入金予定日']),
        paidOn: parseDateOnly(row['入金日']),
        salesMethod: row['販売方法'] || null,
        deliveryMethod: row['納品方法'] || null,
        status: row['ステータス'] || '未着手',
        deliveryAddress: row['配送先'] || null,
        deliveredOn: parseDateOnly(row['納品日（発送日、配達日）']),
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.orderIdByOrderNo.set(row['受注番号'].trim(), id);
    },
  });
}

module.exports = { load };
