-- migrate:no-transaction
-- 原酒タンクの棚卸に対応する
--
-- raw_sake_ledger.txn_type は ('受入','払出') だけで、3つの台帳のうち
-- 原酒だけが棚卸の区分を持っていなかった
-- （資材は 0003 で ('入荷','消費','棚卸調整','欠損')、
--   浄酎は最初から ('継足','瓶詰',…,'欠減','棚卸調整','取消戻し')）。
--
-- 受入・払出で代用すると原酒入荷の履歴に棚卸が混ざり、
-- 原酒受払IDの帯（千の位＝その月の何回目の移入か。0018直前のPR参照）の意味も崩れる。
--
-- PR #38 で原酒タンクの棚卸は塞いである（浄酎の台帳に調整が書かれて
-- 原酒の残量はまったく直らなかったため）。ここで原酒専用の棚卸を作って戻す。
--
-- SQLiteはCHECK制約をALTERできないので、0003 と同じく表を作り直して移送する。
-- ただし 0003 と違い、この表は distillation_details.raw_sake_ledger_id から
-- 参照されている（実データで79行）。DROP/RENAME で参照が壊れないよう、
-- 0014 / 0015 と同じく外部キーを切った状態で入れ替える。

PRAGMA foreign_keys = OFF;

BEGIN;

-- SQLiteは「ビューが参照しているテーブル」のDROP/RENAMEを拒むので、先に落とす
DROP VIEW v_raw_sake_tank_volume;

-- 列は現物どおり。**この台帳に is_cancelled は無い**
-- （created_by / source_ref / legacy_lot_code は 0005 以降の ALTER で足されたもの）
CREATE TABLE raw_sake_ledger_new (
  id              INTEGER PRIMARY KEY,
  lot_code        TEXT UNIQUE,                   -- 原酒受払ID
  txn_date        TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  txn_type        TEXT NOT NULL CHECK (txn_type IN ('受入','払出','棚卸調整','欠減')),
  from_tank_id    INTEGER REFERENCES tanks(id),         -- 受入元（払出・欠減の場合：出ていくタンク）
  to_ref          TEXT,                          -- 払出先（受入先タンクID or 蒸留ID。用途混在のため文字列＋下2列で正規化）
  to_tank_id      INTEGER REFERENCES tanks(id),
  distillation_id INTEGER REFERENCES distillations(id),
  quantity        REAL NOT NULL,
  raw_sake_brand_id INTEGER REFERENCES raw_sake_brands(id), -- 原酒スペック（緩やかな対応をID化）
  spec_note       TEXT,                          -- 正規化できない自由記述の原酒スペック
  is_fifo_estimated INTEGER DEFAULT 0,           -- 過去データ一括変換時のFIFO推定フラグ
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      INTEGER REFERENCES users(id),
  source_ref      TEXT,
  legacy_lot_code TEXT
);

INSERT INTO raw_sake_ledger_new
  (id, lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
   quantity, raw_sake_brand_id, spec_note, is_fifo_estimated, note,
   created_at, updated_at, created_by, source_ref, legacy_lot_code)
SELECT
  id, lot_code, txn_date, txn_type, from_tank_id, to_ref, to_tank_id, distillation_id,
  quantity, raw_sake_brand_id, spec_note, is_fifo_estimated, note,
  created_at, updated_at, created_by, source_ref, legacy_lot_code
FROM raw_sake_ledger;

DROP TABLE raw_sake_ledger;
ALTER TABLE raw_sake_ledger_new RENAME TO raw_sake_ledger;

-- 索引はこれ1本（lot_code の UNIQUE は表の定義に含まれるので一緒に戻る）
CREATE INDEX idx_rawsake_legacy ON raw_sake_ledger(legacy_lot_code);

-- 新しい区分を集計に入れてビューを作り直す。
-- 増える側（to_tank_id）に棚卸調整を、減る側（from_tank_id）に欠減を足すだけで、
-- ほかは 0002 の定義のまま。
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
      ), 0)
    - COALESCE((
        SELECT SUM(l.quantity) FROM raw_sake_ledger l
        WHERE l.from_tank_id = t.id AND l.txn_type IN ('払出', '欠減')
      ), 0) AS current_volume_l
FROM tanks t;

COMMIT;

PRAGMA foreign_keys = ON;
