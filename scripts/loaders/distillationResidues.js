// 残渣回収記録 → distillation_residues（フェーズ3-5）
// 「残渣回収日」も日時混在列のため collected_on / collected_time に分離する。

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
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
      if (!collectedOn || !collectedTime) {
        throw new Error(`残渣回収日から日付・時刻の両方を取得できません: "${row['残渣回収日']}"`);
      }

      return {
        distillationId,
        collectedOn,
        collectedTime,
        quantity: row['回収量'] ? Number(row['回収量']) : null,
        abv: row['アルコール度数'] ? Number(row['アルコール度数']) : null,
        saltStatus: row['食塩ステータス'] || null,
        saltInputQty: row['投入量'] ? Number(row['投入量']) : null,
        saltConcentration: row['塩分濃度'] ? Number(row['塩分濃度']) : null,
        destination: row['払出先'] || null,
      };
    },
  });
}

module.exports = { load };
