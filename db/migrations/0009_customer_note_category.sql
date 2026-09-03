-- 営業メモの「種別」（訪問／電話／メール／提案／メモ等）。
-- シートの営業メモは 日時／顧客ID／得意先名／記入者／種別／内容 の6列で、
-- 種別だけこちらに列が無かった。
ALTER TABLE customer_notes ADD COLUMN category TEXT;
