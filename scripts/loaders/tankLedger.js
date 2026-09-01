// 浄酎容器変動履歴 → tank_ledger（フェーズ3-8、product_stock_ledger・distillationsの後に実行）

const { loadCsvTable, resolveId, resolveTankId } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');

const VALID_TXN_TYPES = new Set(['継足', '瓶詰', '容器移動', '未納税移出', '欠減', '棚卸調整', '取消戻し']);

const INSERT_SQL = `
  INSERT INTO tank_ledger
    (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
     product_ledger_id, distillation_id, data_kind, is_cancelled, note)
  VALUES
    (@txnDate, @fromTankId, @txnType, @productId, @toTankId, @quantityL, @abv,
     @productLedgerId, @distillationId, @dataKind, @isCancelled, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '浄酎容器変動履歴',
    csvFile: 'tank_ledger.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const txnType = (row['受払'] || '').trim();
      if (!VALID_TXN_TYPES.has(txnType)) {
        throw new Error(`受払の値を解釈できません: "${row['受払']}"`);
      }

      const fromTankId = resolveTankId(context, {
        sheet: '浄酎容器変動履歴',
        column: '受入元',
        rawValue: row['受入元'],
        required: false,
      });
      const toTankId = resolveTankId(context, {
        sheet: '浄酎容器変動履歴',
        column: '払出先',
        rawValue: row['払出先'],
        required: false,
      });

      const productId = row['瓶詰め商品']
        ? resolveId(context, {
            sheet: '浄酎容器変動履歴',
            column: '瓶詰め商品',
            rawValue: row['瓶詰め商品'],
            idMap: context.lookups.productIdByName,
            required: false,
          })
        : null;

      const historyCodeRaw = (row['商品履歴ID'] || '').trim();
      const productLedgerId = historyCodeRaw
        ? (context.lookups.productLedgerIdByHistoryCode.get(historyCodeRaw) ?? null)
        : null;
      if (historyCodeRaw && productLedgerId == null) {
        context.report.recordUnmatched('浄酎容器変動履歴', '商品履歴ID', historyCodeRaw, historyCodeRaw);
      }

      const distillationCodeRaw = (row['蒸留ID'] || '').trim();
      const distillationId = distillationCodeRaw
        ? (context.lookups.distillationIdByCode.get(distillationCodeRaw) ?? null)
        : null;
      if (distillationCodeRaw && distillationId == null) {
        context.report.recordUnmatched('浄酎容器変動履歴', '蒸留ID', distillationCodeRaw, distillationCodeRaw);
      }

      const noteRaw = (row['備考'] || '').trim();
      const isCancelled = noteRaw.startsWith('取消済み') ? 1 : 0;
      let note = isCancelled ? noteRaw.replace(/^取消済み/, '').trim() || null : noteRaw || null;
      // 「直接充填」等、タンクとして解決できなかった払出先はnoteに退避する（DDL 2章の設計通り）
      if (row['払出先'] && toTankId == null) {
        note = [note, `払出先(原文): ${row['払出先']}`].filter(Boolean).join(' / ');
      }

      return {
        txnDate: parseDateOnly(row['日付']),
        fromTankId,
        txnType,
        productId,
        toTankId,
        quantityL: Number(row['数量(L)']),
        abv: row['アルコール度数'] ? Number(String(row['アルコール度数']).replace('%', '')) : null,
        productLedgerId,
        distillationId,
        dataKind: row['データ区分'] || null,
        isCancelled,
        note,
      };
    },
  });
}

module.exports = { load };
