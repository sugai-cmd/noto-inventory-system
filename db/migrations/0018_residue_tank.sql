-- 残渣の行き先を、自由文からタンクマスタへ紐付ける。
--
-- distillation_residues.destination は自由文で、タンクマスタと結び付いていなかった。
-- 実データは7件すべて「黒タンク6」（合計 95.8L）で、タンクマスタに同名の容器は無い
-- （残渣タンクは「残渣保管タンク1〜6」）。そのため残渣タンク6本は記録に繋がらず、
-- タンク別の量が出せなかった。
--
-- destination の文字は消さない。元の記録として残す。
-- ただし新しい記録では書かない（タンクIDが唯一の出どころ。同じ事実を2箇所に持つと
-- 片方だけ直る事故が起きる）。画面はタンクIDが無い行だけ destination の文字を出す。

ALTER TABLE distillation_residues ADD COLUMN destination_tank_id INTEGER REFERENCES tanks(id);

-- 既存7件の紐付け。**機械で当てない。**
-- 「黒タンク6」が残渣保管タンク6（U-006）であることは利用者に確認した。
-- 容器IDと名称の両方で照合するので、どちらかが違えば1件も紐付かず、
-- その行は在庫タブの「タンク未設定」に出る（黙って別のタンクに入れない）。
UPDATE distillation_residues
   SET destination_tank_id = (
         SELECT id FROM tanks WHERE code = 'U-006' AND name = '残渣保管タンク6'
       )
 WHERE destination = '黒タンク6' AND destination_tank_id IS NULL;

-- タンク別の回収累計。
--
-- **残量ではない。** 残渣には払出（廃棄）の記録がどこにも無いので、この数字は
-- 増えるだけで減らない。名前を collected_l にして、画面にもその旨を明記する。
--
-- v_raw_sake_tank_volume（0002）と同じで全タンクを対象にし、
-- 残渣タンクへの絞り込みはルート側でやる（容器IDの接頭辞の知識をSQLに散らさない）。
CREATE VIEW v_residue_tank_collected AS
SELECT
  t.id   AS tank_id,
  t.code,
  t.name,
  t.max_volume_l,
  t.discarded_on,
  COALESCE(SUM(r.quantity), 0) AS collected_l,
  COUNT(r.id)                  AS collection_count,
  MAX(r.collected_on)          AS last_collected_on
FROM tanks t
LEFT JOIN distillation_residues r ON r.destination_tank_id = t.id
GROUP BY t.id;
