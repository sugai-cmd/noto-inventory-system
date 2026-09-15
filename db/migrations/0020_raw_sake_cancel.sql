-- 原料受払記録を取り消せるようにする
--
-- 4つの台帳のうち raw_sake_ledger だけが取消の列を持っていなかった
-- （商品・資材・浄酎は 0006 までに is_cancelled ほか3列が入っている）。
-- そのため原酒入荷や棚卸を打ち間違えても、画面から直す手段が無かった。
--
-- 台帳なので物理削除はしない。原酒受払IDは外から参照される番号で、
-- 消すと番号が飛ぶ。他の3台帳と同じく取消フラグを立てる。
--
-- 表の作り直しは要らない（0019 で作り直したばかりの表に列を足すだけ）。

ALTER TABLE raw_sake_ledger ADD COLUMN is_cancelled  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE raw_sake_ledger ADD COLUMN cancel_reason TEXT;
ALTER TABLE raw_sake_ledger ADD COLUMN cancelled_at  TEXT;
ALTER TABLE raw_sake_ledger ADD COLUMN cancelled_by  INTEGER REFERENCES users(id);

-- 残量から取消済みを外す。
--
-- v_product_stock / v_material_stock / v_tank_monitor はいずれも取消済みの行を
-- 0として数えている。原酒だけ数え続けるわけにいかない。
-- 0019 の定義に `AND l.is_cancelled = 0` を足しただけで、ほかは同じ。
DROP VIEW v_raw_sake_tank_volume;

CREATE VIEW v_raw_sake_tank_volume AS
SELECT
  t.id AS tank_id,
  t.code,
  t.name,
  t.max_volume_l,
  t.initial_volume_l
    + COALESCE((
        SELECT SUM(l.quantity) FROM raw_sake_ledger l
        WHERE l.to_tank_id = t.id AND l.txn_type IN ('受入', '棚卸調整')
          AND l.is_cancelled = 0
      ), 0)
    - COALESCE((
        SELECT SUM(l.quantity) FROM raw_sake_ledger l
        WHERE l.from_tank_id = t.id AND l.txn_type IN ('払出', '欠減')
          AND l.is_cancelled = 0
      ), 0) AS current_volume_l
FROM tanks t;
