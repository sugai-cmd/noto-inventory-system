# NOTO Naorai 受注・製造管理システム
## Node.js + SQLite ローカルサーバー化 — テーブル設計・プロジェクト構造 提案

作成日：2026年8月27日
参照元：`DATA_STRUCTURE.md`（現行スプレッドシート全21シートの詳細）、`ER_DIAGRAM_TEXT.md`（関係性図）

---

## 0. 設計方針（サマリー）

現行システム（Googleスプレッドシート21枚）をそのままテーブルに変換するのではなく、
DATA_STRUCTURE.md 6章・7章で指摘されている「現状特有の癖」を、テーブル設計の段階で
可能な限り解消する方針とします。

| # | 現行の癖 | 本設計での対応 |
|---|---|---|
| 1 | 同じ意味の列がシートごとに表記ゆれ（商品/商品名称、資材名/資材名称、掛率/掛け率） | DBでは**カラム名を1つに統一**する（例：商品名は常に `product_id`、掛率は常に `markup_rate`）。旧シートの表記差はマイグレーションスクリプト側で吸収し、アプリ層には持ち込まない。 |
| 2 | 名前（文字列）だけの緩やかな紐付けが混在し、表記ゆれで突合できなくなるリスクがある | 得意先名・商品名・タンク名・酒蔵名は**すべてマスタテーブルの数値ID（またはコードのUNIQUEキー）に置き換え、外部キー制約で保証**する。名前は表示用の属性値として1テーブルにのみ存在させる。 |
| 3 | 商品在庫モニター・タンクマスタ現在値は「履歴の全件再計算」で得られるバッチ処理的な値 | 常時再計算はSQLiteでは低コストなので、**アプリ起動時／履歴更新トランザクション内で再計算するSQLビュー（またはトリガ更新のスナップショットテーブル）**として実装する。詳細は3章。 |
| 4 | 資材だけ「現在庫数」を集計するモニターが存在しない（7-1の改善提案） | 新設：`material_stock_snapshot`（または `v_material_stock` ビュー）を最初から用意する。 |
| 5 | 酒蔵マスタ・タンクモニターが実質未使用／浮いている | テーブル自体は作るが、外部キー制約は**緩め（NULL許容・参照整合性チェックなし）**にし、将来使う/使わないを選べるようにする。タンクモニターは`v_tank_monitor`としてタンクマスタから導出するビューに格下げ（独立テーブルとしては持たない）。 |
| 6 | 商品在庫変動履歴L列「受注番号」が過去データに存在しない移行期の列 | `order_id` はNULL許容の外部キーとして最初から正式列にする。移行スクリプトは分かる範囲のみ埋める。 |
| 7 | 受注番号・商品履歴ID等の「文字列コード」（D2608-0001等）は人間可読性のために残したい | 内部PKは`INTEGER PRIMARY KEY`（rowid）とし、**業務コード（伝票番号）は別途UNIQUE列**として持たせる。両方参照可能にする。 |

---

## 1. エンティティ→テーブルの対応表

| 現行シート | 新テーブル名 | 種別 |
|---|---|---|
| 得意先マスタ | `customers` | マスタ |
| 商品マスタ | `products` | マスタ |
| 製品レシピマスタ | `product_recipes` | マスタ（中間） |
| 資材マスタ | `materials` | マスタ |
| 原酒マスタ | `raw_sake_brands` | マスタ |
| 酒蔵マスタ | `breweries` | マスタ（低利用） |
| タンクマスタ | `tanks` | マスタ |
| 受注リスト | `orders` | トランザクション |
| 委託販売実績報告 | `consignment_reports` | トランザクション |
| サンプル、販促資料送付 | `sample_shipments` | トランザクション |
| 売上目標 | `sales_targets` | トランザクション（小） |
| 商品在庫変動履歴 | `product_stock_ledger` | 台帳 |
| 資材在庫変動履歴 | `material_stock_ledger` | 台帳 |
| 浄酎容器変動履歴 | `tank_ledger` | 台帳 |
| 原料受払記録 | `raw_sake_ledger` | 台帳 |
| 蒸留記録 | `distillations` | トランザクション（ヘッダ） |
| 蒸留明細記録 | `distillation_details` | トランザクション（明細） |
| 残渣回収記録 | `distillation_residues` | トランザクション |
| ロック管理 | `resource_locks` | システム用 |
| 商品在庫モニター | `v_product_stock`（ビュー） | 導出 |
| タンクモニター | `v_tank_monitor`（ビュー） | 導出（タンクマスタと統合） |
| （新設）資材在庫モニター | `v_material_stock`（ビュー） | 導出（7-1改善提案の実装） |

---

## 2. テーブル定義（DDL草案）

命名規則：テーブル名・カラム名は `snake_case` の英語。日時は `TEXT`（ISO8601文字列、
`YYYY-MM-DD` または `YYYY-MM-DDTHH:MM:SS`）で統一し、SQLiteの日付関数を使う前提とします。
金額・数量は基本 `REAL`、本数など整数が保証される値は `INTEGER`。

```sql
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. マスタ系
-- ============================================================

CREATE TABLE customers (
  id                 INTEGER PRIMARY KEY,
  uid                TEXT NOT NULL UNIQUE,     -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  code               TEXT UNIQUE,              -- 旧: 顧客ID（表示用コード）
  name               TEXT NOT NULL UNIQUE,     -- 得意先名
  segment            TEXT,                     -- 区分
  business_type      TEXT,                     -- 業態
  markup_rate        REAL NOT NULL DEFAULT 1,  -- 掛率（旧:掛率／表記統一）
  address            TEXT,
  payment_term_months INTEGER,                 -- 支払いサイト月数
  payment_term_day   TEXT,                     -- 支払いサイト日付（例:末日）
  invoice_due_note   TEXT,                     -- 請求日送付期日
  sales_rep          TEXT,                     -- 担当者
  sales_sub_rep      TEXT,                     -- サブ担当者
  sales_channel      TEXT,                     -- 流通経路
  last_visited_on    TEXT,                     -- 最終訪問日
  onboarded_on       TEXT,                     -- 取引開始月
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
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

-- 製品レシピ：商品1つに対して複数資材（多対多の中間テーブル）
CREATE TABLE product_recipes (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  material_id  INTEGER NOT NULL REFERENCES materials(id),
  qty_required REAL NOT NULL,                  -- 必要数量（1本あたり）
  process      TEXT,                           -- ステータス（瓶詰/箱詰の区分）
  UNIQUE(product_id, material_id, process)
);

CREATE TABLE breweries (                        -- 酒蔵マスタ（実質未使用、緩い扱い）
  id          INTEGER PRIMARY KEY,
  uid         TEXT NOT NULL UNIQUE,             -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  name        TEXT NOT NULL UNIQUE,
  address     TEXT,
  phone       TEXT,
  contact     TEXT,
  started_on  TEXT
);

CREATE TABLE raw_sake_brands (                  -- 原酒マスタ
  id                INTEGER PRIMARY KEY,
  uid               TEXT NOT NULL UNIQUE,       -- 固有ID（8桁ランダム小文字英数字。キーカラム）
  name              TEXT NOT NULL UNIQUE,       -- 銘柄
  abv               REAL,                       -- アルコール度数
  sake_meter_value  REAL,                       -- 日本酒度
  brewery_id        INTEGER REFERENCES breweries(id), -- 酒蔵（緩やかな紐付け→ID化するが必須にしない）
  brewery_name_raw  TEXT,                       -- 移行データ用：正規化できなかった元の文字列
  status            TEXT,                       -- ステータス
  produced_on       TEXT,                       -- 製造年(月)
  note              TEXT,
  registered_at     TEXT,                       -- 移入日
  initial_stock     REAL DEFAULT 0,             -- 初期在庫量
  current_stock     REAL DEFAULT 0              -- 現在在庫量（実質raw_sake_ledgerで管理、参考値として残す）
);

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
);

-- 【uidカラムについて】
-- customers / products / materials / breweries / raw_sake_brands / tanks の
-- 全マスタに `uid`（8桁ランダム小文字英数字、例: 'a3f9k2mZ'ではなく'a3f9k2mz'のような
-- [a-z0-9]の8文字）をキーカラムとして追加。product_recipes（中間テーブル）は対象外。
-- ・生成はアプリ層で行う（例: nanoidのカスタムアルファベット 'abcdefghijklmnopqrstuvwxyz0123456789' で8桁）。
-- ・UNIQUE制約により衝突時はDB側で検出できるので、アプリ側は衝突時に再生成してリトライする。
-- ・内部の結合・インデックスには従来通り`id`（INTEGER PRIMARY KEY / rowid）を使い、
--   `uid`はAPIのURLや画面表示・外部連携など「外部に見せるキー」として使う想定。

-- ============================================================
-- 2. 受注・売上系（トランザクション）
-- ============================================================

CREATE TABLE orders (
  id                 INTEGER PRIMARY KEY,
  order_no           TEXT NOT NULL UNIQUE,      -- D+年月+連番（表示用・外部連携用に維持）
  ordered_on         TEXT NOT NULL,             -- 受注日
  customer_id        INTEGER NOT NULL REFERENCES customers(id), -- 画面側は得意先名でインクリメンタル検索（後述）
  product_id         INTEGER NOT NULL REFERENCES products(id),  -- 画面側は商品名でインクリメンタル検索（後述）
  quantity           INTEGER NOT NULL,          -- 本数
  unit_price         REAL,                      -- 単価（登録時点の商品マスタ上代のスナップショット）
  markup_rate        REAL,                      -- 掛け率（登録時点の得意先マスタのスナップショット）
  sales_amount       REAL,                      -- 売価（単価×本数×掛け率）
  shipping_fee       REAL DEFAULT 0,            -- 送料
  total_amount       REAL,                      -- 合計(税込)
  requested_delivery_on TEXT,                   -- 納入希望日
  invoiced_on        TEXT,                      -- 請求日（新規登録時、得意先マスタの請求関連情報からイニシャル表示。後述）
  payment_due_on     TEXT,                      -- 入金予定日（同上）
  paid_on            TEXT,                      -- 入金日
  sales_method       TEXT,                      -- 買取/委託
  delivery_method    TEXT,                      -- 配送/手渡し
  status             TEXT NOT NULL DEFAULT '未着手', -- 未着手/発送済 等
  delivery_address   TEXT,
  delivered_on       TEXT,                      -- 納品日（発送日）
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_product  ON orders(product_id);
CREATE INDEX idx_orders_status   ON orders(status);

CREATE TABLE consignment_reports (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id), -- 受注リストの受注番号→ID参照
  report_month    TEXT NOT NULL,               -- 対象月
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  quantity        INTEGER NOT NULL,
  unit_price      REAL,
  markup_rate     REAL,
  sales_amount    REAL,
  shipping_fee    REAL,
  invoiced_on     TEXT,
  payment_due_on  TEXT,
  paid_on         TEXT,
  note            TEXT
);

CREATE TABLE sample_shipments (
  id                 INTEGER PRIMARY KEY,
  shipped_on         TEXT NOT NULL,
  customer_id        INTEGER REFERENCES customers(id),
  contact_name       TEXT,                      -- 得意先名前（実質は担当者名）
  product_id         INTEGER NOT NULL REFERENCES products(id),
  quantity           INTEGER NOT NULL,
  followup_on        TEXT,                      -- 後追い連絡日
  phone              TEXT,
  data_kind          TEXT,                      -- データ区分
  note               TEXT,
  stock_ledger_id    INTEGER REFERENCES product_stock_ledger(id) -- 自動生成される出荷履歴行への逆参照
);

CREATE TABLE sales_targets (
  id             INTEGER PRIMARY KEY,
  target_month   TEXT NOT NULL UNIQUE,          -- 対象月
  target_amount  REAL NOT NULL,
  note           TEXT
);

-- ============================================================
-- 3. 台帳系（在庫変動履歴）
--    ※台帳は追記だけでなく、UPDATE・DELETEも通常運用として行う
--      （入力ミスの訂正・行削除を含む）。詳細な運用ルールは
--      ユーザーからの追加入力待ち（本セクションは仮置き）。
-- ============================================================

CREATE TABLE product_stock_ledger (
  id             INTEGER PRIMARY KEY,
  history_code   TEXT UNIQUE,                   -- L+年月+連番（商品履歴ID、旧表記維持）
  txn_date       TEXT NOT NULL,                 -- 日付
  product_id     INTEGER NOT NULL REFERENCES products(id),
  txn_type       TEXT NOT NULL CHECK (txn_type IN (
                    '瓶詰','箱詰','出荷','返品',
                    '棚卸調整_商品','棚卸調整_仕掛品',
                    '欠損_商品','欠損_仕掛品'
                 )),
  quantity       REAL NOT NULL,                 -- 常に正の数。増減方向はtxn_typeで判定
  counterparty   TEXT,                          -- 受入元/払出先（得意先名・タンクID等の文脈依存自由記述）
  order_id       INTEGER REFERENCES orders(id), -- 受注番号（移行期はNULL許容）
  volume_ml      REAL,                          -- 容量(ml)×本数（出荷時のみ）
  tax_amount     REAL,                          -- 課税額×本数（出荷時のみ）
  storage_place  TEXT,                          -- 保管場所
  data_kind      TEXT,                          -- データ区分
  is_cancelled   INTEGER NOT NULL DEFAULT 0,    -- 取消フラグ（旧: 備考先頭「取消済み」を正式列化）
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))  -- 通常のUPDATEでの訂正を許容するため追加
);
CREATE INDEX idx_psl_product ON product_stock_ledger(product_id, txn_date);
CREATE INDEX idx_psl_order   ON product_stock_ledger(order_id);

CREATE TABLE material_stock_ledger (
  id               INTEGER PRIMARY KEY,
  history_code     TEXT UNIQUE,                 -- M+年月+連番（資材履歴ID）
  txn_date         TEXT NOT NULL,
  material_id      INTEGER NOT NULL REFERENCES materials(id),
  txn_type         TEXT NOT NULL CHECK (txn_type IN ('入荷','消費')),
  quantity         REAL NOT NULL,
  counterparty     TEXT,                        -- 受入元/払出先
  product_ledger_id INTEGER REFERENCES product_stock_ledger(id), -- 消費記録の紐付けキー
  unit_price       REAL,
  total_price      REAL,
  data_kind        TEXT,
  is_cancelled     INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_msl_material ON material_stock_ledger(material_id, txn_date);
CREATE INDEX idx_msl_product_ledger ON material_stock_ledger(product_ledger_id);

CREATE TABLE tank_ledger (                       -- 浄酎容器変動履歴
  id                 INTEGER PRIMARY KEY,
  txn_date           TEXT NOT NULL,
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
);
CREATE INDEX idx_tl_from_tank ON tank_ledger(from_tank_id, txn_date);
CREATE INDEX idx_tl_to_tank   ON tank_ledger(to_tank_id, txn_date);

CREATE TABLE raw_sake_ledger (                   -- 原料受払記録
  id              INTEGER PRIMARY KEY,
  lot_code        TEXT UNIQUE,                   -- 原酒受払ID
  txn_date        TEXT NOT NULL,
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
);

-- ============================================================
-- 4. 蒸留・原酒系
-- ============================================================

CREATE TABLE distillations (                     -- 蒸留記録（ヘッダ）
  id                  INTEGER PRIMARY KEY,
  distillation_code   TEXT NOT NULL UNIQUE,      -- D+年月+連番（蒸留ID）
  started_at          TEXT NOT NULL,             -- 蒸留日（時刻あり）
  input_summary       TEXT,                      -- 使用原酒明細（自由記述サマリ、詳細はdistillation_details）
  total_input_l       REAL,                      -- 投入量合計
  planned_duration    TEXT,                      -- 蒸留設定時間
  status              TEXT NOT NULL DEFAULT '蒸留中', -- 蒸留中/完了
  output_l            REAL,                      -- 蒸留量（完了時）
  output_abv          REAL,                      -- アルコール度数（完了時）
  output_tank_id      INTEGER REFERENCES tanks(id), -- 払出先
  residue_qty         REAL,                      -- 残渣回収量（サマリ、詳細はdistillation_residues）
  completed_at        TEXT
);

CREATE TABLE distillation_details (
  id                INTEGER PRIMARY KEY,
  distillation_id   INTEGER NOT NULL REFERENCES distillations(id),
  raw_sake_ledger_id INTEGER NOT NULL REFERENCES raw_sake_ledger(id),
  input_l           REAL NOT NULL,
  source_tank_id    INTEGER REFERENCES tanks(id),  -- 元容器ID
  is_cancelled      INTEGER NOT NULL DEFAULT 0,
  note              TEXT
);

CREATE TABLE distillation_residues (
  id               INTEGER PRIMARY KEY,
  distillation_id  INTEGER NOT NULL REFERENCES distillations(id),
  collected_at     TEXT NOT NULL,                -- 残渣回収日（時刻あり）
  quantity         REAL,
  abv              REAL,
  salt_status      TEXT,                         -- 食塩ステータス
  salt_input_qty   REAL,                         -- 投入量（食塩等）
  salt_concentration REAL,                       -- 塩分濃度
  destination      TEXT                          -- 払出先（廃棄先/保管先）
);

-- ============================================================
-- 5. システム系
-- ============================================================

CREATE TABLE resource_locks (
  id               INTEGER PRIMARY KEY,
  target_type      TEXT NOT NULL DEFAULT 'distillation',
  distillation_id  INTEGER REFERENCES distillations(id),
  locked_by        TEXT NOT NULL,                -- ユーザー
  locked_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2.1 補足：`to_ref` / `counterparty` のような「文脈依存の自由記述」列について

現行シートには「受入元/払出先」のように、行の種別によって意味が変わる列（例：出荷なら得意先名、
瓶詰めならタンクIDを書く）が複数あります。移行時は以下の2案のいずれかを選べます。

- **A案（本設計の採用案）**：可能な限り種類ごとに専用の外部キー列（`from_tank_id` / `to_tank_id` /
  `order_id` 等）に分解する。既存の自由記述は `note` または `*_raw` 列に退避し、
  移行スクリプトで正規化を試みる。正規化できなかった行は`NULL`のまま残し、後から手動で補完できるようにする。
- B案：現状踏襲で `counterparty TEXT` の1列に寄せ、アプリ側で毎回パースする。実装は速いが、
  6-2で指摘された「表記ゆれで突合できない」問題を引き継いでしまうため非推奨。

本設計はA案を基本方針とし、移行が難しい行だけB案的な `note` 退避を許容します。

**→ A案の方向で確定。** `tank_ledger` / `raw_sake_ledger` 等の `from_tank_id` / `to_tank_id` /
`order_id` のような専用FK列への分解を正式な設計方針とする。

### 2.2 補足：得意先・商品のインクリメンタル検索（AppSheet同等の検索性の再現）

`orders.customer_id` / `orders.product_id` のように、伝票入力画面で得意先・商品を選ぶ場面では、
かつてAppSheetで実現できていた「入力しながら絞り込める検索」を本アプリでも再現する。

- DB側：`customers.name` と `products.name` を対象に **SQLite FTS5仮想テーブル**を用意する。

  ```sql
  CREATE VIRTUAL TABLE customers_fts USING fts5(
    name, code, sales_rep, content='customers', content_rowid='id'
  );
  CREATE VIRTUAL TABLE products_fts USING fts5(
    name, code, category, content='products', content_rowid='id'
  );
  -- customers / products への INSERT/UPDATE/DELETE と同期させるトリガを追加する
  ```

  データ量が少ない前提であれば `LIKE '%キーワード%'` の素朴な検索でも実用上は十分だが、
  前方一致以外の部分一致・読み仮名検索等を見込むならFTS5を推奨する。
- API側：`GET /api/customers/search?q=...` `GET /api/products/search?q=...` を用意し、
  受注登録画面ではこの検索APIを叩くインクリメンタルサーチ（オートコンプリート）のUIコンポーネントを使う。
- ルーティング（5章のプロジェクト構造）の `routes/customers.js` / `routes/products.js` に
  検索エンドポイントを追加する形で実装する。

### 2.3 補足：請求関連日付の初期値（イニシャル表示）

受注登録時、`orders.invoiced_on`（請求日）・`orders.payment_due_on`（入金予定日）は、
選択した得意先（`customers`）の請求関連マスタ情報から**初期値として自動表示**し、
必要であれば画面上で上書きできるようにする。

- `payment_due_on` の初期値：`customers.payment_term_months`（支払いサイト月数）・
  `customers.payment_term_day`（支払いサイト日付、例:末日）から、納品日（`delivered_on`）を
  起点に計算する（現行の「入金予定日は納品日＋支払いサイトから自動計算」を踏襲）。
- `invoiced_on` の初期値：`customers.invoice_due_note`（請求日送付期日）を参照して
  デフォルト値を提示する。
- これらはDBスキーマ上の制約ではなく、**サービス層（`orderService.js`）の入力初期値ロジック**として
  実装する。`orders`テーブル自体には`unit_price`/`markup_rate`と同様、確定した値をスナップショットとして保存する
  （後から得意先マスタの値が変わっても、過去の受注の請求日はそのまま残る）。

---

## 3. 「モニター」系（現在値）の扱い方 — ビュー化

商品在庫モニター・タンクマスタの現在値・資材在庫モニター（新設）はいずれも
「初期在庫 ± 台帳の全履歴」で決まる導出値です。GASでは`syncXxxFromLedger()`が
定期的にシートへ**書き戻す**方式でしたが、SQLiteでは以下のいずれかを選べます。

### 案1（推奨・シンプル）：都度計算するSQLビュー

```sql
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
        WHEN l.txn_type = '棚卸調整_商品' THEN l.quantity  -- 符号は運用ルールに合わせて調整
        WHEN l.txn_type = '欠損_商品' THEN -l.quantity
        ELSE 0 END), 0) AS product_stock,
  p.initial_wip_stock
    + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.txn_type = '瓶詰' THEN l.quantity
        WHEN l.txn_type = '箱詰' THEN -l.quantity
        WHEN l.txn_type = '棚卸調整_仕掛品' THEN l.quantity
        WHEN l.txn_type = '欠損_仕掛品' THEN -l.quantity
        ELSE 0 END), 0) AS wip_stock
FROM products p
LEFT JOIN product_stock_ledger l ON l.product_id = p.id
GROUP BY p.id;

CREATE VIEW v_material_stock AS               -- 7-1で提案されていた新設モニター
SELECT
  m.id AS material_id,
  m.name,
  m.initial_stock
    + COALESCE(SUM(CASE
        WHEN l.is_cancelled THEN 0
        WHEN l.txn_type = '入荷' THEN l.quantity
        WHEN l.txn_type = '消費' THEN -l.quantity
        ELSE 0 END), 0) AS current_stock
FROM materials m
LEFT JOIN material_stock_ledger l ON l.material_id = m.id
GROUP BY m.id;

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
```

台帳が数万行を超えて集計が重くなってきたら、案2（スナップショットテーブル＋
INSERTトリガでの差分更新）へ移行できます。設計互換性のため、`products.id` /
`materials.id` / `tanks.id` をキーにしたスナップショットテーブルを後から追加しても
アプリ側APIの形（`GET /api/products/:id/stock` 等）は変えずに済みます。

### 案2（将来の性能対策）：トリガでスナップショット更新

```sql
CREATE TABLE product_stock_snapshot (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  product_stock INTEGER NOT NULL,
  wip_stock INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- INSERT/UPDATE時のAFTERトリガで product_stock_snapshot を都度更新する
```

初期実装は**案1（ビュー）で十分**という想定です（ローカルサーバー・単一事業所規模のデータ量のため）。

---

## 4. リレーション整理（新ER関係一覧）

```
customers        1 ── * orders
products         1 ── * orders
customers        1 ── * consignment_reports
products         1 ── * consignment_reports
orders           1 ── * consignment_reports        (月次転記)
products         1 ── * sample_shipments
products         1 ── * product_stock_ledger
orders           1 ── * product_stock_ledger        (発送済みで自動生成／NULL許容)
product_stock_ledger 1 ── * material_stock_ledger   (資材消費の紐付け)
products         1 ── * product_recipes
materials        1 ── * product_recipes
tanks            1 ── * tank_ledger (from/to 双方)
products         1 ── * tank_ledger                 (瓶詰め商品)
product_stock_ledger 1 ── 1 tank_ledger             (瓶詰め時の相互紐付け)
distillations    1 ── * tank_ledger                 (継足)
distillations    1 ── * distillation_details
distillations    1 ── * distillation_residues
distillations    1 ── * resource_locks
raw_sake_ledger  1 ── * distillation_details
raw_sake_brands  1 ── * raw_sake_ledger             (緩やかな対応)
breweries        1 ── * raw_sake_brands             (緩やかな対応・低優先)
tanks            1 ── * raw_sake_ledger
```

`v_product_stock` / `v_material_stock` / `v_tank_monitor` は「全件再計算のバッチ的関係」
であることを示すため、上記には含めていません（元のER図と同様、通常の参照とは区別）。

---

## 5. プロジェクト構造の提案

Node.js（Express）+ SQLite（`better-sqlite3`推奨：同期API・高速・組み込みに強い）を前提とした
ローカルサーバー型アプリの構成案です。

```
noto-inventory-system/
├── package.json
├── .env.example                  # PORT, DB_PATH 等
├── DATA_STRUCTURE.md             # 既存（現行シート仕様の記録として保持）
├── ER_DIAGRAM_TEXT.md            # 既存
├── DB_SCHEMA_DESIGN.md           # 本ドキュメント
│
├── db/
│   ├── schema.sql                 # 2章のDDL一式（CREATE TABLE / VIEW）
│   ├── seed.sql                   # 開発用の初期データ（任意）
│   ├── migrations/                # 変更を都度追加していくマイグレーション
│   │   ├── 0001_init.sql
│   │   └── 0002_xxx.sql
│   └── database.sqlite            # 実データ（.gitignore対象）
│
├── src/
│   ├── server.js                  # エントリポイント（Express起動）
│   ├── config.js                  # 環境変数の読み込み
│   ├── db/
│   │   ├── connection.js          # better-sqlite3の初期化・PRAGMA設定
│   │   └── migrate.js             # 起動時にmigrations/を適用するスクリプト
│   │
│   ├── models/                    # テーブルごとのクエリ関数（生SQL or 簡易QueryBuilder）
│   │   ├── customerModel.js
│   │   ├── productModel.js
│   │   ├── materialModel.js
│   │   ├── orderModel.js
│   │   ├── productStockLedgerModel.js
│   │   ├── materialStockLedgerModel.js
│   │   ├── tankModel.js
│   │   ├── tankLedgerModel.js
│   │   ├── distillationModel.js
│   │   └── ... (シート単位で1モデル)
│   │
│   ├── services/                  # 業務ロジック（旧GASの関数群に相当）
│   │   ├── orderService.js        # submitOrder, markOrderAsShipped 等
│   │   ├── bottlingService.js     # submitBottlingV2, submitBoxing
│   │   ├── stockAuditService.js   # 在庫監査レポート相当
│   │   ├── distillationService.js # submitDistillationStart, 完了処理
│   │   ├── tankService.js         # 容器移動・未納税移出・棚卸調整
│   │   ├── recalcService.js       # v_product_stock等の再計算/検証ロジック
│   │   └── csvExportService.js    # ゆうパック・マネーフォワードCSV出力
│   │
│   ├── routes/                    # Expressルーティング（1リソース1ファイル）
│   │   ├── customers.js
│   │   ├── products.js
│   │   ├── materials.js
│   │   ├── orders.js
│   │   ├── bottling.js
│   │   ├── tanks.js
│   │   ├── distillations.js
│   │   └── reports.js
│   │
│   ├── middlewares/
│   │   ├── errorHandler.js
│   │   └── validateRequest.js     # zod等でのバリデーション
│   │
│   └── utils/
│       ├── codeGenerator.js       # 受注番号(D+年月+連番)等の採番ロジック
│       └── dateUtil.js
│
├── public/                        # フロントエンド（当初は簡易画面／将来SPA化も可）
│   ├── index.html
│   ├── orders.html
│   ├── bottling.html
│   ├── dashboard.html
│   └── assets/
│       ├── css/
│       └── js/
│
├── scripts/
│   └── migrate-from-sheets.js     # 現行スプレッドシートCSVからのワンショット移行スクリプト
│
└── tests/
    ├── services/
    └── models/
```

### 5.1 技術選定の考え方

| 項目 | 提案 | 理由 |
|---|---|---|
| DBドライバ | `better-sqlite3` | 同期API・トランザクションが書きやすく、台帳への追記＋モニター再計算のような「1操作=複数SQL」を安全にラップできる |
| Webフレームワーク | Express | ローカル運用・小規模なので学習コスト最小のものを選定。将来Fastifyへの置換も容易な構成にしておく |
| マイグレーション | 自前の軽量ランナー（`db/migrations/*.sql`を通し番号で適用） | 依存を増やしたくなければ十分。knex等の導入も可 |
| バリデーション | zod | 受注登録・瓶詰め登録など入力必須項目が多いため型安全に検証 |
| フロント | 当初はサーバーサイドで返すシンプルなHTML+fetch。将来的にVue/React SPA化も可 | まずは移行を優先し、UIは現行のGoogle Apps Script Web App相当の機能をシンプルに再現 |

### 5.2 「台帳への追記＋モニター再計算」の実装パターン例

```js
// services/bottlingService.js（イメージ）
function submitBottling(db, payload) {
  const tx = db.transaction(() => {
    const ledgerId = insertProductStockLedger(db, { ...payload, txnType: '瓶詰' });
    consumeRecipeMaterials(db, payload.productId, payload.quantity, ledgerId);
    insertTankLedger(db, { ...payload, txnType: '瓶詰', productLedgerId: ledgerId });
    // v_product_stock / v_tank_monitor はビューなので明示更新は不要（SELECT時に自動計算）
  });
  tx(); // better-sqlite3のtransaction()はSQLiteネイティブトランザクションでラップ
}
```

---

## 6. 移行（現行スプレッドシート → SQLite）に関する注意点

1. **マスタから先に移行**：`customers` / `products` / `materials` / `tanks` / `breweries` /
   `raw_sake_brands` を先に投入し、IDを確定させてから台帳・トランザクション系を移行する
   （名前ベースの紐付けをID参照に変換する必要があるため）。
2. **名寄せが必須**：得意先名・商品名・タンク名・資材名について、表記ゆれ（全角半角・スペース等）が
   ないか事前にチェックする移行スクリプト（`scripts/migrate-from-sheets.js`）を用意し、
   一致しない場合はエラーとして一覧化してから手動で名寄せ表を作る。
3. **取消済み行の扱い**：現行の「備考先頭に『取消済み』」という運用を`is_cancelled`フラグに変換する。
   ※台帳系はこのフラグに加えて、通常のUPDATE（内容訂正）・DELETE（行削除）も業務上必要とのことなので、
   3章のテーブル定義には`updated_at`を追加済み。削除履歴を残すかどうか（物理削除のみで良いか、
   削除ログテーブルを別途持つか）は追加のヒアリング事項として保留中。
4. **受注番号(L列)がない過去データ**：`product_stock_ledger.order_id`はNULLのまま許容し、
   6-3の指摘通り無理に遡及入力はしない（将来必要なら別途スクリプトで対応）。
5. **酒蔵マスタ・タンクモニター**：テーブルは作るが、初期移行では「参考データ」として
   割り切り、厳密な整合性チェックの対象外とする（6-5, 6-6を踏襲）。

---

## 7. 次のステップ（提案）

1. 本設計へのフィードバック（テーブル名・カラム名・追加/削除したい項目）
2. `db/schema.sql` の確定 → `better-sqlite3`でのマイグレーション適用確認
3. 移行スクリプト（CSVエクスポート→SQLite投入）の作成
4. まず「受注登録」「発送済にする」「瓶詰め登録」等、優先度の高い機能からAPI・画面を実装
5. 在庫監査レポート・CSV出力（ゆうパック/マネーフォワード）などの周辺機能を移植
