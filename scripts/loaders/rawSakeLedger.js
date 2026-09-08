// 原料受払記録 → raw_sake_ledger（フェーズ3-3）
//
// DATA_STRUCTURE.md 4-9の通り「受入元」「払出先」は受払の種類によって意味が変わる列：
//   払出（蒸留への投入）: 受入元=投入元タンク、払出先=蒸留ID
//   受入（原酒入荷/蒸留完了による充填）: 払出先=受入先タンク（受入元は仕入元等の自由記述の可能性があり、タンク名としては解決しない）
// 2.1のA案の通り、種類ごとに専用列（from_tank_id / to_tank_id / distillation_id）へ分解する。
//
// 原酒スペック（例「BYR6浄酎用池月」）は原酒マスタの銘柄名と一致するので、
// 名寄せして raw_sake_brand_id を埋める。これでロット追跡の「原酒タンクの中身」に
// 銘柄と酒蔵が出る。一致しない書き方のものは spec_note に自由記述として残す。
//
// 原酒受払IDは資材履歴IDと同じ M 始まりで、実データで73件が完全に衝突していた。
// 新規分は R で採番しているので、過去分も R に揃える（元の番号は legacy_lot_code に残す）。

const { loadCsvTable, resolveId, resolveTankId } = require('../lib/loadHelper');
const { parseNumber } = require('../lib/parseNumber');
const { parseDateOnly } = require('../lib/parseDate');
const { renumber, dedupeCode } = require('../lib/legacyCode');

const INSERT_SQL = `
  INSERT INTO raw_sake_ledger
    (lot_code, legacy_lot_code, txn_date, txn_type, from_tank_id, source_ref, to_ref, to_tank_id,
     distillation_id, quantity, raw_sake_brand_id, spec_note, is_fifo_estimated, note)
  VALUES
    (@lotCode, @legacyLotCode, @txnDate, @txnType, @fromTankId, @sourceRef, @toRef, @toTankId,
     @distillationId, @quantity, @rawSakeBrandId, @specNote, @isFifoEstimated, @note)
`;

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: '原料受払記録',
    csvFile: 'raw_sake_ledger.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const legacyLotCode = (row['原酒受払ID'] || '').trim() || null;
      // 商品履歴ID・資材履歴IDと同じく、番号が重複していても行は落とさない。
      // lot_code は UNIQUE なので2件目がINSERTで落ちるが、落とすと原酒の受払が
      // 1件消えて在庫が合わなくなる。番号のほうに枝番を付ける。
      const renumbered = legacyLotCode ? renumber(legacyLotCode, 'R') : null;
      const { code: lotCode, duplicated } = dedupeCode(context.counters, 'rawSake', renumbered);
      if (duplicated) {
        context.report.recordNotice(
          '原料受払記録', rowNumber,
          `原酒受払ID「${legacyLotCode}」が重複していたため ${lotCode} として取り込みました`
        );
      }
      const txnType = (row['受払'] || '').trim();
      if (txnType !== '受入' && txnType !== '払出') {
        throw new Error(`受払は「受入」「払出」のいずれかである必要があります: "${row['受払']}"`);
      }

      let fromTankId = null;
      let toTankId = null;
      let distillationId = null;

      if (txnType === '払出') {
        fromTankId = resolveTankId(context, {
          sheet: '原料受払記録',
          column: '受入元(投入元タンク)',
          rawValue: row['受入元'],
          required: false,
        });
        distillationId = resolveId(context, {
          sheet: '原料受払記録',
          column: '払出先(蒸留ID)',
          rawValue: row['払出先'],
          idMap: context.lookups.distillationIdByCode,
          required: false,
        });
      } else {
        toTankId = resolveTankId(context, {
          sheet: '原料受払記録',
          column: '払出先(受入先タンク)',
          rawValue: row['払出先'],
          required: false,
        });
      }

      // 原酒スペックが原酒マスタを指していれば紐付ける。
      // 一致しない書き方（自由記述）はここで止めず、spec_note に残す。
      const specNote = row['原酒スペック'] || null;
      const rawSakeBrandId = resolveRawSakeBrandId(context, specNote);

      return {
        lotCode,
        legacyLotCode,
        txnDate: parseDateOnly(row['日付']),
        txnType,
        fromTankId,
        toRef: row['払出先'] || null, // 正規化できなかった場合のフォールバック用に原文も残す
        toTankId,
        distillationId,
        quantity: parseNumber(row['受払量'], '受払量', { required: true }),
        rawSakeBrandId,
        specNote,
        isFifoEstimated: row['FIFO推定'] ? 1 : 0,
        // 受入元は専用の列で持つ（0012で追加）。備考へ文字列で押し込むと検索できず、
        // 備考を同時に書いたときに消えてしまう。
        sourceRef: txnType === '受入' ? (row['受入元'] || null) : null,
        note: null,
      };
    },
    afterInsert(row, id, context) {
      // 蒸留明細記録は元の番号（M…）で参照しているので、引き当ての表は元の番号で持つ
      const legacy = (row['原酒受払ID'] || '').trim();
      if (legacy) context.lookups.rawSakeLedgerIdByLotCode.set(legacy, id);
    },
  });
}

/**
 * 「原酒スペック」から原酒マスタの行を決める。
 *
 * 原酒IDでも銘柄名でも書けるようにしてある（容器が「容器名称」でも「容器ID」でも
 * 引けるのと同じ形）。銘柄名は同じ名前の別ロットがありうるので一意とは限らず、
 * 決められないときは**引かない**。度数の違うロットを取り違えるより、
 * 不一致として報告して原酒IDで書き直してもらう方が安全なため。
 */
function resolveRawSakeBrandId(ctx, specNote) {
  if (!specNote) return null;
  const target = ctx.normalize(specNote);

  const byCode = ctx.lookups.rawSakeBrandIdByCode?.get(target);
  if (byCode != null) return byCode;

  if (ctx.lookups.rawSakeBrandAmbiguousNames?.has(target)) {
    ctx.report.recordUnmatched('原料受払記録', '原酒スペック', specNote, target);
    return null;
  }

  return ctx.lookups.rawSakeBrandIdByName?.get(target) ?? null;
}

module.exports = { load };
