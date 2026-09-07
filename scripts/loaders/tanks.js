// タンクマスタ → tanks（フェーズ1）
// 現在液量・理論アルコール度数は本来 v_tank_monitor で再計算する値だが、
// 移行直後にビューが正しく積み上がるよう、シート最終値を initial_volume_l /
// current_abv の「初期値」としてそのまま投入する（tank_ledgerの移行が完了すれば
// 以降はビュー側の再計算値と一致するはずなので、ズレはそのまま検算材料にもなる）。

const { loadCsvTable, existingByCodeOrName } = require('../lib/loadHelper');
const { parseNumber } = require('../lib/parseNumber');
const { generateUid } = require('../../src/utils/uid');

const INSERT_SQL = `
  INSERT INTO tanks
    (uid, code, name, container_type, max_volume_l, location, status,
     gauge_constant, initial_volume_l, current_volume_l, current_abv, note)
  VALUES
    (@uid, @code, @name, @containerType, @maxVolumeL, @location, @status,
     @gaugeConstant, @initialVolumeL, @currentVolumeL, @currentAbv, @note)
`;

// 既に同じ名前の行があるときは、シートの内容で更新する。
// 在庫計算の起点になる列（初期在庫など）は当てない（createOnlyKeys で外す）。
const UPDATE_SQL = `
  UPDATE tanks SET
       name = @name,
       code = COALESCE(@code, code), container_type = @containerType,
       max_volume_l = @maxVolumeL, location = @location, status = @status,
       gauge_constant = @gaugeConstant, current_abv = @currentAbv, note = @note
  WHERE id = @id
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: 'タンクマスタ',
    csvFile: 'tanks.csv',
    insertSql: INSERT_SQL,
    updateSql: UPDATE_SQL,
    updateTable: 'tanks',
    createOnlyKeys: ['uid', 'initialVolumeL', 'currentVolumeL'],
    findExistingId: existingByCodeOrName('tanks', '容器ID', '容器名称'),
    mapRow(row) {
      const code = (row['容器ID'] || '').trim();
      const name = (row['容器名称'] || '').trim();
      if (!code) throw new Error('容器IDが空です');
      if (!name) throw new Error('容器名称が空です');

      const initialVolumeL = (parseNumber(row['初期在庫量'], '初期在庫量') ?? 0);

      return {
        uid: generateUid(ctx.db, 'tanks'),
        code,
        name,
        containerType: row['容器種別'] || null,
        maxVolumeL: parseNumber(row['最大容量(L)'], '最大容量(L)'),
        location: row['現在設置場所'] || null,
        status: row['ステータス'] || null,
        gaugeConstant: parseNumber(row['検尺定数'], '検尺定数'),
        initialVolumeL,
        currentVolumeL: (parseNumber(row['現在液量(L)'], '現在液量(L)') ?? initialVolumeL),
        currentAbv: parseNumber(row['理論アルコール度数'], '理論アルコール度数'),
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
