-- migrate:no-transaction
-- 得意先の本店・支店を表せるようにする。
--
-- カナカンのように支店を持つ会社が、いまは別々の得意先として並んでいる。
-- 実務は「請求・与信・担当は本店単位、受注・納品は支店単位」で回っており、
-- 実際にカナカン富山・福井は支払いサイトが空欄のままで、
-- そのままだと受注を入れても入金予定日が出ない。
--
-- 取引先グループの表を別に作らず、得意先の自己参照で表す。
-- 本店にも直接受注が来るので、本店も得意先の1つである方が実態に合う。
-- 3段（本社→支社→営業所）になっても同じ仕組みで伸びる。

ALTER TABLE customers ADD COLUMN parent_id INTEGER REFERENCES customers(id);

-- ============================================================
-- 掛率を「未設定」にできるようにする
-- ============================================================
-- markup_rate は NOT NULL DEFAULT 1 だったので、「まだ決めていない」と
-- 「1.0（上代どおり）」を区別できなかった。掛率1は消費者向けで実在する値なので、
-- 1を未設定とみなすこともできない。
--
-- これだと支店を新しく登録したときに掛率が黙って1.0（上代どおり）になり、
-- 卸相手なら大きな値付けの誤りになる。先日直した「支払いサイトが空でも
-- 当月末日になる」のと同じ形の問題なので、ここも空を空のまま持てるようにする。
--
-- 使う側は既に markup_rate ?? 1 で受けているので、挙動は変わらない。

PRAGMA foreign_keys = OFF;

BEGIN;

DROP VIEW IF EXISTS v_quotations;

CREATE TABLE customers_new (
  id                 INTEGER PRIMARY KEY,
  uid                TEXT NOT NULL UNIQUE,
  code               TEXT UNIQUE,
  name               TEXT NOT NULL UNIQUE,
  segment            TEXT,
  business_type      TEXT,
  markup_rate        REAL,                     -- 空なら未設定（本店から引き継ぐ／使う側で1とみなす）
  address            TEXT,
  payment_term_months INTEGER,
  payment_term_day   TEXT,
  invoice_due_note   TEXT,
  sales_rep          TEXT,
  sales_sub_rep      TEXT,
  sales_channel      TEXT,
  last_visited_on    TEXT CHECK (last_visited_on IS NULL OR last_visited_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  onboarded_month    TEXT CHECK (onboarded_month IS NULL OR onboarded_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  postal_code        TEXT,
  phone              TEXT,
  invoice_email      TEXT,
  invoice_contact    TEXT,
  order_email        TEXT,
  order_phone        TEXT,
  order_contact      TEXT,
  sales_type         TEXT,
  last_ordered_on    TEXT,
  first_contacted_on TEXT,
  contract_signed_on TEXT,
  parent_id          INTEGER REFERENCES customers(id)
);

INSERT INTO customers_new
  SELECT id, uid, code, name, segment, business_type, markup_rate, address,
         payment_term_months, payment_term_day, invoice_due_note,
         sales_rep, sales_sub_rep, sales_channel, last_visited_on, onboarded_month, note,
         created_at, updated_at,
         postal_code, phone, invoice_email, invoice_contact,
         order_email, order_phone, order_contact, sales_type,
         last_ordered_on, first_contacted_on, contract_signed_on, parent_id
    FROM customers;

DROP TABLE customers;
ALTER TABLE customers_new RENAME TO customers;

CREATE INDEX idx_customers_parent ON customers(parent_id);

-- 作り直しで落としたビューを戻す（0011と同じ定義）
CREATE VIEW v_quotations AS
SELECT
  q.*,
  c.name AS customer_name,
  p.name AS product_name,
  ROUND(q.unit_price * q.markup_rate)                              AS sales_price,
  ROUND(q.unit_price * q.markup_rate) - q.cost_price               AS profit_per_unit,
  ROUND(q.unit_price * q.markup_rate) * q.quantity                 AS deal_amount,
  (ROUND(q.unit_price * q.markup_rate) - q.cost_price) * q.quantity AS deal_profit,
  ROUND(ROUND(q.unit_price * q.markup_rate) * q.quantity * COALESCE(q.probability, 0)) AS weighted_amount
FROM quotations q
JOIN customers c ON c.id = q.customer_id
JOIN products  p ON p.id = q.product_id;

COMMIT;

PRAGMA foreign_keys = ON;
