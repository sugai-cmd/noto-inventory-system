-- このファイルは自動生成です。手で編集しないでください。
--
-- db/migrations/*.sql を順に当てた結果を書き出したものです。
-- 更新するには:  node scripts/dump-schema.js
--
-- 適用されるのは migrations のほうです（src/db/migrate.js）。
-- ここは「いまのスキーマ」を1か所で読むためのものです。

----------------------------------------------------------------------
-- テーブル
----------------------------------------------------------------------
CREATE TABLE breweries (                        -- 酒蔵マスタ（実質未使用、緩い扱い）
  id          INTEGER PRIMARY KEY,
  uid         TEXT NOT NULL UNIQUE,             -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  name        TEXT NOT NULL UNIQUE,
  address     TEXT,
  phone       TEXT,
  contact     TEXT,
  started_on  TEXT
, code TEXT);

CREATE TABLE carton_rules (                     -- 旧「段ボール対応表」
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL,                 -- 本数（完全一致で引く）
  carton_size TEXT NOT NULL,                    -- 段ボールのサイズ区分（運賃表の区分名）
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, box_name TEXT);

CREATE TABLE "consignment_reports" (
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

CREATE TABLE customer_notes (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  noted_on    TEXT NOT NULL CHECK (noted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body        TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, category TEXT);

CREATE TABLE "customers" (
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

CREATE TABLE distillation_details (
  id                INTEGER PRIMARY KEY,
  distillation_id   INTEGER NOT NULL REFERENCES distillations(id),
  raw_sake_ledger_id INTEGER NOT NULL REFERENCES raw_sake_ledger(id),
  input_l           REAL NOT NULL,
  source_tank_id    INTEGER REFERENCES tanks(id),  -- 元容器ID
  is_cancelled      INTEGER NOT NULL DEFAULT 0,
  note              TEXT
, detail_code TEXT);

CREATE TABLE distillation_residues (
  id               INTEGER PRIMARY KEY,
  distillation_id  INTEGER NOT NULL REFERENCES distillations(id),
  collected_on     TEXT NOT NULL CHECK (collected_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 残渣回収日
  collected_time   TEXT NOT NULL CHECK (collected_time GLOB '[0-9][0-9]:[0-9][0-9]'), -- 残渣回収時刻（HH:MM）。蒸留記録と同様の理由で日付と分離
  quantity         REAL,
  abv              REAL,
  salt_status      TEXT,                         -- 食塩ステータス
  salt_input_qty   REAL,                         -- 投入量（食塩等）
  salt_concentration REAL,                       -- 塩分濃度
  destination      TEXT                          -- 払出先（廃棄先/保管先）
);

CREATE TABLE distillations (                     -- 蒸留記録（ヘッダ）
  id                  INTEGER PRIMARY KEY,
  distillation_code   TEXT NOT NULL UNIQUE,      -- D+年月+連番（蒸留ID）
  started_on          TEXT NOT NULL CHECK (started_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 投入開始日
  started_time        TEXT NOT NULL CHECK (started_time GLOB '[0-9][0-9]:[0-9][0-9]'), -- 投入開始時刻（HH:MM）。24時間経過アラートの計算に使用するため日付と分離して保持
  input_summary       TEXT,                      -- 使用原酒明細（自由記述サマリ、詳細はdistillation_details）
  total_input_l       REAL,                      -- 投入量合計
  planned_duration    TEXT,                      -- 蒸留設定時間
  status              TEXT NOT NULL DEFAULT '蒸留中', -- 蒸留中/完了
  output_l            REAL,                      -- 蒸留量（完了時）
  output_abv          REAL,                      -- アルコール度数（完了時）
  output_tank_id      INTEGER REFERENCES tanks(id), -- 払出先
  residue_qty         REAL,                      -- 残渣回収量（サマリ、詳細はdistillation_residues）
  completed_on         TEXT CHECK (completed_on IS NULL OR completed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 完了日
  completed_time        TEXT CHECK (completed_time IS NULL OR completed_time GLOB '[0-9][0-9]:[0-9][0-9]')  -- 完了時刻（HH:MM）
, created_by INTEGER REFERENCES users(id), alert_acknowledged_on TEXT CHECK (alert_acknowledged_on IS NULL OR alert_acknowledged_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), alert_acknowledged_by INTEGER REFERENCES users(id), alert_acknowledged_note TEXT);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL,
  succeeded  INTEGER NOT NULL,
  ip_address TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "material_stock_ledger" (
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
, created_by INTEGER REFERENCES users(id), cancel_reason TEXT, cancelled_at  TEXT, cancelled_by  INTEGER REFERENCES users(id));

CREATE TABLE materials (
  id                INTEGER PRIMARY KEY,
  uid               TEXT NOT NULL UNIQUE,      -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  code              TEXT UNIQUE,               -- 資材ID
  name              TEXT NOT NULL UNIQUE,      -- 資材名（表記統一：資材名/資材名称→name）
  category          TEXT,                      -- 資材種別
  unit              TEXT,                      -- 単位
  unit_price        REAL,                      -- 単価(円)
  lot_size          INTEGER,                   -- ロット数
  proper_stock_qty  INTEGER,                   -- 適正在庫数
  initial_stock     INTEGER DEFAULT 0,         -- 初期在庫数（再計算の起点）
  supplier_name     TEXT,                      -- 発注先会社名
  supplier_address  TEXT,
  supplier_contact  TEXT,
  lead_time_days    INTEGER,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE operation_logs (
  id          INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     INTEGER REFERENCES users(id),
  username    TEXT,              -- 利用者が削除されても誰の操作か分かるよう控えておく
  action      TEXT NOT NULL,     -- 例: 'order.create', 'bottling.submit'
  target_type TEXT,              -- 例: 'orders'
  target_id   INTEGER,
  summary     TEXT,              -- 画面に出す一行説明
  detail_json TEXT               -- 補足情報（任意）
);

CREATE TABLE "orders" (
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
, legacy_order_no TEXT);

CREATE TABLE prefecture_zones (
  prefecture TEXT PRIMARY KEY,                  -- 都道府県名（「石川県」のように県まで含む）
  zone       TEXT NOT NULL,                     -- 地帯名（運賃表の区分名をそのまま）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE product_recipes (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  material_id  INTEGER NOT NULL REFERENCES materials(id),
  qty_required REAL NOT NULL,                  -- 必要数量（1本あたり）
  process      TEXT, recipe_code TEXT,                           -- ステータス（瓶詰/箱詰の区分）
  UNIQUE(product_id, material_id, process)
);

CREATE TABLE "product_stock_ledger" (
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

CREATE TABLE products (
  id                     INTEGER PRIMARY KEY,
  uid                    TEXT NOT NULL UNIQUE, -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  code                   TEXT UNIQUE,          -- 商品ID
  name                   TEXT NOT NULL UNIQUE, -- 商品名称（全シート共通の参照キー）
  volume_ml              INTEGER,              -- 容量(ml)
  abv                    REAL,                 -- 規定度数
  container_type         TEXT,                 -- 容器タイプ
  unit                   TEXT DEFAULT '本',
  list_price             REAL,                 -- 上代
  jan_code               TEXT,
  target_extract_spec    TEXT,                 -- 目標エキス分基準
  category               TEXT,                 -- 商品カテゴリ
  tax_per_unit           REAL,                 -- 課税額
  initial_product_stock  INTEGER DEFAULT 0,    -- 初期商品在庫数（再計算の起点）
  initial_wip_stock      INTEGER DEFAULT 0,    -- 初期仕掛品在庫数（再計算の起点）
  note                   TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE "raw_sake_brands" (
  id                INTEGER PRIMARY KEY,
  uid               TEXT NOT NULL UNIQUE,       -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  code              TEXT UNIQUE,                -- 原酒ID（シートの「ID」列。toriya-BYR6-L1 等）
  name              TEXT NOT NULL,              -- 銘柄（同じ銘柄の別ロットがあるので一意ではない）
  abv               REAL,                       -- アルコール度数
  sake_meter_value  REAL,                       -- 日本酒度
  brewery_id        INTEGER REFERENCES breweries(id), -- 酒蔵（緩やかな紐付け→ID化するが必須にしない）
  brewery_name_raw  TEXT,                       -- 移行データ用：正規化できなかった元の文字列
  status            TEXT,                       -- ステータス
  produced_on       TEXT,                       -- 製造年(月)。和暦等の自由記述を許容
  note              TEXT,
  registered_on     TEXT CHECK (registered_on IS NULL OR registered_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  initial_stock     REAL DEFAULT 0,             -- 初期在庫量
  current_stock     REAL DEFAULT 0              -- 現在在庫量（実質raw_sake_ledgerで管理、参考値）
);

CREATE TABLE raw_sake_ledger (                   -- 原料受払記録
  id              INTEGER PRIMARY KEY,
  lot_code        TEXT UNIQUE,                   -- 原酒受払ID
  txn_date        TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  txn_type        TEXT NOT NULL CHECK (txn_type IN ('受入','払出')),
  from_tank_id    INTEGER REFERENCES tanks(id),         -- 受入元（払出の場合：投入元タンク）
  to_ref          TEXT,                          -- 払出先（受入先タンクID or 蒸留ID。用途混在のため文字列＋下2列で正規化）
  to_tank_id      INTEGER REFERENCES tanks(id),
  distillation_id INTEGER REFERENCES distillations(id),
  quantity        REAL NOT NULL,
  raw_sake_brand_id INTEGER REFERENCES raw_sake_brands(id), -- 原酒スペック（緩やかな対応をID化）
  spec_note       TEXT,                          -- 正規化できない自由記述の原酒スペック
  is_fifo_estimated INTEGER DEFAULT 0,           -- 過去データ一括変換時のFIFO推定フラグ
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
, created_by INTEGER REFERENCES users(id), source_ref TEXT, legacy_lot_code TEXT);

CREATE TABLE resource_locks (
  id               INTEGER PRIMARY KEY,
  target_type      TEXT NOT NULL DEFAULT 'distillation',
  distillation_id  INTEGER REFERENCES distillations(id),
  locked_by        TEXT NOT NULL,                -- ユーザー
  locked_at        TEXT NOT NULL DEFAULT (datetime('now')) -- システムが自動設定する監査用タイムスタンプのため日付/時刻分離の対象外（2.0参照）
);

CREATE TABLE sales_targets (
  id             INTEGER PRIMARY KEY,
  target_month   TEXT NOT NULL UNIQUE CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), -- 対象月（YYYY-MM）
  target_amount  REAL NOT NULL,
  note           TEXT
);

CREATE TABLE "sample_shipments" (
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

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);

CREATE TABLE shipping_rates (
  id          INTEGER PRIMARY KEY,
  zone        TEXT NOT NULL,
  carton_size TEXT NOT NULL,
  fee         REAL NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tank_ledger (                       -- 浄酎容器変動履歴
  id                 INTEGER PRIMARY KEY,
  txn_date           TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  from_tank_id       INTEGER REFERENCES tanks(id),   -- 受入元
  txn_type           TEXT NOT NULL CHECK (txn_type IN (
                        '継足','瓶詰','容器移動','未納税移出',
                        '欠減','棚卸調整','取消戻し'
                     )),
  product_id         INTEGER REFERENCES products(id), -- 瓶詰め商品（瓶詰時のみ）
  to_tank_id         INTEGER REFERENCES tanks(id),   -- 払出先（「直接充填」等はto_tank_id=NULL＋note）
  quantity_l         REAL NOT NULL,
  abv                REAL,                       -- アルコール度数（加重平均、計算結果）
  product_ledger_id  INTEGER REFERENCES product_stock_ledger(id), -- 瓶詰め時の紐付け
  distillation_id    INTEGER REFERENCES distillations(id),        -- 継足時の紐付け
  data_kind          TEXT,
  is_cancelled       INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
, created_by INTEGER REFERENCES users(id), cancel_reason TEXT, cancelled_at  TEXT, cancelled_by  INTEGER REFERENCES users(id));

CREATE TABLE tanks (
  id                  INTEGER PRIMARY KEY,
  uid                 TEXT NOT NULL UNIQUE,     -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  code                TEXT NOT NULL UNIQUE,     -- 容器ID（T/B/SP/U/G/JP/Q/DISTL + 連番）
  name                TEXT NOT NULL UNIQUE,     -- 容器名称（他シートがこの名前で参照 → tank_ledgerではIDで参照させる）
  container_type      TEXT,                     -- 容器種別
  max_volume_l        REAL,                     -- 最大容量(L)
  location            TEXT,                     -- 現在設置場所
  status              TEXT,                     -- 稼働中/空/満タン/廃棄
  gauge_constant      REAL,                     -- 検尺定数
  initial_volume_l    REAL DEFAULT 0,           -- 初期在庫量
  current_volume_l    REAL DEFAULT 0,           -- 現在液量(L)（キャッシュ値。真値はv_tank_monitorで再計算）
  current_abv         REAL,                     -- 理論アルコール度数（同上）
  note                TEXT
, discarded_on   TEXT CHECK (discarded_on IS NULL OR discarded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), discard_reason TEXT);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  uid           TEXT NOT NULL UNIQUE,      -- 他マスタと同じ8桁ランダム小文字英数字
  username      TEXT NOT NULL UNIQUE,      -- ログインID
  display_name  TEXT NOT NULL,             -- 画面に出す名前
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_recovery_codes TEXT);

CREATE TABLE wip_lot_allocations (
  id                  INTEGER PRIMARY KEY,
  boxing_ledger_id    INTEGER NOT NULL REFERENCES product_stock_ledger(id),   -- 箱詰めの行
  bottling_ledger_id  INTEGER NOT NULL REFERENCES product_stock_ledger(id),   -- 引当元の瓶詰めロット
  quantity            REAL NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

----------------------------------------------------------------------
-- 索引
----------------------------------------------------------------------
CREATE INDEX idx_customer_notes ON customer_notes(customer_id, noted_on);

CREATE INDEX idx_customers_parent ON customers(parent_id);

CREATE INDEX idx_login_attempts_lookup ON login_attempts(username, attempted_at);

CREATE INDEX idx_msl_material ON material_stock_ledger(material_id, txn_date);

CREATE INDEX idx_msl_product_ledger ON material_stock_ledger(product_ledger_id);

CREATE INDEX idx_operation_logs_target ON operation_logs(target_type, target_id);

CREATE INDEX idx_operation_logs_time ON operation_logs(occurred_at);

CREATE INDEX idx_operation_logs_user ON operation_logs(user_id);

CREATE INDEX idx_orders_customer  ON orders(customer_id);

CREATE INDEX idx_orders_legacy   ON orders(legacy_order_no);

CREATE INDEX idx_orders_no        ON orders(order_no);

CREATE INDEX idx_orders_product   ON orders(product_id);

CREATE INDEX idx_orders_status    ON orders(status);

CREATE INDEX idx_psl_order   ON product_stock_ledger(order_id);

CREATE INDEX idx_psl_product ON product_stock_ledger(product_id, txn_date);

CREATE INDEX idx_psl_sample  ON product_stock_ledger(sample_shipment_id);

CREATE INDEX idx_quotations_customer ON quotations(customer_id);

CREATE INDEX idx_quotations_date     ON quotations(quoted_on);

CREATE INDEX idx_raw_sake_brands_name ON raw_sake_brands(name);

CREATE INDEX idx_rawsake_legacy  ON raw_sake_ledger(legacy_lot_code);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE INDEX idx_tl_from_tank ON tank_ledger(from_tank_id, txn_date);

CREATE INDEX idx_tl_to_tank   ON tank_ledger(to_tank_id, txn_date);

CREATE INDEX idx_wip_alloc_bottling ON wip_lot_allocations(bottling_ledger_id);

CREATE INDEX idx_wip_alloc_boxing   ON wip_lot_allocations(boxing_ledger_id);

CREATE UNIQUE INDEX ux_breweries_code ON breweries(code) WHERE code IS NOT NULL;

CREATE UNIQUE INDEX ux_carton_rules ON carton_rules(product_id, quantity);

CREATE UNIQUE INDEX ux_distillation_details_code
  ON distillation_details(detail_code) WHERE detail_code IS NOT NULL;

CREATE UNIQUE INDEX ux_orders_line ON orders(order_no, line_no);

CREATE UNIQUE INDEX ux_product_recipes_code ON product_recipes(recipe_code) WHERE recipe_code IS NOT NULL;

CREATE UNIQUE INDEX ux_shipping_rates ON shipping_rates(zone, carton_size);

----------------------------------------------------------------------
-- ビュー
----------------------------------------------------------------------
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

CREATE VIEW v_tank_monitor AS
SELECT
  t.id AS tank_id,
  t.name,
  t.initial_volume_l
    + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.to_tank_id = t.id THEN l.quantity_l
        WHEN l.from_tank_id = t.id THEN -l.quantity_l
        ELSE 0 END), 0) AS current_volume_l,
  t.max_volume_l,
  -- 貯蔵率・300ml/700ml充填本数はアプリ層 or 生成カラムで算出
  1.0 * (t.initial_volume_l + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.to_tank_id = t.id THEN l.quantity_l
        WHEN l.from_tank_id = t.id THEN -l.quantity_l
        ELSE 0 END), 0)) / NULLIF(t.max_volume_l, 0) AS fill_rate
FROM tanks t
LEFT JOIN tank_ledger l ON (l.to_tank_id = t.id OR l.from_tank_id = t.id)
GROUP BY t.id;
