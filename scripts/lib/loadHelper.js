const path = require('node:path');
const { readCsv } = require('./csvReader');

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
function loadCsvTable(ctx, { sheetName, csvFile, insertSql, mapRow, afterInsert, findExistingId }) {
  const summary = ctx.report.touchSummary(sheetName);
  const filePath = path.join(ctx.dataDir, csvFile);
  const rows = readCsv(filePath);

  if (rows === null) {
    console.warn(`[skip] ${csvFile} が見つからないため「${sheetName}」の投入をスキップします`);
    return;
  }

  const stmt = ctx.db.prepare(insertSql);

  rows.forEach((row, i) => {
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
        summary.existing++;
        if (afterInsert) afterInsert(row, existingId, ctx);
        return;
      }
    }

    let mapped;
    try {
      mapped = mapRow(row, rowNumber, ctx);
    } catch (e) {
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
function resolveId(ctx, { sheet, column, rawValue, idMap, required = false }) {
  if (rawValue == null || String(rawValue).trim() === '') {
    if (required) throw new Error(`${column}が空です`);
    return null;
  }

  const aliasTable = ctx.aliases?.[column];
  const aliasedValue = aliasTable?.[rawValue];
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
const NON_TANK_LITERALS = new Set(['直接充填', '廃棄', '出荷', '-', '―', 'なし']);

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

  const aliasTable = ctx.aliases?.[column];
  const aliasedValue = aliasTable?.[rawValue] ?? rawValue;
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

module.exports = { loadCsvTable, resolveId, resolveTankId, existingByName };
