// タンクマスタの補完（フェーズ1、tanks の直後）
//
// 台帳が参照しているのに、タンクマスタのシートに行が無い容器がある。
// 無いまま流すと resolveTankId が引けず、「行は入るがタンクの欄が空」になる。
// その分の液がどのタンクにも紐付かないので、タンクモニターの残量が合わなくなる。
//
// 表記ゆれの補正表（aliases.json）では直せない。補正表は「シートの表記」を
// 「登録されている名前」に読み替えるだけなので、右辺の容器がどこにも
// 無ければ当たらないため。足りない行そのものを、ここで足す。
//
// 同じ容器IDか同じ容器名称の行が既にあれば何もしない。シートに行を足せば
// そちらが正になり、このファイルは出番が無くなる。

const fs = require('node:fs');
const path = require('node:path');
const { touchedIds } = require('../lib/loadHelper');
const { generateUid } = require('../../src/utils/uid');

const DATA_PATH = path.join(__dirname, '..', 'data', 'known-tanks.json');
const SHEET_NAME = 'タンクマスタ（補完）';

const INSERT_SQL = `
  INSERT INTO tanks (uid, code, name, container_type, max_volume_l, location, status, note)
  VALUES (@uid, @code, @name, @containerType, @maxVolumeL, @location, @status, @note)
`;

function readKnownTanks() {
  if (!fs.existsSync(DATA_PATH)) return [];
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  return Array.isArray(data.tanks) ? data.tanks : [];
}

function load(ctx) {
  const summary = ctx.report.touchSummary(SHEET_NAME);

  let tanks;
  try {
    tanks = readKnownTanks();
  } catch (e) {
    ctx.report.recordError(SHEET_NAME, 0, `known-tanks.json を読み取れませんでした: ${e.message}`);
    return;
  }

  const byCode = ctx.db.prepare('SELECT id, name FROM tanks WHERE code = ?');
  const all = ctx.db.prepare('SELECT id, code, name FROM tanks').all();
  const idByName = new Map(all.map((t) => [ctx.normalize(t.name), t.id]));
  const stmt = ctx.db.prepare(INSERT_SQL);

  for (const tank of tanks) {
    summary.read++;

    const existing = byCode.get(tank.code) ?? null;
    const existingByName = idByName.get(ctx.normalize(tank.name));
    if (existing || existingByName != null) {
      // シートかDBに既にある。そちらを正とする
      const id = existing?.id ?? existingByName;
      summary.existing++;
      register(ctx, tank, id);
      continue;
    }

    try {
      const result = stmt.run({
        uid: generateUid(ctx.db, 'tanks'),
        code: tank.code,
        name: tank.name,
        containerType: tank.containerType ?? null,
        maxVolumeL: tank.maxVolumeL ?? null,
        location: tank.location ?? null,
        status: tank.status ?? null,
        note: tank.note ?? null,
      });
      const id = Number(result.lastInsertRowid);
      summary.inserted++;
      register(ctx, tank, id);
      idByName.set(ctx.normalize(tank.name), id);
      console.log(
        `  [補完] タンクマスタに ${tank.code}「${tank.name}」を追加しました` +
          '（シートに行がありません。シート側にも足しておくことをおすすめします）'
      );
    } catch (e) {
      ctx.report.recordError(SHEET_NAME, 0, `${tank.code}「${tank.name}」を追加できませんでした: ${e.message}`);
      summary.skipped++;
    }
  }
}

/** 台帳から名前でも容器IDでも引けるようにし、取り残し扱いにもしない */
function register(ctx, tank, id) {
  ctx.lookups.tankIdByName.set(ctx.normalize(tank.name), id);
  ctx.lookups.tankIdByCode.set(ctx.normalize(tank.code), id);
  touchedIds(ctx, 'tanks').add(id);
}

module.exports = { load, readKnownTanks };
