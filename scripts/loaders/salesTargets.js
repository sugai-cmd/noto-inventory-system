// 売上目標 → sales_targets（フェーズ3-11、依存なし）

const { loadCsvTable } = require('../lib/loadHelper');
const { parseMonthOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO sales_targets (target_month, target_amount, note)
  VALUES (@targetMonth, @targetAmount, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '売上目標',
    csvFile: 'sales_targets.csv',
    insertSql: INSERT_SQL,
    mapRow(row) {
      const targetMonth = parseMonthOnly(row['対象月']);
      if (!targetMonth) throw new Error('対象月が空です');

      return {
        targetMonth,
        targetAmount: Number(row['目標売上高']),
        note: row['備考'] || null,
      };
    },
  });
}

module.exports = { load };
