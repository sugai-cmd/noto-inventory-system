-- 容器の「中身の種類」を列として持つ
--
-- 原酒入荷の受入先と蒸留の投入元は、どちらも容器IDの接頭辞 SP- で絞っていた
-- （routes/rawSakeReceipts.js の 2本のクエリ、distillationService の検証、
-- stocktakingService、tanks.js の残渣回収）。そのため
-- **原酒を入れる別種の容器（QBテナー・樽など）を登録しても両画面に一切出ない。**
--
-- 接頭辞で代用していた理由は tankService.js のコメントに残っている:
-- 移行実データの container_type は「PE」「QBテナー」など材質や通称で、
-- 「原酒」を含む行は1件も無い。原酒ポリ（SP）も出荷用ポリ（JP）も同じ 'PE'。
-- つまり既存の列では中身を表せなかった。
--
-- ここで中身の種類を明示的に持ち、容器種別・容器IDが何であれ
-- 「中身が原酒なら原酒の容器」と言えるようにする。
--
-- CHECK は ALTER TABLE では足せないので、値の検証はサービス側で行う
-- （tankService.TANK_KINDS = ['浄酎','原酒','残渣']）。
-- 索引も作らない。実データは数十行で全件走査で足りる。

ALTER TABLE tanks ADD COLUMN contents_kind TEXT;  -- 浄酎 / 原酒 / 残渣

-- 既存分は「いまの判定」をそのまま写す。移行の前後で挙動を変えないため。
UPDATE tanks SET contents_kind =
  CASE
    WHEN code LIKE 'SP-%' THEN '原酒'
    WHEN code LIKE 'U-%'  THEN '残渣'
    ELSE '浄酎'
  END
WHERE contents_kind IS NULL;
