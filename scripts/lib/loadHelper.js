const path = require('node:path');

/**
 * 「この行は飛ばしてよい」を表す例外。
 * 読み取りの失敗（＝直すべきエラー）と、意図した除外を区別するために分けている。
 */
class SkipRow extends Error {}

const { readCsv } = require('./csvReader');
const { aliasesForSheet, aliasRow } = require('./columnAliases');

/**
 * CSV1ファイル分を読み込み、行ごとに mapRow で変換してINSERTする共通処理。
 * 8.0/8.4/8.5で定義した「読込→変換→投入、行単位でエラーを収集」を1箇所に集約する。
 *
 * @param {object} ctx - migrate-from-sheets.js が組み立てるコンテキスト
 * @param {object} opts
 * @param {string} opts.sheetName - レポート上の表示名（旧シート名）
 * @param {string} opts.csvFile - ctx.dataDir 配下のファイル名
 * @param {string} opts.insertSql - better-sqlite3の名前付きパラメータ形式のINSERT文
 * @param {(row: object, rowNumber: number, ctx: object) => (object|null)} opts.mapRow
 *        1行をinsertSqlのパラメータオブジェクトに変換する。nullを返すとスキップ扱い。
 * @param {(row: object, id: number|bigint, ctx: object) => void} [opts.afterInsert]
 *        INSERT成功後に呼ばれるフック（lookupマップの登録等に使う）
 * @param {(row: object, ctx: object) => (number|null)} [opts.findExistingId]
 *        既に同じ自然キーの行が存在するかを調べるフック。idを返すとINSERTせず
 *        「既存」としてafterInsertだけ呼ぶ（マスタ投入を冪等にし、--reset時に
 *        マスタを保持したまま台帳だけ再投入できるようにするため。8-5）
 */
function loadCsvTable(ctx, {
  sheetName,
  csvFile,
  insertSql,
  updateSql,        // 既に同じ名前の行があるときに当てるUPDATE文（マスタ系だけ渡す）
  updateTable,      // 変更前の値を読むテーブル名（レポートに出すため）
  createOnlyKeys = [], // 既存行には当てない項目（初期在庫など、在庫計算の起点）
  mapRow,
  afterInsert,
  findExistingId,
}) {
  const summary = ctx.report.touchSummary(sheetName);
  const filePath = path.join(ctx.dataDir, csvFile);
  const rows = readCsv(filePath);

  if (rows === null) {
    console.warn(`[skip] ${csvFile} が見つからないため「${sheetName}」の投入をスキップします`);
    return;
  }

  const stmt = ctx.db.prepare(insertSql);

  // 見出しの表記ゆれを吸収する。ローダーは row['資材名'] のまま書けばよく、
  // シート側が「資材名称」でも読める（columnAliases.js）。
  const aliases = aliasesForSheet(sheetName);

  rows.forEach((rawRow, i) => {
    const row = aliasRow(rawRow, aliases);
    summary.read++;
    const rowNumber = i + 2; // ヘッダ行を1行目とした実際のCSV上の行番号

    // 既存行があればINSERTせず、lookupへの登録だけ行う（再実行時の冪等性）
    if (findExistingId) {
      let existingId;
      try {
        existingId = findExistingId(row, ctx);
      } catch (e) {
        ctx.report.recordError(sheetName, rowNumber, e.message);
        summary.skipped++;
        return;
      }
      if (existingId != null) {
        // 既に同じ名前の行があるときは、シートの内容で**更新する**。
        // 飛ばしてしまうと、シート側で支払いサイトなどを直しても
        // 流し直しでデータベースに反映されない。
        if (updateSql) {
          applyMasterUpdate(ctx, {
            sheetName,
            existingId,
            row,
            rowNumber,
            mapRow,
            updateSql,
            updateTable,
            createOnlyKeys,
            summary,
          });
        } else {
          summary.existing++;
        }
        if (afterInsert) afterInsert(row, existingId, ctx);
        return;
      }
    }

    let mapped;
    try {
      mapped = mapRow(row, rowNumber, ctx);
    } catch (e) {
      // 意図した除外はエラーとして数えない（レポートは汚さず、件数だけ残す）
      if (e instanceof SkipRow) {
        summary.ignored = (summary.ignored ?? 0) + 1;
        return;
      }
      ctx.report.recordError(sheetName, rowNumber, e.message);
      summary.skipped++;
      return;
    }

    if (mapped === null) {
      summary.skipped++;
      return;
    }

    try {
      const result = stmt.run(mapped);
      summary.inserted++;
      if (afterInsert) afterInsert(row, result.lastInsertRowid, ctx);
    } catch (e) {
      ctx.report.recordError(sheetName, rowNumber, e.message);
      summary.skipped++;
    }
  });
}

/**
 * 既存のマスタ行を、シートの内容で更新する。
 *
 * 在庫計算の起点になる列（初期在庫数・初期在庫量など）は当てない。
 * 上書きすると現在の在庫が動いてしまうため。
 * 何がどう変わったかは必ずレポートに出す（黙って上書きしない）。
 */
function applyMasterUpdate(ctx, opts) {
  const { sheetName, existingId, row, rowNumber, mapRow, updateSql, updateTable,
          createOnlyKeys, summary } = opts;

  let mapped;
  try {
    mapped = mapRow(row, rowNumber, ctx);
  } catch (e) {
    if (e instanceof SkipRow) {
      summary.ignored = (summary.ignored ?? 0) + 1;
      return;
    }
    ctx.report.recordError(sheetName, rowNumber, e.message);
    summary.skipped++;
    return;
  }
  if (mapped === null) {
    summary.skipped++;
    return;
  }

  const params = { ...mapped, id: existingId };
  for (const key of createOnlyKeys) delete params[key];

  const before = updateTable
    ? ctx.db.prepare(`SELECT * FROM ${updateTable} WHERE id = ?`).get(existingId)
    : null;

  try {
    ctx.db.prepare(updateSql).run(params);
    summary.updated = (summary.updated ?? 0) + 1;
  } catch (e) {
    ctx.report.recordError(sheetName, rowNumber, e.message);
    summary.skipped++;
    return;
  }

  if (!before || !updateTable) return;
  const after = ctx.db.prepare(`SELECT * FROM ${updateTable} WHERE id = ?`).get(existingId);
  for (const column of Object.keys(after)) {
    if (column === 'updated_at') continue;
    if (String(before[column] ?? '') === String(after[column] ?? '')) continue;
    ctx.report.recordMasterUpdate(sheetName, after.name ?? after.code ?? existingId,
      column, before[column], after[column]);
  }
}

/**
 * name列の自然キーで既存行を探す findExistingId を生成する共通ヘルパー。
 * 正規化はせず、CSV上の値をトリムして厳密一致で探す（マスタ自身の投入なので
 * 名寄せの対象ではなく、UNIQUE制約と同じ基準で判定する）。
 */
function existingByName(table, csvColumn) {
  return (row, ctx) => {
    const name = (row[csvColumn] || '').trim();
    if (!name) return null;
    const found = ctx.db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
    return found ? found.id : null;
  };
}

/**
 * 名前ベースの緩い参照（得意先名・商品名・タンク名等）を、事前に構築したidMapを使って
 * 整数IDに解決する（8-3）。aliases（scripts/data/aliases.json）で手動補正済みならそちらを優先する。
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string} opts.sheet - レポート上の表示名
 * @param {string} opts.column - どの列かの表示名
 * @param {string|undefined|null} opts.rawValue - CSV上の生値
 * @param {Map<string, number>} opts.idMap - normalize後の名前 → id
 * @param {boolean} [opts.required] - trueなら未解決時に例外を投げて行全体をスキップさせる
 * @returns {number|null}
 */
/**
 * 「マスタに無いのが分かっていて、飛ばしてよい値」かどうか。
 *
 * 実データには廃番になった商品を指すレシピ行のように、
 * マスタに無いのが正しい行が混ざる。これを名寄せ不一致として数えると
 * 毎回 --strict で止まってしまい、本当の不一致が埋もれる。
 * aliases.json に __ignore__ で宣言しておくと、静かに飛ばす。
 *
 *   { "__ignore__": { "商品名称": ["白30ml サンプル用(旧)"] } }
 */
function isKnownIgnored(ctx, column, rawValue) {
  const list = ctx.aliases?.__ignore__?.[column];
  if (!Array.isArray(list)) return false;
  const target = ctx.normalize(rawValue);
  return list.some((v) => ctx.normalize(v) === target);
}

/**
 * aliases.json の対応表を引く。
 *
 * キーは unmatched-names.csv の rawValue をそのまま貼る前提だが、
 * 手で書き写すと幅（全角/半角）や前後の空白がずれる。
 * そこだけのために効かない、というのは分かりにくいので、
 * 正規化したキーでも引けるようにしておく。
 */
function aliasFor(ctx, column, rawValue) {
  const table = ctx.aliases?.[column];
  if (!table) return undefined;
  if (Object.hasOwn(table, rawValue)) return table[rawValue];

  ctx._aliasIndex ??= new Map();
  let index = ctx._aliasIndex.get(column);
  if (!index) {
    index = new Map(Object.entries(table).map(([k, v]) => [ctx.normalize(k), v]));
    ctx._aliasIndex.set(column, index);
  }
  return index.get(ctx.normalize(rawValue));
}

function resolveId(ctx, { sheet, column, rawValue, idMap, required = false }) {
  if (rawValue == null || String(rawValue).trim() === '') {
    if (required) throw new Error(`${column}が空です`);
    return null;
  }

  if (isKnownIgnored(ctx, column, rawValue)) {
    throw new SkipRow(`${column}「${rawValue}」は移行対象外として宣言されています`);
  }

  const aliasedValue = aliasFor(ctx, column, rawValue);
  const target = ctx.normalize(aliasedValue ?? rawValue);

  const id = idMap.get(target);
  if (id == null) {
    ctx.report.recordUnmatched(sheet, column, rawValue, target);
    if (required) {
      throw new Error(`${column}「${rawValue}」がマスタに見つかりません（名寄せ未解決）`);
    }
    return null;
  }
  return id;
}

// タンク欄に入りうるが、そもそもタンクを指していない既知の値。
// これらは「名寄せ不一致」ではなく仕様上のNULLなので、レポートに載せない
// （DDLでも 払出先「直接充填」等は to_tank_id=NULL ＋ note と設計済み）。
const NON_TANK_LITERALS = new Set([
  '直接充填', '廃棄', '出荷', '-', '―', 'なし',
  // 場所であってタンクではない（タンクマスタの「現在設置場所」に出てくる値）
  '熟成室', '浄溜所', '浄留所',
]);

/**
 * タンク参照専用の解決ヘルパー。DATA_STRUCTURE.mdでは「タンクID」「タンク名」の
 * どちらの表記でタンクを指しているかがシートによって曖昧なため、
 * 容器名称(tankIdByName)→容器ID(tankIdByCode)の順に両方試す。
 */
function resolveTankId(ctx, { sheet, column, rawValue, required = false }) {
  if (rawValue == null || String(rawValue).trim() === '') {
    if (required) throw new Error(`${column}が空です`);
    return null;
  }

  const aliasedValue = aliasFor(ctx, column, rawValue) ?? rawValue;
  const target = ctx.normalize(aliasedValue);

  if (NON_TANK_LITERALS.has(target)) {
    if (required) throw new Error(`${column}「${rawValue}」はタンクを指していません`);
    return null;
  }

  const byName = ctx.lookups.tankIdByName.get(target);
  if (byName != null) return byName;

  const byCode = ctx.lookups.tankIdByCode.get(target);
  if (byCode != null) return byCode;

  ctx.report.recordUnmatched(sheet, column, rawValue, target);
  if (required) {
    throw new Error(`${column}「${rawValue}」に一致するタンクが見つかりません（名称・IDとも不一致）`);
  }
  return null;
}

module.exports = { loadCsvTable, resolveId, resolveTankId, existingByName, SkipRow };
