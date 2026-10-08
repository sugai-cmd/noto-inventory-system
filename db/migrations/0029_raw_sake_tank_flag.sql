-- 「中身の種類」を原酒だけの印に絞る（0028 の作り直し）
--
-- 0028 で tanks.contents_kind（浄酎/原酒/残渣）を足したが、**残渣まで対象にしたのは行き過ぎ**だった。
-- 困っていたのは「原酒を入れる別種の容器（QBテナー）が原酒入荷にも蒸留にも出てこない」ことだけで、
-- 残渣タンクの判定（容器IDが U- で始まる）はもともと困っていない。
-- 浄酎・原酒が入るのは樽やステンレスタンクで、残渣タンクはそれとは別のもの。
--
-- 3種類から選ばせるのをやめ、**原酒を入れる容器かどうか**だけを持つ。
-- 浄酎と残渣は 0028 以前と同じく容器IDの接頭辞で決める。
--
-- 0028 はすでに本番に当たっているので書き換えられない。ここで前に進める。

ALTER TABLE tanks ADD COLUMN is_raw_sake_tank INTEGER;  -- 1=原酒を入れる容器

-- 0028 で入れた値を写す。原酒だけが印として残り、浄酎・残渣は接頭辞に戻る。
-- contents_kind が未設定の行（移行ローダー経由で入った行）は容器IDで判断する。
UPDATE tanks SET is_raw_sake_tank =
  CASE
    WHEN COALESCE(contents_kind, CASE WHEN code LIKE 'SP-%' THEN '原酒' END) = '原酒' THEN 1
    ELSE 0
  END
WHERE is_raw_sake_tank IS NULL;

-- 残すと「3種類あるように見えて原酒しか効かない」列になり、次に読む人を必ず誤らせる。
-- ビューからも索引からも参照されていないので落とせる（SQLite 3.35+。同梱は 3.53.4）。
ALTER TABLE tanks DROP COLUMN contents_kind;
