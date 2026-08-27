// 商品在庫変動履歴 → product_stock_ledger（フェーズ3-6）
// 受払の表記（棚卸調整（商品）等）をDDLのCHECK制約が期待する値
// （棚卸調整_商品 等）に変換する。商品履歴IDはafterInsertでlookupに登録し、
// material_stock_ledger・tank_ledgerからの参照解決に使う。

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');

const TXN_TYPE_MAP = {
  瓶詰: '瓶詰',
  箱詰: '箱詰',
  出荷: '出荷',
  返品: '返品',
  '棚卸調整（商品）': '棚卸調整_商品',
  '棚卸調整（仕掛品）': '棚卸調整_仕掛品',
  '欠損（商品）': '欠損_商品',
  '欠損（仕掛品）': '欠損_仕掛品',
};

const INSERT_SQL = `
  INSERT INTO product_stock_ledger
    (history_code, txn_date, product_id, txn_type, quantity, counterparty, order_id,
     volume_ml, tax_amount, storage_place, data_kind, is_cancelled, note)
  VALUES
    (@historyCode, @txnDate, @productId, @txnType, @quantity, @counterparty, @orderId,
     @volumeMl, @taxAmount, @storagePlace, @dataKind, @isCancelled, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '商品在庫変動履歴',
    csvFile: 'product_stock_ledger.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const txnType = TXN_TYPE_MAP[(row['受払'] || '').trim()];
      if (!txnType) throw new Error(`受払の値を解釈できません: "${row['受払']}"`);

      const productId = resolveId(context, {
        sheet: '商品在庫変動履歴',
        column: '商品', // このシートだけ「商品名称」ではなく「商品」表記（6-1）
        rawValue: row['商品'],
        idMap: context.lookups.productIdByName,
        required: true,
      });

      // 受注番号(L列)は移行期の列で過去データには存在しないことがある（6-3）。
      // あればordersと突合し、なければNULLのまま許容する。
      const orderNoRaw = (row['受注番号'] || '').trim();
      const orderId = orderNoRaw ? (context.lookups.orderIdByOrderNo.get(orderNoRaw) ?? null) : null;
      if (orderNoRaw && orderId == null) {
        context.report.recordUnmatched('商品在庫変動履歴', '受注番号', orderNoRaw, orderNoRaw);
      }

      const noteRaw = (row['備考'] || '').trim();
      const isCancelled = noteRaw.startsWith('取消済み') ? 1 : 0;
      const note = isCancelled ? noteRaw.replace(/^取消済み/, '').trim() || null : noteRaw || null;

      return {
        historyCode: row['商品履歴ID'] || null,
        txnDate: parseDateOnly(row['日付']),
        productId,
        txnType,
        quantity: Number(row['数量']),
        counterparty: row['受入元/払出先'] || null,
        orderId,
        volumeMl: row['容量(ml)'] ? Number(row['容量(ml)']) : null,
        taxAmount: row['課税額'] ? Number(row['課税額']) : null,
        storagePlace: row['保管場所'] || null,
        dataKind: row['データ区分'] || null,
        isCancelled,
        note,
      };
    },
    afterInsert(row, id, context) {
      const historyCode = (row['商品履歴ID'] || '').trim();
      if (historyCode) context.lookups.productLedgerIdByHistoryCode.set(historyCode, id);
    },
  });
}

module.exports = { load };
