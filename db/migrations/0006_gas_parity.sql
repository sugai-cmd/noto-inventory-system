-- migrate:no-transaction
--
-- 最新のGAS版READMEとの突合で見つかった差分を埋める。
--
--  1. 受注番号のUNIQUEを外す（1受注で複数商品＝同じ受注番号で複数行。DATA_STRUCTURE.md 3章）
--  2. 台帳の取消に理由・実施者・日時を残す
--  3. 箱詰めがどの瓶詰めロットを消費したかを記録する
--  4. 送料計算のマスタ（地帯／段ボール対応表／料金表）
--  5. 営業メモ
--  6. タンクの廃棄（履歴を残して一覧から隠す）
--  7. 蒸留の未対応アラートの消込
--
-- ordersはUNIQUE制約を外すためにテーブル再作成が必要で、
-- SQLiteでは外部キーを一時的に切る必要がある（トランザクション内ではPRAGMAが効かない）。
-- そのためこのファイルだけトランザクション外で実行する（先頭行のマーカー）。

PRAGMA foreign_keys = OFF;

BEGIN;

-- 1. 受注番号のUNIQUEを外し、明細行番号を持たせる ---------------------------

CREATE TABLE orders_rebuild (
  id                 INTEGER PRIMARY KEY,
  order_no           TEXT NOT NULL,             -- O+年月+連番。1受注で複数商品なら同じ番号が複数行に並ぶ
  line_no            INTEGER NOT NULL DEFAULT 1, -- 受注番号内の明細行番号（1始まり）
  ordered_on         TEXT NOT NULL CHECK (ordered_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  product_id         INTEGER NOT NULL REFERENCES products(id),
  quantity           INTEGER NOT NULL,
  unit_price         REAL,
  markup_rate        REAL,
  sales_amount       REAL,
  shipping_fee       REAL DEFAULT 0,
  total_amount       REAL,
  requested_delivery_on TEXT CHECK (requested_delivery_on IS NULL OR requested_delivery_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  invoiced_on        TEXT CHECK (invoiced_on IS NULL OR invoiced_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  payment_due_on     TEXT CHECK (payment_due_on IS NULL OR payment_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  paid_on            TEXT CHECK (paid_on IS NULL OR paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sales_method       TEXT,
  delivery_method    TEXT,
  status             TEXT NOT NULL DEFAULT '未着手',
  delivery_address   TEXT,
  shipping_zone      TEXT,                      -- 送料計算で判定した地帯（記録用）
  carton_size        TEXT,                      -- 送料計算で判定した段ボール（記録用）
  delivered_on       TEXT CHECK (delivered_on IS NULL OR delivered_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note               TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO orders_rebuild
  (id, order_no, line_no, ordered_on, customer_id, product_id, quantity, unit_price, markup_rate,
   sales_amount, shipping_fee, total_amount, requested_delivery_on, invoiced_on, payment_due_on,
   paid_on, sales_method, delivery_method, status, delivery_address, delivered_on, note,
   created_by, created_at, updated_at)
SELECT
   id, order_no, 1, ordered_on, customer_id, product_id, quantity, unit_price, markup_rate,
   sales_amount, shipping_fee, total_amount, requested_delivery_on, invoiced_on, payment_due_on,
   paid_on, sales_method, delivery_method, status, delivery_address, delivered_on, note,
   created_by, created_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_rebuild RENAME TO orders;

CREATE INDEX idx_orders_customer  ON orders(customer_id);
CREATE INDEX idx_orders_product   ON orders(product_id);
CREATE INDEX idx_orders_status    ON orders(status);
CREATE INDEX idx_orders_no        ON orders(order_no);
CREATE UNIQUE INDEX ux_orders_line ON orders(order_no, line_no);

-- 2. 取消の理由・実施者を台帳に残す -----------------------------------------
-- （旧GASの「修正履歴」シート相当。台帳の行そのものに持たせる）

ALTER TABLE product_stock_ledger  ADD COLUMN cancel_reason TEXT;
ALTER TABLE product_stock_ledger  ADD COLUMN cancelled_at  TEXT;
ALTER TABLE product_stock_ledger  ADD COLUMN cancelled_by  INTEGER REFERENCES users(id);

ALTER TABLE material_stock_ledger ADD COLUMN cancel_reason TEXT;
ALTER TABLE material_stock_ledger ADD COLUMN cancelled_at  TEXT;
ALTER TABLE material_stock_ledger ADD COLUMN cancelled_by  INTEGER REFERENCES users(id);

ALTER TABLE tank_ledger           ADD COLUMN cancel_reason TEXT;
ALTER TABLE tank_ledger           ADD COLUMN cancelled_at  TEXT;
ALTER TABLE tank_ledger           ADD COLUMN cancelled_by  INTEGER REFERENCES users(id);

-- 3. 仕掛品ロットの引当 -------------------------------------------------------
-- 箱詰め1件が、どの瓶詰めロット（＝瓶詰めの台帳行）から何本引いたかを持つ。
-- 合計だけを見ていた従来のやり方では、ロット単位の追跡と取消の復元ができない。

CREATE TABLE wip_lot_allocations (
  id                  INTEGER PRIMARY KEY,
  boxing_ledger_id    INTEGER NOT NULL REFERENCES product_stock_ledger(id),   -- 箱詰めの行
  bottling_ledger_id  INTEGER NOT NULL REFERENCES product_stock_ledger(id),   -- 引当元の瓶詰めロット
  quantity            REAL NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_wip_alloc_boxing   ON wip_lot_allocations(boxing_ledger_id);
CREATE INDEX idx_wip_alloc_bottling ON wip_lot_allocations(bottling_ledger_id);

-- 4. 送料計算のマスタ ---------------------------------------------------------
-- 実際の料金・地帯区分は運賃表を見て登録してもらう。推測値は入れない。

CREATE TABLE prefecture_zones (
  prefecture TEXT PRIMARY KEY,                  -- 都道府県名（「石川県」のように県まで含む）
  zone       TEXT NOT NULL,                     -- 地帯名（運賃表の区分名をそのまま）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE carton_rules (                     -- 旧「段ボール対応表」
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL,                 -- 本数（完全一致で引く）
  carton_size TEXT NOT NULL,                    -- 段ボールのサイズ区分（運賃表の区分名）
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_carton_rules ON carton_rules(product_id, quantity);

CREATE TABLE shipping_rates (
  id          INTEGER PRIMARY KEY,
  zone        TEXT NOT NULL,
  carton_size TEXT NOT NULL,
  fee         REAL NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_shipping_rates ON shipping_rates(zone, carton_size);

-- 5. 営業メモ -----------------------------------------------------------------

CREATE TABLE customer_notes (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  noted_on    TEXT NOT NULL CHECK (noted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body        TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_customer_notes ON customer_notes(customer_id, noted_on);

-- 6. タンクの廃棄 -------------------------------------------------------------
-- 行は消さず、廃棄日を入れて選択肢から外す。過去の履歴が参照できなくなるため。

ALTER TABLE tanks ADD COLUMN discarded_on   TEXT CHECK (discarded_on IS NULL OR discarded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE tanks ADD COLUMN discard_reason TEXT;

-- 7. 未対応アラートの消込 -----------------------------------------------------

ALTER TABLE distillations ADD COLUMN alert_acknowledged_on TEXT CHECK (alert_acknowledged_on IS NULL OR alert_acknowledged_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE distillations ADD COLUMN alert_acknowledged_by INTEGER REFERENCES users(id);
ALTER TABLE distillations ADD COLUMN alert_acknowledged_note TEXT;

COMMIT;

PRAGMA foreign_keys = ON;
