-- 酒蔵マスタの「酒蔵ID」（DATA_STRUCTURE.md 酒蔵マスタ A列）。
--
-- 他のマスタ（得意先・商品・資材・タンク）は表示用コードを持っているのに、
-- 酒蔵だけ列を落としていた。移行対象外のマスタなので実データの取りこぼしは無いが、
-- 画面から登録するときに採番できないので、ここで足す。
ALTER TABLE breweries ADD COLUMN code TEXT;
CREATE UNIQUE INDEX ux_breweries_code ON breweries(code) WHERE code IS NOT NULL;
