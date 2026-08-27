-- 原酒タンクの残量ビュー
--
-- v_tank_monitor は tank_ledger（浄酎容器変動履歴）のみを集計するため、
-- 原酒タンク（SP等）の残量は含まれない（DB_SCHEMA_DESIGN.md 8-8の既知の注意点）。
-- 蒸留開始時に「そのタンクから本当にその量を払い出せるか」を検査したいので、
-- raw_sake_ledger 側を集計する専用ビューを追加する。

CREATE VIEW v_raw_sake_tank_volume AS
SELECT
  t.id AS tank_id,
  t.code,
  t.name,
  t.max_volume_l,
  t.initial_volume_l
    + COALESCE((
        SELECT SUM(l.quantity) FROM raw_sake_ledger l
        WHERE l.to_tank_id = t.id AND l.txn_type = '受入'
      ), 0)
    - COALESCE((
        SELECT SUM(l.quantity) FROM raw_sake_ledger l
        WHERE l.from_tank_id = t.id AND l.txn_type = '払出'
      ), 0) AS current_volume_l
FROM tanks t;
