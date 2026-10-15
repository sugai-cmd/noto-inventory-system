-- 無償出荷に「区分」を足す（サンプル／再発送／販促）
--
-- sample_shipments は受注と無関係に在庫を引き、酒税額も入れる
-- （無償でも製造場からの移出は課税される）。
-- いままで理由を残す場所が無く、どれも「サンプル送付」になっていたため、
-- 税務で聞かれたときにサンプル配布と事故による再発送を区別して示せなかった。
--
-- ALTER TABLE では CHECK を足せないので、**値の検証はサービス側**で行う
-- （shipmentService.SHIPMENT_PURPOSES。tankService.TANK_KINDS と同じ作法）。
-- NULL の行は「サンプル」として扱う（移行ローダー経由で入った行が消えないように）。
--
-- 表名 sample_shipments は変えない。改名は得るものが無く、移行の危険だけ増える。

ALTER TABLE sample_shipments ADD COLUMN purpose TEXT;   -- サンプル / 再発送 / 販促

-- 既存はすべてサンプル配布。いまの意味をそのまま写す
UPDATE sample_shipments SET purpose = 'サンプル' WHERE purpose IS NULL;
