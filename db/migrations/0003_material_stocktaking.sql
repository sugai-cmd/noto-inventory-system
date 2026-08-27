-- 資材在庫の棚卸調整・欠損に対応する
--
-- material_stock_ledger.txn_type は現行シート踏襲で ('入荷','消費') のみだったが、
-- 棚卸で実測値と理論値の差を記録するには専用の区分が要る
-- （商品在庫側は '棚卸調整_商品' / '欠損_商品' が既にある）。
-- SQLiteはCHECK制約をALTERできないため、テーブルを作り直して移送する。

-- SQLiteは「ビューが参照しているテーブル」のDROP/RENAMEを拒否するため、
-- 先にビューを落としてからテーブルを作り替え、最後にビューを定義し直す。
DROP VIEW v_material_stock;

CREATE TABLE material_stock_ledger_new (
  id               INTEGER PRIMARY KEY,
  history_code     TEXT UNIQUE,
  txn_date         TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  material_id      INTEGER NOT NULL REFERENCES materials(id),
  txn_type         TEXT NOT NULL CHECK (txn_type IN ('入荷','消費','棚卸調整','欠損')),
  quantity         REAL NOT NULL,
  counterparty     TEXT,
  product_ledger_id INTEGER REFERENCES product_stock_ledger(id),
  unit_price       REAL,
  total_price      REAL,
  data_kind        TEXT,
  is_cancelled     INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO material_stock_ledger_new
  (id, history_code, txn_date, material_id, txn_type, quantity, counterparty,
   product_ledger_id, unit_price, total_price, data_kind, is_cancelled, note,
   created_at, updated_at)
SELECT
  id, history_code, txn_date, material_id, txn_type, quantity, counterparty,
  product_ledger_id, unit_price, total_price, data_kind, is_cancelled, note,
  created_at, updated_at
FROM material_stock_ledger;

DROP TABLE material_stock_ledger;
ALTER TABLE material_stock_ledger_new RENAME TO material_stock_ledger;

CREATE INDEX idx_msl_material ON material_stock_ledger(material_id, txn_date);
CREATE INDEX idx_msl_product_ledger ON material_stock_ledger(product_ledger_id);

-- 新しい区分を集計に反映してビューを再作成する
CREATE VIEW v_material_stock AS
SELECT
  m.id AS material_id,
  m.name,
  m.initial_stock
    + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.txn_type = '入荷' THEN l.quantity
        WHEN l.txn_type = '消費' THEN -l.quantity
        WHEN l.txn_type = '棚卸調整' THEN l.quantity   -- 実測が理論を上回った分
        WHEN l.txn_type = '欠損' THEN -l.quantity      -- 実測が理論を下回った分
        ELSE 0 END), 0) AS current_stock
FROM materials m
LEFT JOIN material_stock_ledger l ON l.material_id = m.id
GROUP BY m.id;
