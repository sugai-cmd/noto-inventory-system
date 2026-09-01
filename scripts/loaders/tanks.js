// タンクマスタ → tanks（フェーズ1）
// 現在液量・理論アルコール度数は本来 v_tank_monitor で再計算する値だが、
// 移行直後にビューが正しく積み上がるよう、シート最終値を initial_volume_l /
// current_abv の「初期値」としてそのまま投入する（tank_ledgerの移行が完了すれば
// 以降はビュー側の再計算値と一致するはずなので、ズレはそのまま検算材料にもなる）。

const { loadCsvTable, existingByName } = require('../lib/loadHelper');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO tanks
    (uid, code, name, container_type, max_volume_l, location, status,
     gauge_constant, initial_volume_l, current_volume_l, current_abv, note)
  VALUES
    (@uid, @code, @name, @containerType, @maxVolumeL, @location, @status,
     @gaugeConstant, @initialVolumeL, @currentVolumeL, @currentAbv, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: 'タンクマスタ',
    csvFile: 'tanks.csv',
    insertSql: INSERT_SQL,
    findExistingId: existingByName('tanks', '容器名称'),
    mapRow(row) {
      const code = (row['容器ID'] || '').trim();
      const name = (row['容器名称'] || '').trim();
      if (!code) throw new Error('容器IDが空です');
      if (!name) throw new Error('容器名称が空です');

      const initialVolumeL = row['初期在庫量'] ? Number(row['初期在庫量']) : 0;

      return {
        uid: generateUid(ctx.db, 'tanks'),
        code,
        name,
        containerType: row['容器種別'] || null,
        maxVolumeL: row['最大容量(L)'] ? Number(row['最大容量(L)']) : null,
        location: row['現在設置場所'] || null,
        status: row['ステータス'] || null,
        gaugeConstant: row['検尺定数'] ? Number(row['検尺定数']) : null,
        initialVolumeL,
        currentVolumeL: row['現在液量(L)'] ? Number(row['現在液量(L)']) : initialVolumeL,
        currentAbv: row['理論アルコール度数'] ? Number(row['理論アルコール度数']) : null,
        note: row['備考'] || null,
      };
    },
    afterInsert(row, id, context) {
      context.lookups.tankIdByName.set(context.normalize(row['容器名称']), id);
      context.lookups.tankIdByCode.set(context.normalize(row['容器ID']), id);
    },
  });
}

module.exports = { load };
