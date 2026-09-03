-- 見積管理（シート「見積済み」）。
--
-- 列はシートのとおり:
--   見積日 / 得意先名 / 商品名 / 個数 / 単価 / 原価 / 掛け率 / 売価 /
--   1本あたり利益額 / 取引金額 / 取引利益 / 確度 / 納品予定日 / 備考
--
-- 売価・1本あたり利益額・取引金額・取引利益はシートでは計算列なので、
-- こちらでも保存せずビューで出す（二重管理を避ける。0章の方針）。
-- 得意先・商品は名前で書かれているが、こちらではIDで結ぶ（名前が変わっても追える）。

CREATE TABLE quotations (
  id             INTEGER PRIMARY KEY,
  uid            TEXT NOT NULL UNIQUE,      -- 固有ID（8桁ランダム小文字英数字）
  quoted_on      TEXT NOT NULL CHECK (quoted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 見積日
  customer_id    INTEGER NOT NULL REFERENCES customers(id),  -- 得意先名
  product_id     INTEGER NOT NULL REFERENCES products(id),   -- 商品名
  quantity       INTEGER NOT NULL,          -- 個数
  unit_price     REAL,                      -- 単価（登録時点の上代のスナップショット）
  cost_price     REAL,                      -- 原価
  markup_rate    REAL,                      -- 掛け率
  probability    REAL,                      -- 確度（0〜1。シートは80%表記）
  delivery_due_on TEXT CHECK (delivery_due_on IS NULL OR delivery_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 納品予定日
  status         TEXT NOT NULL DEFAULT '見積中',  -- 見積中/受注/失注
  order_no       TEXT,                      -- 受注になった場合の受注番号
  note           TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quotations_customer ON quotations(customer_id);
CREATE INDEX idx_quotations_date     ON quotations(quoted_on);

-- 金額はここで算出する（シートの計算列と同じ式）
CREATE VIEW v_quotations AS
SELECT
  q.*,
  c.name AS customer_name,
  p.name AS product_name,
  ROUND(q.unit_price * q.markup_rate)                              AS sales_price,      -- 売価
  ROUND(q.unit_price * q.markup_rate) - q.cost_price               AS profit_per_unit,  -- 1本あたり利益額
  ROUND(q.unit_price * q.markup_rate) * q.quantity                 AS deal_amount,      -- 取引金額
  (ROUND(q.unit_price * q.markup_rate) - q.cost_price) * q.quantity AS deal_profit,     -- 取引利益
  -- 確度をかけた見込み額。営業の積み上げに使う
  ROUND(ROUND(q.unit_price * q.markup_rate) * q.quantity * COALESCE(q.probability, 0)) AS weighted_amount
FROM quotations q
JOIN customers c ON c.id = q.customer_id
JOIN products  p ON p.id = q.product_id;
