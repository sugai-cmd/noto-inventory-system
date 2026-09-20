-- 段ボール対応表に「枚数」「荷物の個数」「組み立てた荷物の外寸」を足す
--
-- 送料を「運賃 × 荷物の個数 ＋ 段ボールの税抜単価 × 枚数」の税込・50円繰り上げで
-- 出すようにするため。いままでは運賃をそのまま送料にしていて、
-- 段ボール代も消費税も入っていなかった。
--
-- **枚数と荷物の個数は別物。**
-- 300ml 2本は 1本用の箱を2枚使うが、テープでくっつけて**1つの荷物**として送る。
-- 在庫からは2枚引くのに、運賃は1回しかかからない。
-- 一方 24本は 12本用を2枚使い、**2つの荷物**として送るので運賃も2回。
-- 1つの数字では表せないので、別々に持たせる。
--
-- 外寸は**組み立てた1荷物ぶん**。ゆうパックのサイズ区分は3辺の合計で決まるので、
-- くっつけた後の寸法でないと運賃がずれる。
-- 箱単体の寸法ではないため、資材マスタではなくこちら（商品×本数の行）に持たせる。
--
-- **既定を1にしてあるので、いまの11行は今までどおり動く**（1箱＝1枚＝1荷物）。
-- 外寸は入れない。実測しないと分からず、推測で入れると請求する運賃がずれる。

ALTER TABLE carton_rules ADD COLUMN material_qty INTEGER NOT NULL DEFAULT 1;  -- 1組あたり何枚使うか（在庫から引く枚数）
ALTER TABLE carton_rules ADD COLUMN parcels      INTEGER NOT NULL DEFAULT 1;  -- 1組が何個の荷物になるか（運賃を数える回数）
ALTER TABLE carton_rules ADD COLUMN length_cm    REAL;                        -- 組み立てた1荷物の外寸（cm）
ALTER TABLE carton_rules ADD COLUMN width_cm     REAL;
ALTER TABLE carton_rules ADD COLUMN height_cm    REAL;
