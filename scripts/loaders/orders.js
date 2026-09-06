// 受注リスト → orders（フェーズ3-1）

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseInteger, parseNumber } = require('../lib/parseNumber');
const { parseDateOnly } = require('../lib/parseDate');
const { renumber } = require('../lib/legacyCode');

const INSERT_SQL = `
  INSERT INTO orders
    (order_no, legacy_order_no, line_no, ordered_on, customer_id, product_id, quantity, unit_price, markup_rate,
     sales_amount, shipping_fee, total_amount, requested_delivery_on, invoiced_on,
     payment_due_on, paid_on, sales_method, delivery_method, status, delivery_address,
     delivered_on, note)
  VALUES
    (@orderNo, @legacyOrderNo, @lineNo, @orderedOn, @customerId, @productId, @quantity, @unitPrice, @markupRate,
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
      const legacyOrderNo = (row['受注番号'] || '').trim();
      if (!legacyOrderNo) throw new Error('受注番号が空です');

      // 過去の受注番号は蒸留IDと同じ D 始まりで、実データで37件が完全に衝突していた。
      // 新規受注は既に O で採番しているので、過去分も O に揃える。元の番号は残す。
      const orderNo = renumber(legacyOrderNo, 'O');

      // 同じ受注番号が複数行あるときは明細行として並べる（1受注で複数商品）。
      // 実データには「同じ番号だが得意先が違う」行が6件あり、これは番号の付け間違い。
      // 落とさずに明細2行目として残し、レポートに出して移行後に直してもらう。
      context.counters.orderLines ??= new Map();
      const lineNo = (context.counters.orderLines.get(orderNo) ?? 0) + 1;
      context.counters.orderLines.set(orderNo, lineNo);

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
        legacyOrderNo,
        lineNo,
        orderedOn: parseDateOnly(row['受注日']),
        customerId,
        productId,
        quantity: parseInteger(row['本数'], '本数', { required: true }),
        unitPrice: parseNumber(row['単価'], '単価'),
        markupRate: parseNumber(row['掛け率'], '掛け率'),
        salesAmount: parseNumber(row['売価'], '売価'),
        shippingFee: (parseNumber(row['送料'], '送料') ?? 0),
        totalAmount: parseNumber(row['合計(税込)'], '合計(税込)'),
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
      // 他のシートは元の番号（D…）で受注を参照しているので、引き当ての表は元の番号で持つ。
      // 明細2行目以降は1行目のidを残す（受注1件としての参照先は先頭行）。
      const legacy = row['受注番号'].trim();
      if (!context.lookups.orderIdByOrderNo.has(legacy)) {
        context.lookups.orderIdByOrderNo.set(legacy, id);
      }
    },
  });
}

module.exports = { load };
