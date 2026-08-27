// 資材在庫変動履歴 → material_stock_ledger（フェーズ3-7、product_stock_ledgerの後に実行）

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO material_stock_ledger
    (history_code, txn_date, material_id, txn_type, quantity, counterparty,
     product_ledger_id, unit_price, total_price, data_kind, is_cancelled, note)
  VALUES
    (@historyCode, @txnDate, @materialId, @txnType, @quantity, @counterparty,
     @productLedgerId, @unitPrice, @totalPrice, @dataKind, @isCancelled, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '資材在庫変動履歴',
    csvFile: 'material_stock_ledger.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const txnType = (row['受払'] || '').trim();
      if (txnType !== '入荷' && txnType !== '消費') {
        throw new Error(`受払は「入荷」「消費」のいずれかである必要があります: "${row['受払']}"`);
      }

      const materialId = resolveId(context, {
        sheet: '資材在庫変動履歴',
        column: '資材名称', // 資材マスタでは「資材名」（6-1の表記ゆれ）
        rawValue: row['資材名称'],
        idMap: context.lookups.materialIdByName,
        required: true,
      });

      const historyCodeRaw = (row['商品履歴ID'] || '').trim();
      const productLedgerId = historyCodeRaw
        ? (context.lookups.productLedgerIdByHistoryCode.get(historyCodeRaw) ?? null)
        : null;
      if (historyCodeRaw && productLedgerId == null) {
        context.report.recordUnmatched('資材在庫変動履歴', '商品履歴ID', historyCodeRaw, historyCodeRaw);
      }

      const noteRaw = (row['備考'] || '').trim();
      const isCancelled = noteRaw.startsWith('取消済み') ? 1 : 0;
      const note = isCancelled ? noteRaw.replace(/^取消済み/, '').trim() || null : noteRaw || null;

      return {
        historyCode: row['資材履歴ID'] || null,
        txnDate: parseDateOnly(row['日付']),
        materialId,
        txnType,
        quantity: Number(row['数量']),
        counterparty: row['受入元/払出先'] || null,
        productLedgerId,
        unitPrice: row['単価'] ? Number(row['単価']) : null,
        totalPrice: row['合計金額'] ? Number(row['合計金額']) : null,
        dataKind: row['データ区分'] || null,
        isCancelled,
        note,
      };
    },
  });
}

module.exports = { load };
