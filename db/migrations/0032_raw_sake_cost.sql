-- 原酒の仕入単価と、中身の原価を出すための倍率を足す
--
-- 上司向けの経営数値シート（scripts/export-management-sheet.js）で商品原価を出すため。
-- いままで資材の単価はあったが、中身（原酒）の値段がどこにも無かった。
--
-- 原酒の値段は仕込み年度で変わる（一昨年度 8,000L で 8,000,000円＝1,000円/L、昨年度 1,400円/L）。
-- 原酒マスタは「銘柄＋ロット」で1行なので、単価はここに持つ。
--
-- 原価に使う原酒は「使用中」の1件を手で切り替える（used_for_cost）。
-- 瓶詰めごとにロットを辿るほどの正確さは要らない、という判断（ざっくりでよい）。
-- 1件だけに立てるのは**サービス側で守る**（rawSakeBrandModel.update）。
--
-- 倍率は「浄酎1Lを採るのに原酒が何L要るか」。度数で変わる。
-- 鳥屋酒造・一昨年度の原酒の実績：35度は原酒30Lから15L、41度は原酒30Lから13L。

ALTER TABLE raw_sake_brands ADD COLUMN unit_price_per_l REAL;                     -- 仕入単価(円/L)
ALTER TABLE raw_sake_brands ADD COLUMN used_for_cost INTEGER NOT NULL DEFAULT 0;  -- 原価に使う原酒（1件だけ）

CREATE TABLE raw_sake_yield_rates (
  abv          REAL PRIMARY KEY,           -- 商品の規定度数
  raw_l        REAL NOT NULL CHECK (raw_l > 0),        -- 投入した原酒(L)
  distillate_l REAL NOT NULL CHECK (distillate_l > 0), -- 採れた浄酎(L)
  note         TEXT
);

INSERT INTO raw_sake_yield_rates (abv, raw_l, distillate_l, note) VALUES
  (35, 30, 15, '鳥屋酒造・一昨年度の原酒の実績'),
  (41, 30, 13, '鳥屋酒造・一昨年度の原酒の実績');
