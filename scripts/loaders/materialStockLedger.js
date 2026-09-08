// 資材在庫変動履歴 → material_stock_ledger（フェーズ3-7、product_stock_ledgerの後に実行）

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseInteger, parseNumber } = require('../lib/parseNumber');
const { parseDateOnly } = require('../lib/parseDate');
const { dedupeCode } = require('../lib/legacyCode');

// material_stock_ledger.txn_type の CHECK と同じ並び（0003）。
// DBが受ける区分と、取り込みが受ける区分をずらさないこと。
const VALID_TXN_TYPES = new Set(['入荷', '消費', '棚卸調整', '欠損']);

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
      // 同じ資材履歴IDを持つ行が実データにある（採番の競合と、まったく同じ行の二重記録）。
      // 番号はUNIQUEなので2件目が落ちるが、落とすと在庫の動きが1件消える。
      // 番号に枝番を付けて行は残し、何が起きたかをレポートに出す。
      const { code: dedupedCode, duplicated } = dedupeCode(
        context.counters, 'material', (row['資材履歴ID'] || '').trim() || null
      );
      if (duplicated) {
        context.report.recordError(
          '資材在庫変動履歴', rowNumber,
          `資材履歴ID「${row['資材履歴ID']}」が重複していたため ${dedupedCode} として取り込みました`
        );
      }
      // 0003 で棚卸に対応したとき、DBは「棚卸調整」「欠損」も受けるようにしたのに、
      // ここの判定が「入荷」「消費」のままだった。実データに26行あり、
      // 在庫の増減がそのぶん丸ごと落ちていた（v_material_stock も両方を計算に入れている）。
      const txnType = (row['受払'] || '').trim();
      if (!VALID_TXN_TYPES.has(txnType)) {
        throw new Error(
          `受払は「${[...VALID_TXN_TYPES].join('」「')}」のいずれかである必要があります: "${row['受払']}"`
        );
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
        historyCode: dedupedCode,
        txnDate: parseDateOnly(row['日付']),
        materialId,
        txnType,
        quantity: parseInteger(row['数量'], '数量', { required: true }),
        counterparty: row['受入元/払出先'] || null,
        productLedgerId,
        unitPrice: parseNumber(row['単価'], '単価'),
        totalPrice: parseNumber(row['合計金額'], '合計金額'),
        dataKind: row['データ区分'] || null,
        isCancelled,
        note,
      };
    },
  });
}

module.exports = { load };
