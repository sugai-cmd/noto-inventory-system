// 蒸留明細記録 → distillation_details（フェーズ3-4）
// distillations・raw_sake_ledger 両方の投入完了後に実行する必要がある。

const { loadCsvTable, resolveId, resolveTankId } = require('../lib/loadHelper');

const INSERT_SQL = `
  INSERT INTO distillation_details
    (distillation_id, raw_sake_ledger_id, input_l, source_tank_id, is_cancelled, note)
  VALUES
    (@distillationId, @rawSakeLedgerId, @inputL, @sourceTankId, @isCancelled, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '蒸留明細記録',
    csvFile: 'distillation_details.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const distillationId = resolveId(context, {
        sheet: '蒸留明細記録',
        column: '蒸留ID',
        rawValue: row['蒸留ID'],
        idMap: context.lookups.distillationIdByCode,
        required: true,
      });
      const rawSakeLedgerId = resolveId(context, {
        sheet: '蒸留明細記録',
        column: '原酒受払ID',
        rawValue: row['原酒受払ID'],
        idMap: context.lookups.rawSakeLedgerIdByLotCode,
        required: true,
      });
      const sourceTankId = resolveTankId(context, {
        sheet: '蒸留明細記録',
        column: '元容器ID',
        rawValue: row['元容器ID'],
        required: false,
      });

      const noteRaw = (row['備考'] || '').trim();
      const isCancelled = noteRaw.startsWith('取消済み') ? 1 : 0;
      const note = isCancelled ? noteRaw.replace(/^取消済み/, '').trim() || null : noteRaw || null;

      return {
        distillationId,
        rawSakeLedgerId,
        inputL: Number(row['投入数量(L)']),
        sourceTankId,
        isCancelled,
        note,
      };
    },
  });
}

module.exports = { load };
