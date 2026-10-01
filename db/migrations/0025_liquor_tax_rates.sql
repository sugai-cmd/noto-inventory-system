-- 酒税の税率マスタと、商品の酒類区分
--
-- 毎月月初に前月分の酒税を計算して申告する作業が、システムの外で行われていた。
-- 旧シート21枚にも酒税のシートは無い。
--
-- 材料はほぼ揃っていた。商品在庫変動履歴には 日付・商品・数量・容量・
-- 区分（出荷／返品／未納税移出）・取消フラグがあり、出荷とサンプル送付のたびに
-- 行が入っている。足りなかったのは**税率**と月次の集計。
--
-- ## いままでの「課税額」は使えない
--
-- products.tax_per_unit（コメント「課税額」）は `課税額 × 本数` として使われていて、
-- **容量を掛けていない**（orderService / shipmentService）。
-- 利用者の記憶では旧マスタには度数に対する税率（35度→0.37、41度→0.41）が
-- 入っていた。これは**円/ml**で、酒税法のスピリッツと一致する。
-- 実データが 0.37 なら、台帳の課税額は容量ぶん桁が違う
-- （300ml×12本で 0.37×12 = 4.44円。正しくは 300×12×0.37 = 1,332円）。
--
-- ## 税率の持ち方
--
-- 酒税法の形そのままにする。区分ごとに「基準度数」「基準の1klあたり税額」
-- 「基準を1度超えるごとの加算」。これで
--   超過度数 = max(0, floor(度数 - 基準度数))
--   円/kl   = 基準税額 + 超過度数 × 加算額
-- となり、**基準度数以下はどこでも基準税額のまま**になる
-- （スピリッツなら 35度・36度・37度がいずれも 370,000円/kl、38度で 380,000円/kl）。
--
-- **税率は入れない。** 区分の判定（スピリッツか単式蒸留焼酎か）は会社が決めることで、
-- 税率も改正される。推測で入れると**申告額を間違える**。画面から登録してもらう。
--
-- effective_from を持つのは、改正月をまたいだときに正しい率を選べるようにするため
-- （対象月の末日以前で一番新しいものを使う）。空なら「ずっと有効」。

CREATE TABLE liquor_tax_rates (
  id              INTEGER PRIMARY KEY,
  category        TEXT NOT NULL,                   -- 酒類区分（スピリッツ／単式蒸留焼酎 など）
  base_abv        REAL NOT NULL,                   -- 基準となるアルコール度数
  base_yen_per_kl REAL NOT NULL,                   -- 基準度数での1klあたりの税額
  step_yen_per_kl REAL NOT NULL DEFAULT 0,         -- 基準を1度超えるごとの加算（1klあたり）
  effective_from  TEXT CHECK (effective_from IS NULL OR effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同じ区分で「いつから」が同じ税率は1つだけ。改正ごとに1行増える。
-- effective_from が NULL の行も1区分に1つだけにしたいので、COALESCE で空文字に寄せる
CREATE UNIQUE INDEX ux_liquor_tax_rates
  ON liquor_tax_rates(category, COALESCE(effective_from, ''));

ALTER TABLE products ADD COLUMN tax_category TEXT;  -- どの酒類区分か（liquor_tax_rates.category）
