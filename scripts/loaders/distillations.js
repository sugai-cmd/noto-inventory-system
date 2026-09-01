// 蒸留記録 → distillations（フェーズ3-2）
// 「蒸留日」は日時混在列のため、2.0の方針に従い started_on / started_time に分離する。
// シートには完了日時そのものの列がないため、completed_on / completed_time は
// 移行時点ではNULLのまま（新アプリ運用開始後に完了処理で埋まる想定）。

const { loadCsvTable, resolveTankId } = require('../lib/loadHelper');
const { parseDateTimeParts } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO distillations
    (distillation_code, started_on, started_time, input_summary, total_input_l,
     planned_duration, status, output_l, output_abv, output_tank_id, residue_qty)
  VALUES
    (@distillationCode, @startedOn, @startedTime, @inputSummary, @totalInputL,
     @plannedDuration, @status, @outputL, @outputAbv, @outputTankId, @residueQty)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '蒸留記録',
    csvFile: 'distillations.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const distillationCode = (row['蒸留ID'] || '').trim();
      if (!distillationCode) throw new Error('蒸留IDが空です');

      const { date: startedOn, time: startedTime } = parseDateTimeParts(row['蒸留日']);
      if (!startedOn || !startedTime) {
        throw new Error(`蒸留日から日付・時刻の両方を取得できません: "${row['蒸留日']}"`);
      }

      const outputTankId = resolveTankId(context, {
        sheet: '蒸留記録',
        column: '払出先',
        rawValue: row['払出先'],
        required: false,
      });

      return {
        distillationCode,
        startedOn,
        startedTime,
        inputSummary: row['使用原酒明細'] || null,
        totalInputL: row['投入量合計'] ? Number(row['投入量合計']) : null,
        plannedDuration: row['蒸留設定時間'] || null,
        status: row['ステータス'] || '蒸留中',
        outputL: row['蒸留量'] ? Number(row['蒸留量']) : null,
        outputAbv: row['アルコール度数'] ? Number(row['アルコール度数']) : null,
        outputTankId,
        residueQty: row['残渣回収量'] ? Number(row['残渣回収量']) : null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.distillationIdByCode.set(row['蒸留ID'].trim(), id);
    },
  });
}

module.exports = { load };
