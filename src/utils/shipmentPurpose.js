// 無償出荷（サンプル・再発送・販促）の区分。
//
// **区分の一覧はここだけが持つ。** 画面・API・酒税の集計がここを見る。
// 酒税の集計（liquorTaxService）と無償出荷の登録（shipmentService）の
// 両方から必要になるが、shipmentService は liquorTaxService を読んでいるので、
// サービス同士で読み合うと循環参照になる。定数だけをここに置く。
//
// 表の CHECK には入れていない（ALTER TABLE では CHECK を足せないため。
// db/migrations/0031_shipment_purpose.sql の断り書きを参照）。

const { BusinessRuleError } = require('./errors');

const SHIPMENT_PURPOSES = ['サンプル', '再発送', '販促'];
const DEFAULT_SHIPMENT_PURPOSE = 'サンプル';

/**
 * 区分を確かめる。
 *
 * 未指定は「サンプル」（この改修より前の呼び出しとデータの意味をそのまま写す）。
 * 一覧に無い値は通さない。黙って既定に落とすと、選び間違いが
 * 「サンプル配布」として申告に乗ってしまう。
 */
function normalizeShipmentPurpose(value) {
  if (value == null || value === '') return DEFAULT_SHIPMENT_PURPOSE;
  const purpose = String(value);
  if (!SHIPMENT_PURPOSES.includes(purpose)) {
    throw new BusinessRuleError(
      `無償出荷の区分「${purpose}」は選べません（${SHIPMENT_PURPOSES.join('／')}）`
    );
  }
  return purpose;
}

/**
 * 在庫変動履歴の備考。在庫の履歴だけを見た人にも理由が分かるようにする。
 * 「サンプル」は今までの文言のまま（過去の履歴と見た目を揃える）。
 */
function ledgerNoteFor(purpose, sampleNo) {
  return purpose === DEFAULT_SHIPMENT_PURPOSE
    ? `サンプル送付 ${sampleNo}`
    : `${purpose} ${sampleNo}`;
}

module.exports = {
  SHIPMENT_PURPOSES,
  DEFAULT_SHIPMENT_PURPOSE,
  normalizeShipmentPurpose,
  ledgerNoteFor,
};
