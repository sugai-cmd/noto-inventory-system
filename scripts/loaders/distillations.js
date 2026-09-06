// 蒸留記録 → distillations（フェーズ3-2）
// 「蒸留日」は日時混在列のため、2.0の方針に従い started_on / started_time に分離する。
// シートには完了日時そのものの列がないため、completed_on / completed_time は
// 移行時点ではNULLのまま（新アプリ運用開始後に完了処理で埋まる想定）。
//
// 「使用原酒明細」列には DTL-0001 DTL-0002 のように明細IDが並んでいる。
// これは表示用の文章ではなく蒸留明細記録への紐付けなので、input_summary へ
// そのまま入れると一覧の「使用原酒」が読めなくなる。
// 明細を入れ終わったあとに rebuildInputSummaries() でタンク名＋投入量へ組み直す。

const { loadCsvTable, resolveTankId } = require('../lib/loadHelper');
const { parseNumber } = require('../lib/parseNumber');
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
      if (!startedOn) {
        throw new Error(`蒸留日を読み取れません: "${row['蒸留日']}"`);
      }
      // 実データの蒸留日は日付だけで時刻が入っていない（43行すべて）。
      // started_time はNOT NULLなので、時刻が無い過去分は 00:00 で埋める。
      // この時刻は24時間経過アラートの起点だが、移行分は既に完了しているので影響しない。

      const outputTankId = resolveTankId(context, {
        sheet: '蒸留記録',
        column: '払出先',
        rawValue: row['払出先'],
        required: false,
      });

      return {
        distillationCode,
        startedOn,
        startedTime: startedTime ?? '00:00',
        // ひとまずシートの値（明細IDの羅列）を入れ、明細投入後に組み直す
        inputSummary: row['使用原酒明細'] || null,
        totalInputL: parseNumber(row['投入量合計'], '投入量合計'),
        plannedDuration: row['蒸留設定時間'] || null,
        status: row['ステータス'] || '蒸留中',
        outputL: parseNumber(row['蒸留量'], '蒸留量'),
        outputAbv: parseNumber(row['アルコール度数'], 'アルコール度数'),
        outputTankId,
        residueQty: parseNumber(row['残渣回収量'], '残渣回収量'),
      };
    },
    afterInsert(row, id, context) {
      context.lookups.distillationIdByCode.set(row['蒸留ID'].trim(), id);
    },
  });
}

/**
 * 蒸留明細を入れ終わったあとに、一覧の「使用原酒」欄を人が読める形へ組み直す。
 * シートは「DTL-0001 DTL-0002」と明細IDを並べているだけなので、そのままでは
 * どのタンクから何L入れたのか画面で分からない。明細IDは detail_code に残っている。
 */
function rebuildInputSummaries(ctx) {
  const rows = ctx.db
    .prepare(
      `SELECT d.distillation_id AS id,
              GROUP_CONCAT(t.name || ' ' || CAST(d.input_l AS TEXT) || 'L', ' / ') AS summary
         FROM distillation_details d
         LEFT JOIN tanks t ON t.id = d.source_tank_id
        WHERE d.is_cancelled = 0 AND t.name IS NOT NULL
        GROUP BY d.distillation_id`
    )
    .all();

  const update = ctx.db.prepare('UPDATE distillations SET input_summary = ? WHERE id = ?');
  let updated = 0;
  for (const r of rows) {
    if (!r.summary) continue;
    update.run(r.summary, r.id);
    updated++;
  }
  if (updated) {
    console.log(`[蒸留記録] 使用原酒の表示を明細から組み直しました（${updated}件）`);
  }
}

module.exports = { load, rebuildInputSummaries };
