// 残渣回収記録 → distillation_residues（フェーズ3-5）
// 「残渣回収日」も日時混在列のため collected_on / collected_time に分離する。

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseNumber } = require('../lib/parseNumber');
const { parseDateTimeParts } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO distillation_residues
    (distillation_id, collected_on, collected_time, quantity, abv,
     salt_status, salt_input_qty, salt_concentration, destination)
  VALUES
    (@distillationId, @collectedOn, @collectedTime, @quantity, @abv,
     @saltStatus, @saltInputQty, @saltConcentration, @destination)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '残渣回収記録',
    csvFile: 'distillation_residues.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const distillationId = resolveId(context, {
        sheet: '残渣回収記録',
        column: '蒸留ID',
        rawValue: row['蒸留ID'],
        idMap: context.lookups.distillationIdByCode,
        required: true,
      });

      const { date: collectedOn, time: collectedTime } = parseDateTimeParts(row['残渣回収日']);
      if (!collectedOn) {
        throw new Error(`残渣回収日を読み取れません: "${row['残渣回収日']}"`);
      }

      return {
        distillationId,
        collectedOn,
        // 実データの残渣回収日は日付だけ。collected_time はNOT NULLなので 00:00 で埋める
        // （蒸留記録の投入開始時刻と同じ扱い）。
        collectedTime: collectedTime ?? '00:00',
        quantity: parseNumber(row['回収量'], '回収量'),
        abv: parseNumber(row['アルコール度数'], 'アルコール度数'),
        saltStatus: row['食塩ステータス'] || null,
        saltInputQty: parseNumber(row['投入量'], '投入量'),
        saltConcentration: parseNumber(row['塩分濃度'], '塩分濃度'),
        destination: row['払出先'] || null,
      };
    },
  });
}

module.exports = { load };
