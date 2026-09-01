// サンプル、販促資料送付 → sample_shipments（フェーズ3-10、product_stock_ledgerの後に実行）
//
// 8-1で決定した通り、このシートには受注番号のような共通キーが存在しないため、
// 移行時に新規で sample_no（S+年月+連番。受注番号の採番方式を踏襲）を採番し、
// 日付×商品×数量が一意に一致する product_stock_ledger の「出荷」行に
// sample_shipment_id を事後的にセットする（product_stock_ledger.order_idと対になるFK）。

const { loadCsvTable, resolveId } = require('../lib/loadHelper');
const { parseDateOnly } = require('../lib/parseDate');

const INSERT_SQL = `
  INSERT INTO sample_shipments
    (sample_no, shipped_on, customer_id, contact_name, product_id, quantity,
     followup_on, phone, data_kind, note)
  VALUES
    (@sampleNo, @shippedOn, @customerId, @contactName, @productId, @quantity,
     @followupOn, @phone, @dataKind, @note)
`;

function nextSampleNo(ctx, shippedOn) {
  if (!shippedOn) throw new Error('発送日が空のためsample_noを採番できません');
  const yymm = shippedOn.slice(2, 4) + shippedOn.slice(5, 7); // 'YYYY-MM-DD' -> 'YYMM'

  if (!ctx.counters) ctx.counters = {};
  if (!ctx.counters.sampleNoByMonth) ctx.counters.sampleNoByMonth = new Map();

  const next = (ctx.counters.sampleNoByMonth.get(yymm) ?? 0) + 1;
  ctx.counters.sampleNoByMonth.set(yymm, next);

  return `S${yymm}-${String(next).padStart(4, '0')}`;
}

function load(ctx) {
  loadCsvTable(ctx, {
    sheetName: 'サンプル、販促資料送付',
    csvFile: 'sample_shipments.csv',
    insertSql: INSERT_SQL,
    mapRow(row, rowNumber, context) {
      const shippedOn = parseDateOnly(row['発送日']);
      if (!shippedOn) throw new Error('発送日が空です');

      const customerId = resolveId(context, {
        sheet: 'サンプル、販促資料送付',
        column: '得意先名',
        rawValue: row['得意先名'],
        idMap: context.lookups.customerIdByName,
        required: false,
      });
      const productId = resolveId(context, {
        sheet: 'サンプル、販促資料送付',
        column: '商品名',
        rawValue: row['商品名'],
        idMap: context.lookups.productIdByName,
        required: true,
      });

      return {
        sampleNo: nextSampleNo(context, shippedOn),
        shippedOn,
        customerId,
        contactName: row['得意先名前'] || null,
        productId,
        quantity: Number(row['本数']),
        followupOn: parseDateOnly(row['後追い連絡日']),
        phone: row['電話番号'] || null,
        dataKind: row['データ区分'] || null,
        note: row['備考'] || null,
      };
    },
  });

  linkToProductStockLedger(ctx);
}

/**
 * 8-1: 日付×商品×数量が一意に一致する product_stock_ledger の未紐付け出荷行を探し、
 * 見つかった場合のみ sample_shipment_id をセットする。0件・複数件は無理にマッチさせず
 * レポートに記録するだけに留める。
 */
function linkToProductStockLedger(ctx) {
  const sheetName = 'サンプル送付↔商品在庫変動履歴（突合）';
  const summary = ctx.report.touchSummary(sheetName);

  const samples = ctx.db
    .prepare(`
      SELECT s.id, s.shipped_on, s.product_id, s.quantity
      FROM sample_shipments s
      WHERE NOT EXISTS (
        SELECT 1 FROM product_stock_ledger l WHERE l.sample_shipment_id = s.id
      )
    `)
    .all();

  const findCandidates = ctx.db.prepare(`
    SELECT id FROM product_stock_ledger
    WHERE txn_type = '出荷'
      AND order_id IS NULL
      AND sample_shipment_id IS NULL
      AND txn_date = ?
      AND product_id = ?
      AND quantity = ?
  `);
  const setLink = ctx.db.prepare(
    'UPDATE product_stock_ledger SET sample_shipment_id = ? WHERE id = ?'
  );

  for (const sample of samples) {
    summary.read++;
    const candidates = findCandidates.all(sample.shipped_on, sample.product_id, sample.quantity);

    if (candidates.length === 1) {
      setLink.run(sample.id, candidates[0].id);
      summary.inserted++;
    } else if (candidates.length === 0) {
      summary.skipped++;
      ctx.report.recordError(
        sheetName,
        sample.id,
        `sample_shipments.id=${sample.id} に一致する出荷履歴(product_stock_ledger)が見つかりません（0件）`
      );
    } else {
      summary.skipped++;
      ctx.report.recordError(
        sheetName,
        sample.id,
        `sample_shipments.id=${sample.id} に一致する出荷履歴が${candidates.length}件あり一意に決まりません（曖昧マッチのためスキップ）`
      );
    }
  }
}

module.exports = { load };
