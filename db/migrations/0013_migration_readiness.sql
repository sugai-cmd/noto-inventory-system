-- migrate:no-transaction
--
-- 実データを移行スクリプトに通して見つかった、スキーマ側の不足を埋める。
--
--  1. 商品在庫変動履歴の「未納税移出」を受払の種類として認める
--  2. 委託販売実績報告が受注に紐付かない実態に合わせる（C始まりの独自番号）
--  3. 販促資料だけの送付を残せるようにする（サンプル送付の商品を任意にする）
--  4. 得意先に連絡先の列を足す（顧客リストシートの内容を取り込むため）
--  5. 過去の伝票番号を新採番へ振り直すので、元の番号を残す列を足す
--
-- 1〜3はCHECK制約とNOT NULLを変えるためテーブルの作り直しが必要で、
-- SQLiteでは外部キーを一時的に切る必要がある（トランザクション内ではPRAGMAが効かない）。
-- そのためこのファイルはトランザクション外で実行する（先頭行のマーカー）。

PRAGMA foreign_keys = OFF;

BEGIN;

-- ============================================================
-- 1. 未納税移出（商品在庫変動履歴）
-- ============================================================
-- 瓶詰め済みの浄酎を、課税前のまま熟成室などへ移す記録。実データに3件あった。
-- 受入元/払出先が瓶詰めの商品履歴ID（L2605-0002 など）を指しており、
-- 保管場所も熟成室なので、**仕掛品から出ていく**動きとして扱う。

-- ビューがテーブルを参照しているので、作り直しの前に落としておく
DROP VIEW IF EXISTS v_product_stock;

CREATE TABLE product_stock_ledger_new (
  id             INTEGER PRIMARY KEY,
  history_code   TEXT UNIQUE,
  txn_date       TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  txn_type       TEXT NOT NULL CHECK (txn_type IN (
                    '瓶詰','箱詰','出荷','返品','未納税移出',
                    '棚卸調整_商品','棚卸調整_仕掛品',
                    '欠損_商品','欠損_仕掛品'
                 )),
  quantity       REAL NOT NULL,
  counterparty   TEXT,
  order_id       INTEGER REFERENCES orders(id),
  sample_shipment_id INTEGER REFERENCES sample_shipments(id),
  volume_ml      REAL,
  tax_amount     REAL,
  storage_place  TEXT,
  data_kind      TEXT,
  is_cancelled   INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_by     INTEGER REFERENCES users(id),
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  cancelled_by   INTEGER REFERENCES users(id),
  CHECK (order_id IS NULL OR sample_shipment_id IS NULL)
);

INSERT INTO product_stock_ledger_new
  SELECT id, history_code, txn_date, product_id, txn_type, quantity, counterparty,
         order_id, sample_shipment_id, volume_ml, tax_amount, storage_place, data_kind,
         is_cancelled, note, created_at, updated_at, created_by,
         cancel_reason, cancelled_at, cancelled_by
    FROM product_stock_ledger;

DROP TABLE product_stock_ledger;
ALTER TABLE product_stock_ledger_new RENAME TO product_stock_ledger;

CREATE INDEX idx_psl_product ON product_stock_ledger(product_id, txn_date);
CREATE INDEX idx_psl_order   ON product_stock_ledger(order_id);
CREATE INDEX idx_psl_sample  ON product_stock_ledger(sample_shipment_id);

CREATE VIEW v_product_stock AS
SELECT
  p.id AS product_id,
  p.name,
  p.initial_product_stock
    + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.txn_type = '箱詰' THEN l.quantity          -- 仕掛品→商品への振替（+商品）
        WHEN l.txn_type = '出荷' THEN -l.quantity
        WHEN l.txn_type = '返品' THEN l.quantity
        WHEN l.txn_type = '棚卸調整_商品' THEN l.quantity
        WHEN l.txn_type = '欠損_商品' THEN -l.quantity
        ELSE 0 END), 0) AS product_stock,
  p.initial_wip_stock
    + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.txn_type = '瓶詰' THEN l.quantity
        WHEN l.txn_type = '箱詰' THEN -l.quantity
        -- 未納税移出は瓶詰めロットからの払い出し（保管場所は熟成室）なので仕掛品を減らす
        WHEN l.txn_type = '未納税移出' THEN -l.quantity
        WHEN l.txn_type = '棚卸調整_仕掛品' THEN l.quantity
        WHEN l.txn_type = '欠損_仕掛品' THEN -l.quantity
        ELSE 0 END), 0) AS wip_stock
FROM products p
LEFT JOIN product_stock_ledger l ON l.product_id = p.id
GROUP BY p.id;

-- ============================================================
-- 2. 委託販売実績報告は受注に紐付かない
-- ============================================================
-- シートの「受注番号」列に入っているのは C2606-0001 のような**この報告自身の番号**で、
-- 受注リストの受注番号ではなかった（実データ18件すべてC始まり）。
-- 得意先と商品の組み合わせも受注リストに無いものが多い。
-- 報告番号を持つ列を足し、受注への紐付けは任意にする。

CREATE TABLE consignment_reports_new (
  id              INTEGER PRIMARY KEY,
  report_no       TEXT UNIQUE,                            -- C+年月+連番（委託販売実績報告の番号）
  order_id        INTEGER REFERENCES orders(id),          -- 対応する受注があるときだけ入る
  report_month    TEXT NOT NULL CHECK (report_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  quantity        INTEGER NOT NULL,
  unit_price      REAL,
  markup_rate     REAL,
  sales_amount    REAL,
  shipping_fee    REAL,
  invoiced_on     TEXT CHECK (invoiced_on IS NULL OR invoiced_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  payment_due_on  TEXT CHECK (payment_due_on IS NULL OR payment_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  paid_on         TEXT CHECK (paid_on IS NULL OR paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note            TEXT,
  created_by      INTEGER REFERENCES users(id)
);

INSERT INTO consignment_reports_new
  (id, order_id, report_month, customer_id, product_id, quantity, unit_price, markup_rate,
   sales_amount, shipping_fee, invoiced_on, payment_due_on, paid_on, note, created_by)
  SELECT id, order_id, report_month, customer_id, product_id, quantity, unit_price, markup_rate,
         sales_amount, shipping_fee, invoiced_on, payment_due_on, paid_on, note, created_by
    FROM consignment_reports;

DROP TABLE consignment_reports;
ALTER TABLE consignment_reports_new RENAME TO consignment_reports;

-- ============================================================
-- 3. サンプル送付は商品を伴わないことがある
-- ============================================================
-- シート名は「サンプル、販促資料送付」で、パンフレットだけを送った行が実データに2件ある。
-- product_id が NOT NULL だとこの行を残せず、送った記録そのものが消える。

CREATE TABLE sample_shipments_new (
  id            INTEGER PRIMARY KEY,
  sample_no     TEXT NOT NULL UNIQUE,
  shipped_on    TEXT NOT NULL CHECK (shipped_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  customer_id   INTEGER REFERENCES customers(id),
  contact_name  TEXT,
  product_id    INTEGER REFERENCES products(id),   -- 販促資料だけの送付では空
  quantity      INTEGER,                            -- 同上
  followup_on   TEXT CHECK (followup_on IS NULL OR followup_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  phone         TEXT,
  data_kind     TEXT,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id)
);

INSERT INTO sample_shipments_new
  SELECT id, sample_no, shipped_on, customer_id, contact_name, product_id, quantity,
         followup_on, phone, data_kind, note, created_by
    FROM sample_shipments;

DROP TABLE sample_shipments;
ALTER TABLE sample_shipments_new RENAME TO sample_shipments;

-- ============================================================
-- 4. 得意先の連絡先（顧客リストシートの内容）
-- ============================================================
-- 得意先マスタ（156行）には無く、顧客リスト（90行）にだけある項目。
-- 掛け率と請求・入金の期日は得意先マスタを正とするので、ここには取り込まない
-- （顧客リストの掛け率は 60 / 80 の％表記で、マスタの 0.6 / 0.8 とは別物）。
ALTER TABLE customers ADD COLUMN postal_code       TEXT;  -- 郵便番号
ALTER TABLE customers ADD COLUMN phone             TEXT;  -- 電話番号
ALTER TABLE customers ADD COLUMN invoice_email     TEXT;  -- 請求書送付先メール
ALTER TABLE customers ADD COLUMN invoice_contact   TEXT;  -- 請求書の担当者氏名
ALTER TABLE customers ADD COLUMN order_email       TEXT;  -- 発注・進行案件窓口のメール
ALTER TABLE customers ADD COLUMN order_phone       TEXT;  -- 発注・進行案件窓口の電話
ALTER TABLE customers ADD COLUMN order_contact     TEXT;  -- 発注・進行案件窓口の担当者氏名
ALTER TABLE customers ADD COLUMN sales_type        TEXT;  -- 販売形態（買取／委託）
ALTER TABLE customers ADD COLUMN last_ordered_on   TEXT;  -- 最終注文日
ALTER TABLE customers ADD COLUMN first_contacted_on TEXT; -- 初回接触日
ALTER TABLE customers ADD COLUMN contract_signed_on TEXT; -- 売買契約書締結日

-- ============================================================
-- 5. 振り直す前の伝票番号を残す
-- ============================================================
-- 過去の受注番号（D2605-0001）は蒸留IDと、原酒受払ID（M2603-0001）は資材履歴IDと
-- 同じ形で衝突していたため、移行時に O / R へ振り直す。
-- 移行後しばらくはシートと突き合わせるので、元の番号を残しておく。
ALTER TABLE orders          ADD COLUMN legacy_order_no TEXT;
ALTER TABLE raw_sake_ledger ADD COLUMN legacy_lot_code TEXT;

CREATE INDEX idx_orders_legacy   ON orders(legacy_order_no);
CREATE INDEX idx_rawsake_legacy  ON raw_sake_ledger(legacy_lot_code);

COMMIT;

PRAGMA foreign_keys = ON;
