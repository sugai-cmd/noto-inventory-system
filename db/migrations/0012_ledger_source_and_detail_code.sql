-- シートとの列の突合で見つかった2件。
--
-- 1) 原料受払記録の「受入元」
--    シートは 受入元／払出先 の2列を、受払区分に応じて使い分けている。
--      受入: 受入元=酒蔵・原酒タンク名、払出先=入荷先タンク
--      払出: 受入元=投入元タンク、払出先=蒸留ID
--    こちらは払出先側（to_ref / to_tank_id / distillation_id）しか列を持たず、
--    受入のときの「受入元」を note に「受入元: ○○」と文字列で押し込んでいた。
--    列で持てず検索もできないうえ、備考を同時に書くと備考が消えていた。
ALTER TABLE raw_sake_ledger ADD COLUMN source_ref TEXT;   -- 受入元（酒蔵名・原酒タンク名など）

-- 2) 蒸留明細記録の「明細ID」（DTL-1 形式）
--    シートは1明細ごとにIDを持っており、取消や差し替えの記録がこのIDを指す。
ALTER TABLE distillation_details ADD COLUMN detail_code TEXT;
CREATE UNIQUE INDEX ux_distillation_details_code
  ON distillation_details(detail_code) WHERE detail_code IS NOT NULL;

-- すでに note に「受入元: ○○」で入っているぶんを列へ移す（移行データの取りこぼし防止）
UPDATE raw_sake_ledger
   SET source_ref = TRIM(SUBSTR(note, LENGTH('受入元: ') + 1)),
       note = NULL
 WHERE txn_type = '受入' AND note LIKE '受入元: %';
