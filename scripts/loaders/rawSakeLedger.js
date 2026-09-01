// 原料受払記録 → raw_sake_ledger（フェーズ3-3）
//
// DATA_STRUCTURE.md 4-9の通り「受入元」「払出先」は受払の種類によって意味が変わる列：
//   払出（蒸留への投入）: 受入元=投入元タンク、払出先=蒸留ID
//   受入（原酒入荷/蒸留完了による充填）: 払出先=受入先タンク（受入元は仕入元等の自由記述の可能性があり、タンク名としては解決しない）
// 2.1のA案の通り、種類ごとに専用列（from_tank_id / to_tank_id / distillation_id）へ分解する。
//
// 原酒マスタとの紐付けは8-2の決定によりraw_sake_brand_idは常にNULL。
// 原酒スペックの自由記述はspec_noteにそのまま退避する。

const { loadCsvTable, resolveId, resolveTankId } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO raw_sake_ledger
    (lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
     quantity, raw_sake_brand_id, spec_note, is_fifo_estimated, note)
  VALUES
    (@lotCode, @txnDate, @txnType, @fromTankId, @toRef, @toTankId, @distillationId,
     @quantity, NULL, @specNote, @isFifoEstimated, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '原料受払記録',
    csvFile: 'raw_sake_ledger.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const lotCode = (row['原酒受払ID'] || '').trim() || null;
      const txnType = (row['受払'] || '').trim();
      if (txnType !== '受入' && txnType !== '払出') {
        throw new Error(`受払は「受入」「払出」のいずれかである必要があります: "${row['受払']}"`);
      }

      let fromTankId = null;
      let toTankId = null;
      let distillationId = null;

      if (txnType === '払出') {
        fromTankId = resolveTankId(context, {
          sheet: '原料受払記録',
          column: '受入元(投入元タンク)',
          rawValue: row['受入元'],
          required: false,
        });
        distillationId = resolveId(context, {
          sheet: '原料受払記録',
          column: '払出先(蒸留ID)',
          rawValue: row['払出先'],
          idMap: context.lookups.distillationIdByCode,
          required: false,
        });
      } else {
        toTankId = resolveTankId(context, {
          sheet: '原料受払記録',
          column: '払出先(受入先タンク)',
          rawValue: row['払出先'],
          required: false,
        });
      }

      return {
        lotCode,
        txnDate: parseDateOnly(row['日付']),
        txnType,
        fromTankId,
        toRef: row['払出先'] || null, // 正規化できなかった場合のフォールバック用に原文も残す
        toTankId,
        distillationId,
        quantity: Number(row['受払量']),
        specNote: row['原酒スペック'] || null,
        isFifoEstimated: row['FIFO推定'] ? 1 : 0,
        note: txnType === '受入' && row['受入元'] ? `受入元: ${row['受入元']}` : null,
      };
    },
    afterInsert(row, id, context) {
      const lotCode = (row['原酒受払ID'] || '').trim();
      if (lotCode) context.lookups.rawSakeLedgerIdByLotCode.set(lotCode, id);
    },
  });
}

module.exports = { load };
