-- 明細を直した蒸留の「使用原酒（表示用の文）」を組み直す
--
-- 蒸留記録の一覧の「使用原酒」列は distillations.input_summary を出しているが、
-- 明細を差し替えても取り消しても、この欄を書き換えていなかった。
-- そのため**一覧だけが元の投入元を出し続ける**:
--   投入明細 … DTL-93 原酒ポリ1（取消済み → DTL-99）／DTL-99 原酒ポリ23
--   一覧     … 「原酒ポリ1 20L / 原酒ポリ3 10L」のまま
--
-- サービス側は rebuildDistillationInputs() で組み直すようにしたが、
-- **それはこれから明細を動かしたときだけ**。既に直してある記録は、
-- 二度と組み直される機会がないのでここで直す。
--
-- 対象は**取消済みの明細を持つ蒸留だけ**に絞る。
--   ・直していない記録まで書き換えると、移行時にシートから取り込んだ文
--     （「原酒ポリ5 10.0L / 原酒ポリ6 20.0L」など）まで作り直すことになる
--   ・生きている明細が1件も無い蒸留は対象外。組み直すと空文字になってしまう
--
-- 数量の書き方はサービス側（JavaScript）と揃える。SQLite の REAL をそのまま
-- 連結すると 20.0 が「20.0L」になり、これから登録されるぶんの「20L」と食い違う。
-- printf して末尾の 0 と小数点を落とすと、JS の String(20) と同じ「20」になる。

UPDATE distillations
   SET input_summary = (
         SELECT GROUP_CONCAT(x.label, ' / ')
           FROM (
             SELECT COALESCE(t.name, '(タンク不明)') || ' '
                    || RTRIM(RTRIM(printf('%.6f', d.input_l), '0'), '.') || 'L' AS label
               FROM distillation_details d
               LEFT JOIN tanks t ON t.id = d.source_tank_id
              WHERE d.distillation_id = distillations.id
                AND d.is_cancelled = 0
              ORDER BY d.id
           ) x
       )
 WHERE EXISTS (
         SELECT 1 FROM distillation_details c
          WHERE c.distillation_id = distillations.id AND c.is_cancelled = 1
       )
   AND EXISTS (
         SELECT 1 FROM distillation_details l
          WHERE l.distillation_id = distillations.id AND l.is_cancelled = 0
       );
