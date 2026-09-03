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

命名規則：テーブル名・カラム名は `snake_case` の英語。金額・数量は基本 `REAL`、
本数など整数が保証される値は `INTEGER`。

### 2.0 日付・時刻カラムの設計方針（重要）

現行スプレッドシートでは、日付セルに時刻や表記ゆれが紛れ込んだことが原因で、
売上モニター等の突合・連動が失敗する事故が発生していました。これを構造的に防ぐため、
**「日付」と「時刻」を常に別カラムに分離**し、1カラムに両方を混在させないことを設計方針とします。

- **`_on` サフィックス**：業務上の「日付」を表すカラム。`TEXT`型、値は必ず`YYYY-MM-DD`のみ
  （時刻は一切含めない）。誤って時刻付きの値が入るのを防ぐため、原則として
  `CHECK (col IS NULL OR col GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`
  のようなCHECK制約を付与し、フォーマット崩れをDB層で機械的に弾く。
- **`_month` サフィックス**：「対象月」のような月単位の値。`YYYY-MM`のみ
  （`CHECK (col GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')`）。
- **`_time` サフィックス**：時刻が必要な業務項目は、`_on`の日付カラムとは別に
  `_time TEXT`（`HH:MM`、必要に応じ`HH:MM:SS`）を新設して分離する。
  1カラムに日時を混在させない（例：蒸留記録の「蒸留日」→ `started_on` + `started_time`）。
  経過時間計算等で日時が必要な場合は、アプリ側で`started_on || 'T' || started_time`のように
  組み立てて計算し、**保存形式としては分離したまま**にする。
- **`_at` サフィックス**：`created_at` / `updated_at` のような、ユーザーが手入力せず
  DBが`datetime('now')`で自動採番するシステム監査用タイムスタンプに限定して使用する。
  これらは業務キーとしての突合に使わないため、今回の事故の原因にはならず、
  日時混在のままで運用上の支障がない（監査ログとしてはむしろ精度が高い方が良い）。
  `resource_locks.locked_at`（ロック時刻）も同様にシステムが`datetime('now')`で
  自動設定する値であり、ユーザー手入力ではないためこの例外に含める。

以下のDDLでは、この方針に沿って全ての業務日付カラムを`_on`（＋必要に応じ`_time`）に
統一しています。

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
  last_visited_on    TEXT CHECK (last_visited_on IS NULL OR last_visited_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 最終訪問日
  onboarded_month    TEXT CHECK (onboarded_month IS NULL OR onboarded_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), -- 取引開始月（YYYY-MM）
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
  produced_on       TEXT,                       -- 製造年(月)。表記が不定（和暦等）な移行データもあるためCHECKなしの自由記述で許容
  note              TEXT,
  registered_on     TEXT CHECK (registered_on IS NULL OR registered_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 移入日（時刻なし）
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
  ordered_on         TEXT NOT NULL CHECK (ordered_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 受注日
  customer_id        INTEGER NOT NULL REFERENCES customers(id), -- 画面側は得意先名でインクリメンタル検索（後述）
  product_id         INTEGER NOT NULL REFERENCES products(id),  -- 画面側は商品名でインクリメンタル検索（後述）
  quantity           INTEGER NOT NULL,          -- 本数
  unit_price         REAL,                      -- 単価（登録時点の商品マスタ上代のスナップショット）
  markup_rate        REAL,                      -- 掛け率（登録時点の得意先マスタのスナップショット）
  sales_amount       REAL,                      -- 売価（単価×本数×掛け率）
  shipping_fee       REAL DEFAULT 0,            -- 送料
  total_amount       REAL,                      -- 合計(税込)
  requested_delivery_on TEXT CHECK (requested_delivery_on IS NULL OR requested_delivery_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 納入希望日
  invoiced_on        TEXT CHECK (invoiced_on IS NULL OR invoiced_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 請求日（新規登録時、得意先マスタの請求関連情報からイニシャル表示。後述）
  payment_due_on     TEXT CHECK (payment_due_on IS NULL OR payment_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 入金予定日（同上）
  paid_on            TEXT CHECK (paid_on IS NULL OR paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 入金日
  sales_method       TEXT,                      -- 買取/委託
  delivery_method    TEXT,                      -- 配送/手渡し
  status             TEXT NOT NULL DEFAULT '未着手', -- 未着手/発送済 等
  delivery_address   TEXT,
  delivered_on       TEXT CHECK (delivered_on IS NULL OR delivered_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 納品日（発送日）
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
  report_month    TEXT NOT NULL CHECK (report_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), -- 対象月（YYYY-MM）
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
  note            TEXT
);

CREATE TABLE sample_shipments (
  id                 INTEGER PRIMARY KEY,
  sample_no          TEXT NOT NULL UNIQUE,      -- S+年月(4桁)+連番(4桁)。受注番号(D...)の採番方式を踏襲
  shipped_on         TEXT NOT NULL CHECK (shipped_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  customer_id        INTEGER REFERENCES customers(id),
  contact_name       TEXT,                      -- 得意先名前（実質は担当者名）
  product_id         INTEGER NOT NULL REFERENCES products(id),
  quantity           INTEGER NOT NULL,
  followup_on        TEXT CHECK (followup_on IS NULL OR followup_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 後追い連絡日
  phone              TEXT,
  data_kind          TEXT,                      -- データ区分
  note               TEXT
  -- 対応する出荷履歴行への参照は product_stock_ledger.sample_shipment_id 側に一本化
  -- （orders ⇔ product_stock_ledger.order_id と同じ片方向FKパターンに揃える。8-1参照）
);

CREATE TABLE sales_targets (
  id             INTEGER PRIMARY KEY,
  target_month   TEXT NOT NULL UNIQUE CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), -- 対象月（YYYY-MM）
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
  txn_date       TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 日付
  product_id     INTEGER NOT NULL REFERENCES products(id),
  txn_type       TEXT NOT NULL CHECK (txn_type IN (
                    '瓶詰','箱詰','出荷','返品',
                    '棚卸調整_商品','棚卸調整_仕掛品',
                    '欠損_商品','欠損_仕掛品'
                 )),
  quantity       REAL NOT NULL,                 -- 常に正の数。増減方向はtxn_typeで判定
  counterparty   TEXT,                          -- 受入元/払出先（得意先名・タンクID等の文脈依存自由記述）
  order_id       INTEGER REFERENCES orders(id), -- 受注経由の出荷。受注番号（移行期はNULL許容）
  sample_shipment_id INTEGER REFERENCES sample_shipments(id), -- サンプル送付経由の出荷（8-1参照）。order_idと同じパターンの専用FK
  volume_ml      REAL,                          -- 容量(ml)×本数（出荷時のみ）
  tax_amount     REAL,                          -- 課税額×本数（出荷時のみ）
  storage_place  TEXT,                          -- 保管場所
  data_kind      TEXT,                          -- データ区分
  is_cancelled   INTEGER NOT NULL DEFAULT 0,    -- 取消フラグ（旧: 備考先頭「取消済み」を正式列化）
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),  -- 通常のUPDATEでの訂正を許容するため追加
  CHECK (order_id IS NULL OR sample_shipment_id IS NULL) -- 出荷の発生源は受注かサンプルのどちらか一方のみ
);
CREATE INDEX idx_psl_product ON product_stock_ledger(product_id, txn_date);
CREATE INDEX idx_psl_order   ON product_stock_ledger(order_id);
CREATE INDEX idx_psl_sample  ON product_stock_ledger(sample_shipment_id);

CREATE TABLE material_stock_ledger (
  id               INTEGER PRIMARY KEY,
  history_code     TEXT UNIQUE,                 -- M+年月+連番（資材履歴ID）
  txn_date         TEXT NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
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
);
CREATE INDEX idx_tl_from_tank ON tank_ledger(from_tank_id, txn_date);
CREATE INDEX idx_tl_to_tank   ON tank_ledger(to_tank_id, txn_date);

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
);

-- ============================================================
-- 4. 蒸留・原酒系
-- ============================================================

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
  collected_on     TEXT NOT NULL CHECK (collected_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- 残渣回収日
  collected_time   TEXT NOT NULL CHECK (collected_time GLOB '[0-9][0-9]:[0-9][0-9]'), -- 残渣回収時刻（HH:MM）。蒸留記録と同様の理由で日付と分離
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
  locked_at        TEXT NOT NULL DEFAULT (datetime('now')) -- システムが自動設定する監査用タイムスタンプのため日付/時刻分離の対象外（2.0参照）
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

1. ~~本設計へのフィードバック（テーブル名・カラム名・追加/削除したい項目）~~ → 数ラウンドの
   フィードバックを反映済み（uidキー・台帳のUPDATE/DELETE許容・検索機能・日付時刻分離 等）
2. ~~`db/schema.sql` の確定 → `better-sqlite3`でのマイグレーション適用確認~~ → **完了**。
   本ドキュメントのDDLから `db/schema.sql` を実ファイルとして切り出し、`better-sqlite3`
   （実インストール・ネイティブロード確認済み）で以下を実地検証した。
   - 全21テーブル＋3ビューがエラーなく作成できること
   - 日付CHECK制約が、時刻混入など不正フォーマットを実際に弾くこと
     （例：`'2026-08-27 10:00'`のような時刻付き値はINSERT時に拒否される）
   - Node.jsプロジェクトの最小骨格（`src/server.js` → `src/db/migrate.js` →
     `src/db/connection.js`）を作成し、`db/migrations/0001_init.sql`として
     マイグレーション適用・`GET /api/health`応答まで動作確認済み
3. ~~移行スクリプト（CSVエクスポート→SQLite投入）の作成~~ → **完了（8章、8-8に実装内容）**
   - サンプル送付↔商品在庫変動履歴の紐付け方針を確定（8-1）
   - 酒蔵マスタ・原酒マスタは移行対象外とし、登録APIを先行実装（8-2, 7.2）
   - 全17ローダーを実装し、サンプルCSVでエンドツーエンド検証済み（8-8）
4. まず「受注登録」「発送済にする」「瓶詰め登録」等、優先度の高い機能からAPI・画面を実装
   → **API実装完了（9章）。画面（public/）は次のステップ**
5. 在庫監査レポート・CSV出力（ゆうパック/マネーフォワード）などの周辺機能を移植
   → **蒸留・画面・棚卸・CSV出力まで完了（10章）。残るは在庫監査レポート**

### 7.1 このステップで実際に作成したファイル

```
package.json / package-lock.json   # better-sqlite3 / express / zod を導入
.env.example / .gitignore
db/schema.sql                      # 2章・3章のDDLを実ファイル化（検証済み）
db/migrations/0001_init.sql        # schema.sqlと同内容の初回マイグレーション
src/config.js                      # PORT / DB_PATH の読み込み
src/db/connection.js               # better-sqlite3接続、foreign_keys=ON・WAL設定
src/db/migrate.js                  # db/migrations/*.sqlを順次適用する軽量ランナー
src/server.js                      # Express起動。起動時にmigrate()を実行し、/api/healthを提供
```

`src/models` / `src/services` / `src/routes` / `public` / `scripts` / `tests` は
5章の構成に沿ってディレクトリのみ用意済み（中身は次ステップ以降で実装）。

### 7.2 8-2の決定に伴い実装したマスタ登録API（酒蔵・原酒）

8-2で「酒蔵マスタ・原酒マスタは移行対象外とし、移行後にAPI経由で順次登録する」と
決定したため、先行してその登録APIを実装した（`node --test`で動作確認済み・5件全pass）。

```
src/utils/uid.js               # マスタのuid（8桁ランダム小文字英数字）生成・衝突リトライ
src/utils/normalizeName.js     # NFKC正規化＋トリム（8-3の名寄せルールをアプリ側でも共有）
src/models/breweryModel.js     # 酒蔵マスタ CRUD
src/models/rawSakeBrandModel.js# 原酒マスタ CRUD。酒蔵は breweryId 優先、
                                # breweryNameは既存酒蔵と正規化一致すればbrewery_idを解決、
                                # 不一致ならbrewery_id=NULL・brewery_name_rawへ自由記述のまま退避
src/routes/breweries.js        # GET/POST/PUT/DELETE /api/breweries
src/routes/rawSakeBrands.js    # GET/POST/PUT/DELETE /api/raw-sake-brands
src/middlewares/validateRequest.js # zodスキーマでのリクエスト検証（400を返す）
src/middlewares/errorHandler.js    # SQLite制約違反(409)等の共通エラーハンドリング
tests/models/masterModels.test.js  # 上記モデルの単体テスト（node --test）
```

`npm test`（`node --test tests/**/*.test.js`）で実行できる。

---

## 8. 移行スクリプト設計（7-3 詳細）

### 8.0 全体方針・フェーズ構成

移行の本質的な難しさはINSERT文を書くことではなく、**旧シートの名前ベースの緩い紐付けを、
新スキーマのID参照に安全に変換すること**（6-2）です。FK依存があるため、以下の順序を厳守します。

```
フェーズ1: マスタ系（依存関係の起点）
  得意先マスタ → customers
  商品マスタ → products
  資材マスタ → materials
  タンクマスタ → tanks
  製品レシピマスタ → product_recipes（products・materialsのnameから解決）
  ※ 酒蔵マスタ・原酒マスタは対象外（8-2参照）

フェーズ2: 名寄せ事前チェック（★実データ投入前に一旦止まる想定の重要フェーズ）
  受注リスト以降の全シートに登場する「得意先名」「商品名」「タンク名」等の文字列を
  全て収集し、フェーズ1で作ったマスタ名と突合。不一致は unmatched-names.csv に出力し、
  --strict なら実データ投入前に停止する。

フェーズ3: トランザクション・台帳系（マスタのIDを使って解決）
  1. orders（受注リスト）
  2. distillations（蒸留記録ヘッダ）
  3. raw_sake_ledger（原料受払記録）※原酒マスタ・酒蔵マスタは対象外のため raw_sake_brand_id は
     常にNULL・spec_noに原酒スペックの自由記述をそのまま退避
  4. distillation_details（蒸留明細記録）
  5. distillation_residues（残渣回収記録）
  6. product_stock_ledger（商品在庫変動履歴）※order_noでordersを参照
  7. material_stock_ledger（資材在庫変動履歴）※商品履歴IDでproduct_stock_ledgerを参照
  8. tank_ledger（浄酎容器変動履歴）※商品履歴ID・蒸留IDの両方を参照
  9. consignment_reports（委託販売実績報告）※受注番号でordersを参照
  10. sample_shipments → product_stock_ledger の突合（8-1参照）
  11. sales_targets（依存なし）

  ※ resource_locks（ロック管理）は移行対象外（実行時の排他制御用の一時データのため）
```

同じ「商品履歴ID」がproduct_stock_ledger／material_stock_ledger／tank_ledgerの3シートに
共通で振られている現行仕様（6-2）をそのまま活用し、`history_code → 新しい整数id`のマップを
作って後続テーブルのFK解決に使います。蒸留IDも同様です。

### 8.1 サンプル送付↔商品在庫変動履歴の紐付け（決定事項）

**新設した`sample_shipments.sample_no`（S+年月+連番）と`product_stock_ledger.sample_shipment_id`
（`order_id`と同じパターンの専用FK）を使う。** 詳細は2章のDDLを参照。

移行時の具体的な手順：

1. `sample_shipments`（サンプル、販促資料送付シート）を読み込み、各行に`sample_no`を
   新規採番して投入する（過去データには当然この番号は存在しないため、移行時に初めて付与する）
2. `product_stock_ledger`側で、`txn_type='出荷'`かつ`order_id`が解決できない行
   （＝受注リストに対応する行が見当たらない＝サンプル起因の出荷と推定される行）を抽出する
3. 2の候補と1のサンプル送付行を、**日付×商品×数量が一致するもの**で突き合わせる
   - 1対1で一意にマッチしたものだけ`sample_shipment_id`を確定させる
   - 同日・同商品・同数量の候補が複数あって一意に決まらない場合は、`errors.csv`（曖昧マッチ）に
     出力してNULLのまま残し、後日手動で確認する
4. マッチしなかった`sample_shipments`行・`product_stock_ledger`行は、それぞれ単独のレコードとして
   投入する（無理に紐付けを作らない。7章冒頭の「実害がなければ緊急性は高くない」という現行方針を踏襲）

これは**過去データだけの問題**です。移行後、新アプリの`submitSampleShipment()`は
`sample_shipments`と`product_stock_ledger`を同一トランザクション内で作成し、
`sample_shipment_id`を確実にセットするため、今後はこの推測マッチングは不要になります。

### 8.2 酒蔵マスタ・原酒マスタの移行スコープ（決定事項）

6-5/6-6の通り実質未使用の**酒蔵マスタ・原酒マスタは、移行スクリプトの対象から完全に除外**します。
過去データのCSV変換・名寄せは行わず、代わりに**新アプリのマスタ登録画面／APIを先に用意し、
移行後に必要な分だけ手動で順次登録していく**運用に切り替えます。

- `raw_sake_ledger.raw_sake_brand_id`は移行時は常にNULLとし、元の「原酒スペック」列は
  `spec_note`（自由記述）にそのまま退避する（すでにDDLに用意済み）
- タンクモニターはテーブルを持たず`v_tank_monitor`ビューとして`tanks`から導出する設計のため
  （3章）、そもそも移行対象データが存在しない
- 今回、この方針に対応する実装として `src/models/breweryModel.js` /
  `src/models/rawSakeBrandModel.js` と、それぞれのAPIルートを作成した（8-3参照）。
  移行完了後、これらのAPIを使って酒蔵・原酒を都度登録できる。

### 8.3 名寄せ（名前解決）の仕組み

1. **正規化ルール**：Unicode NFKC正規化（全角/半角統一）＋前後空白トリム＋連続空白の圧縮を
   全ての名前系文字列に適用してから比較する
2. **突合**：正規化済みの値でマスタの`name`と一致するかを見る
3. **不一致の扱い**：`unmatched-names.csv`に「どのシートの、どの列の、どの値が」不一致かを
   全件リストアップ。`--strict`（デフォルト）は実データ投入前に停止、`--allow-partial`は
   FKをNULLにして`note`/`*_raw`列に退避し処理続行
4. **手動補正**：`scripts/data/aliases.json`に`{"表記ゆれ": "正式名称"}`の対応表を用意し、
   正規化だけでは解決しない差異を人が指定できるようにする

### 8.4 カラム単位の変換ルール

| 変換項目 | ルール |
|---|---|
| 日付 | シート由来の値を`YYYY-MM-DD`に正規化。パース不能な値は`errors.csv`に記録しスキップ |
| 蒸留日等の日時混在列 | `started_on`+`started_time`等に分離。時刻が読み取れない場合はエラーとして明示的に止める |
| `uid` | 8桁ランダム小文字英数字を生成し、DB側で重複チェック→衝突時は再生成（`src/utils/uid.js`） |
| 取消済み行 | `備考`列の先頭が「取消済み」なら`is_cancelled=1`にし、prefixを除いた残りを`note`に格納 |
| 表記ゆれ列名 | シートごとに列名を明示的にマッピングするので自動判定は不要 |

### 8.5 べき等性・dry-run・エラーレポート

- `--dry-run`：全処理をトランザクション内で実行し、最後に必ずロールバック。
  `unmatched-names.csv`・`errors.csv`・`summary.json`（シートごとの読込/投入/スキップ件数）だけ出力
- `--reset`：トランザクション・台帳系テーブルを事前に全削除してから再投入（マスタは対象外）
- 行単位のエラーは最初の1件で止めず`errors.csv`に集約する

### 8.6 ファイル構成

```
scripts/
├── migrate-from-sheets.js        # CLIエントリポイント（--dry-run/--strict/--allow-partial/--reset）
├── data/
│   ├── csv/                      # シートCSVエクスポート（.gitignore対象。酒蔵・原酒は含めない）
│   └── aliases.json              # 手動の名寄せ対応表
├── lib/
│   ├── csvReader.js
│   ├── normalize.js
│   ├── parseDate.js
│   └── report.js
└── migration-report/             # 実行結果（.gitignore対象）
    ├── unmatched-names.csv
    ├── errors.csv
    └── summary.json
```

### 8.7 移行後の検証

1. `PRAGMA foreign_key_check`が0件であること
2. シートの行数とテーブルの投入件数（スキップ分を除く）が一致するか
3. `orders.total_amount`等の月次集計値がスプレッドシート側と一致するかスポットチェック
4. `v_product_stock`/`v_tank_monitor`の計算結果が、旧シートの最終値と一致するか

このうち1と、モニタービューが引けることの確認は`migrate-from-sheets.js`が実行後に自動で行う。
2はサマリー（読込/投入/既存/スキップ件数）で確認できる。3・4は旧シートの数字が必要なため手動。

### 8.8 実装内容（実装済み）

```
scripts/migrate-from-sheets.js     # CLIエントリポイント
scripts/lib/csvReader.js           # CSV読込（BOM除去）
scripts/lib/parseDate.js           # 日付/日時/月のパース・分離（2.0の方針を実装）
scripts/lib/loadHelper.js          # 読込→変換→INSERTの共通処理、名前解決、既存判定
scripts/lib/report.js              # unmatched-names.csv / errors.csv / summary.json 出力
scripts/loaders/*.js               # シートごとのローダー（全17本）
scripts/data/aliases.example.json  # 名寄せ手動補正表のサンプル
tests/scripts/parseDate.test.js    # 日付分離ロジックのテスト
```

**実行方法**

```bash
node scripts/migrate-from-sheets.js --dry-run       # 投入せずレポートのみ（必ず最初にこれ）
node scripts/migrate-from-sheets.js                 # --strict（既定）で投入
node scripts/migrate-from-sheets.js --allow-partial # 名寄せ不一致行をスキップして続行
node scripts/migrate-from-sheets.js --reset         # 台帳・トランザクションを消して再投入
```

CSVは`scripts/data/csv/`に、テーブル名に対応するファイル名（`customers.csv`、
`product_stock_ledger.csv`等）で配置する。ファイルがなければそのシートはスキップされるため、
用意できたシートから段階的に流し込める。

**検証済みの動作**（サンプルCSV16ファイルでエンドツーエンド実行）

- 全17ローダーが依存関係順に動作し、`PRAGMA foreign_key_check`が0件でコミットされること
- 日付/時刻の分離：`2026/8/1 09:30` → `started_on='2026-08-01'` + `started_time='09:30'`
- `sample_no`の採番（`S2608-0001`）と、日付×商品×数量による
  `product_stock_ledger.sample_shipment_id`の自動突合（8-1）
- 受注由来の出荷は`order_id`、サンプル由来は`sample_shipment_id`に排他的に入ること
- 「取消済み」プレフィックス → `is_cancelled=1`＋noteからのprefix除去、
  および集計ビューからの除外
- `v_product_stock`/`v_material_stock`/`v_tank_monitor`の計算値が手計算と一致すること
- `--strict`が名寄せ不一致で投入前に中止し、`--allow-partial`が該当行のみスキップして続行すること
- `--reset`がマスタを保持したまま台帳のみ再投入し、再実行してもマスタが重複しないこと
  （マスタローダーは自然キーで既存行を検出する冪等な実装）

**既知の注意点**

- `v_tank_monitor`は`tank_ledger`（浄酎容器変動履歴）のみを集計する。原酒タンクの
  受払は`raw_sake_ledger`側にあるため、原酒ポリタンク等の残量はこのビューには反映されない。
  これは現行システム（TankEngineが浄酎容器変動履歴のみを見る）と同じ挙動だが、
  原酒タンクの残量もモニターしたい場合は別途ビューの追加が必要。
- タンクマスタの「現在液量(L)」はシート最終値を取り込むが、真値は`v_tank_monitor`側の
  再計算値。両者のズレは台帳の移行漏れを検出する材料になるので、移行後に突合すること。

---

## 9. 主要機能API（実装済み）

DATA_STRUCTURE.md 5章「機能一覧とその成果物」のうち、優先度の高い受注・瓶詰め系を実装した。

### 9.1 エンドポイント一覧

| メソッド | パス | 対応する旧GAS機能 |
|---|---|---|
| GET | `/api/customers/search?q=` | 得意先のインクリメンタル検索（2.2） |
| GET | `/api/products/search?q=` | 商品のインクリメンタル検索（在庫付き。在庫僅少アラート用） |
| GET | `/api/orders/defaults?customerId=&productId=&quantity=&deliveredOn=` | 受注登録画面の初期値（2.3） |
| POST | `/api/orders` | `submitOrder()` |
| GET | `/api/orders`（status/customerId/from/to で絞込） | 受注一覧 |
| POST | `/api/orders/:id/ship` | `markOrderAsShipped()` |
| POST | `/api/orders/:id/invoice` | `markInvoiceSent()` |
| POST | `/api/orders/:id/payment` | 入金日の記録 |
| POST | `/api/bottling` | `submitBottlingV2()` |
| POST | `/api/boxing` | `submitBoxing()` |
| GET | `/api/recipe/:productId` | `getRecipeForProduct_()`（画面での消費予定表示用） |
| GET | `/api/products/stock` | 商品在庫モニター（`v_product_stock`） |
| GET | `/api/materials/stock` | **資材在庫モニター（7-1で新設）**。適正在庫割れに`shortage`フラグ |
| GET | `/api/tanks/monitor` | タンクモニター（`v_tank_monitor`＋300/700ml換算本数） |
| GET/POST/PUT | `/api/customers`, `/api/products` | マスタCRUD |
| GET/POST/PUT/DELETE | `/api/breweries`, `/api/raw-sake-brands` | 8-2の移行後手動登録用 |

### 9.2 GAS版からの主な改善点

- **トランザクション化**：瓶詰めは「商品在庫変動履歴＋資材在庫変動履歴（レシピ消費）＋
  浄酎容器変動履歴」の3台帳へ書き込むが、GAS版はシートごとに順次appendRowしていたため
  途中で失敗すると不整合が残った。SQLiteのトランザクションで全書き込みをまとめ、
  失敗時は全てロールバックする。
- **出荷と受注の確実な紐付け**：`markOrderAsShipped()`が出荷履歴に必ず`order_id`をセットするため、
  6-3で「移行期の状態」とされていた受注番号との突合が、新規データでは常に成立する。
- **在庫不足のガード**：箱詰め時に仕掛品在庫を検査し、足りなければ422で拒否する（GAS版にはなかった）。
- **エラーの区別**：業務ルール違反（在庫不足=422／二重発送=409／対象なし=404）と
  入力エラー（400）とサーバー障害（500）を`src/utils/errors.js`で区別して返す。
- **金額のスナップショット**：単価・掛け率は受注登録時点のマスタ値を`orders`に保存するため、
  後からマスタを変更しても過去の受注金額は変わらない。

### 9.3 採番ロジック

`src/utils/codeGenerator.js`が受注番号（`D`+年月+連番）・商品履歴ID（`L`+…）・
資材履歴ID（`M`+…）・サンプルID（`S`+…）を共通実装で採番する。
カウンタテーブルを持たず「同一プレフィックス・同一年月の最大連番+1」で求めるため、
移行データの続きからも正しく採番される。採番と実INSERTは同一トランザクション内で行う。

### 9.4 テスト

`npm test`で32件（全てpass）。うち受注フローのテスト（`tests/services/orderFlow.test.js`）は
Expressアプリをインプロセスで起動し、実際のHTTPリクエストで
「受注登録 → 瓶詰め → 箱詰め → 発送済」の一連の流れと在庫連動を検証している。
`tests/services/dateUtil.test.js`は支払いサイト計算（年跨ぎ・うるう年・31日指定の末日丸め）を担保する。

### 9.5 未実装（次のステップ）

- ~~画面（`public/`）~~ → 10-2で実装
- ~~蒸留の開始/完了~~ → 10-1で実装
- ~~棚卸調整~~ → 10-3で実装
- ~~CSV出力（ゆうパック／マネーフォワード）~~ → 10-4で実装
- ~~容器移動・未納税移出~~ → 11-1で実装
- ~~在庫監査レポート~~ → 11-2で実装

---

## 10. 蒸留・画面・棚卸・CSV（実装済み）

### 10-1. 蒸留（`src/services/distillationService.js`）

DATA_STRUCTURE.md 4-7〜4-10、5章の「蒸留の開始・完了」に対応する。

| メソッド | パス | 対応する旧GAS機能 |
|---|---|---|
| POST | `/api/raw-sake-receipts` | `submitRawSakeReceipt()`（原酒入荷） |
| GET | `/api/raw-sake-receipts/tanks` | 原酒タンクの残量一覧（下記の新設ビュー） |
| POST | `/api/distillations` | `submitDistillationStart()` |
| POST | `/api/distillations/:id/complete` | 蒸留完了報告処理 |
| POST | `/api/distillations/details/:id/cancel` | `cancelDistillationDetailItem()`（部分取消） |
| GET | `/api/distillations/alerts` | `getStaleDistillationAlerts()`（24時間超過アラート） |

**蒸留開始**は蒸留記録（ヘッダ）＋蒸留明細記録＋原料受払記録（払出）を、
**蒸留完了**は蒸留記録の更新＋浄酎容器変動履歴（継足）＋残渣回収記録を、
それぞれ1トランザクションで書き込む。

**部分取消**は明細に取消フラグを立てたうえで、原料受払記録に「受入」を1行足して原酒を戻す
（4-9の「取消時の受入戻し」を踏襲）。同時にヘッダの投入量合計を、取消されていない明細だけで再計算する。

**24時間アラート**は`started_on || ' ' || started_time`を結合して経過時間を判定する。
2.0で日付と時刻を分離して保持した設計が、ここでそのまま活きている。

#### 新設ビュー `v_raw_sake_tank_volume`（migration 0002）

8-8で「`v_tank_monitor`は`tank_ledger`しか集計しないため原酒タンクの残量が分からない」と
記録していた点への対応。`raw_sake_ledger`の受入／払出から原酒タンクの残量を集計するビューを追加し、
**蒸留開始時に「そのタンクから本当にその量を払い出せるか」を検査**できるようにした（GAS版にはなかったガード）。

#### 伝票番号プレフィックスの整理（決定事項）

DATA_STRUCTURE.md上は受注番号（4-1）も蒸留ID（4-7）も同じ`D`+年月+連番で、
番号だけではどちらの伝票か判別できなかった。新規採番分は次の通り整理する。

| 伝票 | プレフィックス | 由来 | 例 |
|---|---|---|---|
| 受注番号 | `O` | **O**rder | `O2608-0001` |
| 蒸留ID | `D` | **D**istill（現行シート踏襲） | `D2608-0001` |
| 商品履歴ID | `L` | 現行シート踏襲 | `L2608-0001` |
| 資材履歴ID | `M` | 現行シート踏襲 | `M2608-0001` |
| サンプルID | `S` | **S**ample | `S2608-0001` |
| 原酒受払ID | `R` | 現行シート踏襲 | `R2608-0001` |

移行済みの過去データはシート上のコードをそのまま保持するため、
過去の受注番号が`D...`のままでも影響はない（`order_no`はUNIQUE制約のみで、
形式の検証はしていない）。新規採番のみ`O`に切り替わる。

### 10-2. 画面（`public/`）

| ファイル | 内容 |
|---|---|
| `index.html` | ダッシュボード。未着手受注・蒸留中・要発注資材・商品在庫合計と、24時間超過アラート |
| `orders.html` | 受注登録（インクリメンタル検索・初期値自動計算・在庫僅少アラート）、受注一覧、発送済処理、CSV出力 |
| `bottling.html` | 瓶詰め・箱詰め。商品を選ぶとレシピから消費予定資材を事前表示 |
| `distillation.html` | 原酒入荷、蒸留開始（投入元を複数行で指定）、完了報告、投入明細の部分取消 |
| `stock.html` | 商品・資材・タンク・原酒タンクの各在庫モニター |
| `stocktaking.html` | 棚卸。理論値の横に実測値を入力して保存 |

共通処理は`public/assets/js/app.js`に集約している。特に`createSearchSelect()`は、
2.2で要件としていた「AppSheetで使えていた入力しながら絞り込む操作感」を再現するコンポーネントで、
キーボード操作（↑↓で選択、Enterで確定、Escで閉じる）にも対応している。

ビルド不要の素のHTML+JSで、`npm start`後に`http://localhost:3000/`を開けばそのまま使える。

### 10-3. 棚卸（`src/services/stocktakingService.js`）

| メソッド | パス | 対応する旧GAS機能 |
|---|---|---|
| POST | `/api/stocktaking/products` | `submitProductStocktaking()` |
| POST | `/api/stocktaking/materials` | （新設。資材の棚卸は現行システムに存在しなかった） |
| POST | `/api/stocktaking/tanks` | `submitStocktaking()`（タンク） |

台帳の「数量は常に正の数」という制約（4-2 D列）を守るため、
**実測値と理論値（モニタービューの現在値）の差を求め、符号によって受払区分を出し分ける**：

| 対象 | 実測 > 理論 | 実測 < 理論 |
|---|---|---|
| 商品 | `棚卸調整_商品` | `欠損_商品` |
| 仕掛品 | `棚卸調整_仕掛品` | `欠損_仕掛品` |
| 資材 | `棚卸調整` | `欠損` |
| タンク | `棚卸調整`（`to_tank_id`側） | `欠減`（`from_tank_id`側） |

差が0の場合は台帳に行を作らずスキップする（棚卸のたびに無意味な0行が増えるのを防ぐ）。
タンクは実測度数を入力するとタンクマスタの理論度数も更新する。

#### migration 0003：資材台帳への棚卸区分の追加

`material_stock_ledger.txn_type`は現行シート踏襲で`('入荷','消費')`のみだったため、
棚卸の差異を記録できなかった。SQLiteはCHECK制約をALTERできないので、テーブルを作り直して
`('入荷','消費','棚卸調整','欠損')`に拡張し、`v_material_stock`も新区分を集計するよう再作成した。

> 注意：SQLiteは「ビューが参照しているテーブル」のDROP/RENAMEを拒否するため、
> マイグレーションでは**先にビューを落としてから**テーブルを作り替え、最後にビューを定義し直している。

### 10-4. CSV出力（`src/services/csvExportService.js`）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/exports/yupack` | ゆうパック送り状用（宛先・品名・個数） |
| GET | `/api/exports/moneyforward` | マネーフォワード売上用（取引日・金額・請求/入金予定日） |
| GET | `/api/exports/product-stock` | 商品在庫（実測記入欄つき。棚卸で印刷して使う想定） |
| GET | `/api/exports/material-stock` | 資材在庫（同上） |
| GET | `/api/exports/tank-monitor` | タンク（同上） |

受注系のCSVは`orderIds` / `from` / `to` / `status`で絞り込める。
受注画面のCSVボタンは、一覧の絞り込み条件をそのまま引き継いで出力する。

**Excelでの文字化けを避けるため、UTF-8 BOM付き・CRLF改行で出力**している。
カンマ・引用符・改行を含む値は二重引用符でエスケープする。

> 出力列は現行の運用ファイルを推定して構成している。実際のテンプレートに合わせて
> 調整できるよう、列定義は各関数の先頭にまとめてある。ゆうパックの郵便番号列は
> 現行データに該当列がないため空欄で出力している。

### 10-5. テスト

`npm test`で52件（全てpass）。

| ファイル | 内容 |
|---|---|
| `tests/services/orderFlow.test.js` | 受注登録→瓶詰め→箱詰め→発送済の一連フローと在庫連動 |
| `tests/services/distillationFlow.test.js` | 原酒入荷→蒸留開始→部分取消→完了、残量ガード、24時間アラート |
| `tests/services/stocktakingAndExport.test.js` | 商品/資材/タンクの棚卸、差異0のスキップ、CSVの内容・BOM・エスケープ |
| `tests/services/dateUtil.test.js` | 支払いサイト計算 |
| `tests/scripts/parseDate.test.js` | 日付/時刻の分離パーサー |
| `tests/models/masterModels.test.js` | 酒蔵・原酒マスタのCRUD |

画面については、Playwrightで実際にChromiumを起動し、
受注登録→発送済、原酒入荷→蒸留開始→詳細表示、瓶詰め→在庫不足エラー、
棚卸の保存、CSVダウンロード（BOM確認）までを通しで動作確認済み。

---

## 11. 容器移動・未納税移出・在庫監査（実装済み）

これで DATA_STRUCTURE.md 5章「機能一覧」の全機能が新システム上に揃った。

### 11-1. 容器移動・未納税移出（`src/services/tankService.js`）

| メソッド | パス | 対応する旧GAS機能 |
|---|---|---|
| POST | `/api/tank-operations/transfer` | `submitTankTransfer()` |
| POST | `/api/tank-operations/tax-free-transfer` | `submitTaxFreeTransfer()` |
| GET | `/api/tank-operations/ledger` | 浄酎容器変動履歴の閲覧 |

`tank_ledger`は`to_tank_id`を加算・`from_tank_id`を減算として集計するため（3章）、
受払の種類ごとにどちらの列を埋めるかが決まる。

| 受払 | from | to | 記録元 |
|---|---|---|---|
| 容器移動 | ○ | ○ | tankService |
| 未納税移出 | ○ | −（社外なのでNULL。搬出先は備考へ） | tankService |
| 継足 | − | ○ | distillationService（蒸留完了） |
| 瓶詰 | ○ | − | bottlingService |
| 棚卸調整／欠減 | 増減で使い分け | 同左 | stocktakingService |

**GAS版になかったガードを追加した**：

- 払出元の残量を超える移動・移出を422で拒否する
- 受入先の最大容量を超える移動を422で拒否する（最大容量が未登録のタンクは検査しない）
- 移動元と移動先に同じタンクを指定できない

**理論アルコール度数の加重平均**（4-13 G列の「加重平均で自動計算される度数」）も実装した。
容器移動で受入が発生したとき、`(受入前の液量 × 受入前の度数 + 受入量 × 受入する液の度数) ÷ 受入後の液量`
でタンクマスタの`current_abv`を更新する。受入前が空、または元の度数が不明な場合は
受け入れた液の度数をそのまま採用する。

### 11-2. 在庫監査レポート（`src/services/stockAuditService.js`）

`GET /api/audit`。現行システムでは「在庫監査レポート」シートを新規作成する一度きりの調査用機能だったが
（5章）、**いつでも実行できる読み取り専用のAPI**として実装した。データは一切書き換えない。

| # | 監査項目 | 内容 |
|---|---|---|
| ① | 重複検出 | 同一日・同一商品・同一受払・同一数量の行が複数ある（二重登録の疑い） |
| ② | 在庫のマイナス検出 | 商品・仕掛品・資材・タンク・原酒タンクの集計値が負 |
| ③ | 受注リスト突合 | 発送済なのに出荷行がない／出荷行はあるがステータス未更新／本数の不一致 |
| ④ | 資材消費監査 | 瓶詰め・箱詰めがレシピ通りに資材を消費しているか（旧`auditMaterialConsumption_`） |
| ⑤ | 紐付け漏れ | 瓶詰めにタンク払出がない／完了蒸留に継足がない／FK違反 |

②と⑤は今回追加した項目。①③④は旧実装の番号に対応する。

**③は旧実装より精度が上がっている。** 6-3では「受注番号列が移行期の状態なので、
在庫監査では受注番号ではなく日付×商品名の集計比較を採用している」とされていたが、
新システムでは出荷行に必ず`order_id`が入るため（9-2）、受注番号で厳密に突合できる。
移行した過去データは`order_id`がNULLのことがあるので、それは不整合ではなく
「受注にもサンプルにも紐付かない出荷」として件数のみ別枠で報告する。

### 11-3. 追加した画面

| ファイル | 内容 |
|---|---|
| `tanks.html` | 容器移動・未納税移出の登録と、タンク入出庫履歴の閲覧 |
| `audit.html` | 在庫監査レポート。項目ごとの件数サマリーと明細を表示 |

### 11-4. テスト

`npm test`で68件（全てpass）。今回追加したのは`tests/services/tankAndAudit.test.js`の16件で、
容器移動の増減と加重平均度数、3種のガード（残量不足・容量超過・同一タンク）、未納税移出、
監査①〜⑤それぞれの検出、および「監査を実行してもデータが変わらないこと」を検証している。

画面はPlaywrightで、容器移動→加重平均度数の反映→未納税移出→残量超過エラー表示、
監査の実行（問題なし→不整合を作って再実行）まで通しで動作確認済み。

---

## 12. ログイン認証とHTTPS（実装済み）

### 12-1. 背景

当初は社内LAN内での利用を想定していたが、運用として**自宅からもアクセスする**ことになったため、
「LAN内だから平文HTTPでも実用上は問題になりにくい」という前提が成り立たなくなった。
社外から使う以上、認証とHTTPSは必須である。

### 12-2. 認証の仕組み（migration 0004）

| テーブル | 内容 |
|---|---|
| `users` | ログインID・表示名・パスワードのソルトとハッシュ・権限（admin/staff） |
| `sessions` | セッショントークン・ユーザー・有効期限 |

**パスワードはNode.js標準の`crypto.scrypt`でハッシュ化する。** 外部ライブラリを増やさずに済み、
scryptは計算に時間とメモリを要するため総当たり攻撃に強い。ソルトは利用者ごとにランダム生成する。
照合には`timingSafeEqual`を使い、比較時間から情報が漏れないようにしている。

**セッションは「推測不可能なランダムトークン（256bit）をDBに保存し、HttpOnly Cookieで渡す」方式。**
トークン自体が鍵なので署名は不要で、サーバー側で削除すればログアウトが確実に効く。
Cookieは`HttpOnly`（JavaScriptから読めない）・`SameSite=Lax`・HTTPS時は`Secure`を付ける。

**保護の範囲**：`src/app.js`で、静的ファイルの配信より前に認証チェックを挟んでいる。
これによりHTMLを直接URLで開かれても素通りしない。未ログインで許可するのは
ログイン画面とその表示に必要なCSS/JS/faviconだけ。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/auth/login` | ログイン（Cookieを発行） |
| POST | `/api/auth/logout` | ログアウト（セッションを削除） |
| GET | `/api/auth/me` | ログイン中のユーザー情報 |
| POST | `/api/auth/change-password` | パスワード変更（全セッションを失効させる） |
| GET/POST | `/api/auth/users` | 利用者の一覧・追加（管理者のみ） |

ユーザーの追加は`npm run create-user`（`scripts/create-user.js`）でも行える。
パスワードはコマンドライン引数では受け取らない（シェル履歴やプロセス一覧に残るため）。

### 12-3. HTTPS

2通りに対応している。

**A. Tailscale経由（推奨・手順書の既定）**
アプリ側は設定不要。`tailscale serve --bg 3000`が正式な証明書つきのHTTPSを引き受ける。
インターネットにポートを開けないため、外部から攻撃される入口ができない。

**B. アプリが直接HTTPSで待ち受ける**
`.env`に`TLS_KEY_PATH`と`TLS_CERT_PATH`を両方指定すると、`https.createServer`で起動する。
片方だけの指定は設定漏れとみなして起動時にエラーにする（平文のまま気づかず動くのを防ぐため）。

### 12-4. テストへの影響

認証を有効にすると既存の全テストが401で弾かれるため、
**テスト側を「本番と同じ構成のまま認証を通す」形に変えた**（`requireLogin: false`で迂回はしない）。

`tests/helpers/appHarness.js`が、テスト用DBの用意 → マイグレーション → シード投入 →
管理者ユーザー作成 → ログイン → Cookieを保持したAPIクライアントの提供、までを引き受ける。
各テストは`harness.api(...)`を呼ぶだけでよく、全68件が認証層を通って実行される。

`tests/services/auth.test.js`（15件）では、未ログイン時に業務APIが401で拒否されること、
画面がログイン画面へ誘導されること、Cookieに`HttpOnly`が付くこと、パスワードが平文で
保存されないこと、ログアウト・期限切れ・パスワード変更でセッションが失効すること、
一般ユーザーがユーザー管理APIを使えないことを確認している。

`npm test`は83件（68 + 認証15）。

### 12-5. 現時点で対応していないこと

- **2要素認証**：未対応。必要なら追加できる
- **ログイン失敗回数の制限**：未対応。総当たり対策はscryptの計算コストとVPNによる到達制限に依存している。
  インターネットに直接公開する運用に変えるなら、回数制限の追加が必要
- **操作ログ**：誰がいつ何を登録したかの記録は残していない（`created_at`はあるが操作者は持たない）。
  必要なら台帳テーブルに`created_by`を足すのが素直

---

## 13. 未実装機能の洗い出しと追加実装

11章末尾で「5章の全機能が揃った」と書いたが、これは誤りだった。
`DATA_STRUCTURE.md`に登場する旧GAS関数を機械的に抽出して実装済みAPIと突き合わせたところ、
**移行スクリプトで過去データは取り込めるが、その後の新規入力ができない機能が11件残っていた。**
本章でそれらと、12-5で挙げた未対応のセキュリティ3点を実装した。

### 13-1. セキュリティ（migration 0005）

| # | 機能 | 実装 |
|---|---|---|
| 1 | ログイン失敗回数の制限 | `login_attempts`テーブル。同一IDで5回連続失敗すると15分ロック |
| 2 | 2要素認証 | TOTP（RFC 6238）。`src/utils/totp.js`にNode標準cryptoだけで実装 |
| 3 | 操作ログ | `operation_logs`テーブル＋主要8テーブルへの`created_by`列 |

**失敗回数の制限**は、最後に成功したログインより後の失敗だけを数える方式にした
（一度成功すればカウントがリセットされる）。存在しないIDでも失敗を記録するので、
「ロックされた＝そのIDは実在する」と分かってしまうことはない。

**2要素認証**はGoogle Authenticator等が対応する標準方式。外部ライブラリを使わず、
`crypto.createHmac('sha1', ...)`でRFC 4226の動的切り出しを実装している。
端末の時計ずれを考慮して前後30秒まで許容する。認証器を紛失したとき用に
リカバリコードを10個発行し、**ハッシュ化して保存**（発行時のみ平文で表示、1回限り有効）。

**操作ログ**は「誰がいつ何をしたか」を時系列で残す。
台帳そのものは各テーブルに残るので、ここは操作の記録に徹している。
ログの記録に失敗しても業務処理は止めない（ログのために受注登録が失敗しては本末転倒なため）。
`created_by`は`ALTER TABLE ADD COLUMN`で追加した（SQLiteはこれに対応しているのでテーブル再構築が不要）。

### 13-2. 未実装だった業務機能

| # | 機能 | 旧GAS関数 | 影響 |
|---|---|---|---|
| 4 | **資材入荷** | `submitMaterialReceipt()` | **資材在庫を増やす手段がなかった**（消費だけ自動で減る状態） |
| 5 | 返品 | `submitProductReturn()` | 返品を記録できなかった |
| 6 | サンプル送付 | `submitSampleShipment()` | 8-1でIDの仕組みは作ったが登録手段がなかった |
| 7 | 委託販売実績報告 | `submitConsignmentReport()` | 月次転記ができなかった |
| 8 | 売上目標・進捗率 | `setSalesTarget()` | ダッシュボードの進捗表示がなかった |
| 9 | タンク登録・編集 | `registerTank()` | タンクを追加できなかった |
| 10 | 資材マスタ登録・編集 | — | 資材を追加できなかった |
| 11 | 商品＋レシピ同時登録 | `registerProductWithRecipe()` | レシピが無いと瓶詰めで資材が消費されない |
| 12 | 請求日の一括記録 | `markInvoicesSent()` | 1件ずつしかできなかった |
| 13 | ロック管理 | `lockTank_()` | テーブルは作ったが未使用だった |

#### 主なエンドポイント

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/materials/receipts` | 資材入荷。ロット数の倍数チェックつき |
| GET | `/api/materials/:id/receipt-defaults` | 入荷画面の初期値（旧`getMaterialDefaultPrice`） |
| POST/PUT | `/api/materials` | 資材マスタの登録・編集 |
| POST | `/api/shipments/returns` | 返品 |
| POST/GET | `/api/shipments/samples` | サンプル送付 |
| POST/GET | `/api/shipments/consignment` | 委託販売実績報告 |
| GET | `/api/shipments/consignment/pending` | 未報告の委託受注（プルダウン用） |
| POST/GET | `/api/sales-targets` | 売上目標 |
| GET | `/api/sales-targets/progress` | 当月進捗率 |
| POST/PUT | `/api/tanks` | タンク登録・編集 |
| PUT | `/api/products/:id/recipe` | レシピの差し替え |
| GET | `/api/orders/pending-invoices` | 請求対象の候補 |
| POST | `/api/orders/invoices/bulk` | 請求日の一括記録 |
| POST/DELETE | `/api/locks/distillations/:id` | 蒸留の排他制御 |

#### 実装上の判断

- **資材入荷**：資材マスタのロット数が設定されていれば、その倍数でのみ受け入れる
  （4-18 F列「この数の倍数でのみ入荷登録できる」）。単価・仕入先はマスタから補完する。
- **返品**：受注を指定した場合、商品の一致と「返品数 ≤ 受注数」を検証する。
- **サンプル送付**：送付記録と出荷履歴を同一トランザクションで作り、
  `sample_shipment_id`で確実に紐付ける。8-1で設計した通り、**新規データでは推測マッチングが不要**になる。
- **委託販売実績報告**：委託以外の受注は弾く。同一月の二重報告を防ぎ、
  報告本数の累計が受注本数を超えないよう検証する。入金予定日は転記月の月末を自動設定（4-4 K列）。
- **売上目標の進捗**：実績は納品日ベース。**委託は受注時点では売上に計上せず、
  実績報告された分だけを計上する**（委託の性質上、預けただけでは売上にならないため）。
  目標未設定の月は進捗率を`null`で返す（0%と誤解されないように）。
- **請求日の一括記録**：1件ずつの成否を返すので、既に請求済みのものがあっても
  何が処理され何がスキップされたか分かる。
- **ロック管理**：DBのトランザクションは一瞬の同時書き込みしか守れないため、
  「今この蒸留は誰かが編集中」という数分〜数時間単位の主張はこちらで持つ。
  24時間で自動失効（4-16の運用を踏襲）。管理者は他人のロックも解除できる。

### 13-3. 実装しなかったもの：送料計算機能

`DATA_STRUCTURE.md` 4-1 I列に「送料計算機能で算出、またはマニュアル入力」とあるが、
**料金表のルール（配送業者・地域区分・サイズ別料金）がドキュメントに存在しない。**
推測で運賃表を作ると誤った金額を請求することになるため、実装を見送った。
送料は現状どおり手入力で機能する（`orders.shipping_fee`）。
ルールを確認できれば、`src/services/shippingFeeService.js`として追加できる。

### 13-4. 追加した画面

| ファイル | 内容 |
|---|---|
| `materials.html` | 資材入荷・資材マスタ登録・在庫・入出庫履歴 |
| `shipments.html` | 返品・サンプル送付・委託販売実績報告 |
| `sales-targets.html` | 売上目標の設定と進捗 |
| `settings.html` | 2要素認証・パスワード変更・利用者管理・操作ログ |

`orders.html`に請求日の一括記録を、`index.html`に当月の売上進捗を追加した。

### 13-5. テスト

`npm test`で126件（全てpass）。今回追加したのは
`tests/services/security.test.js`（17件）と`tests/services/remainingFeatures.test.js`（26件）。

画面もPlaywrightで通しで確認した：資材入荷とロット違反エラー、返品、サンプル送付、
委託受注の登録から実績報告、売上目標の設定と進捗表示、請求日の一括記録、
2要素認証の有効化とリカバリコード発行、操作ログの表示まで。

---

## 14. マスタ登録画面（14章）

### 14-1. 何が抜けていたか

13章までで、マスタ操作のAPI（得意先・商品・製品レシピ・タンク・酒蔵・原酒）は
すべて実装していたが、**それを呼ぶ画面が資材マスタ以外に存在しなかった。**
8-2で「酒蔵マスタ・原酒マスタは移行対象外なので画面から順次登録する」と書きながら、
その画面自体を作っていなかった。ここで埋める。

### 14-2. `masters.html`

1画面5タブ（得意先／商品／タンク／酒蔵／原酒）にまとめた。
マスタごとに別画面を作らなかったのは、操作が「一覧から選んで直す」で共通しており、
画面数を増やすほど探す手間が増えるため。

各タブは同じ構造を持つ。

- 上段が入力フォーム。一覧の「編集」を押すと、同じフォームが編集モードに切り替わる
- 中段は商品タブのみ。編集中の商品の**製品レシピ**（資材×必要数×工程）を行単位で編集する
- 下段が一覧。全カラム横断の絞り込みつき。酒蔵・原酒には削除ボタンも出る

フォームは`MASTERS`定義（項目名・型・一覧の列）から生成している。
マスタごとに同じフォーム記述を繰り返さずに済み、項目が増えたときの修正が1箇所で済む。

### 14-3. 設計上の判断

**登録後に変更できない項目は、編集時に`disabled`にする。**
タンクの容器ID・初期在庫量、原酒の初期在庫量は、APIの更新スキーマが受け付けない
（残量再計算の起点なので後から動かすと過去の在庫が変わる）。
画面側で入力できてしまうと「保存したのに変わらない」ことになるため、
理由を添えて明示的に止めている。

**数値・日付欄は空欄なら送らない。**
各モデルの`update`は`COALESCE(@col, col)`で「渡されなければ現状維持」としている。
空欄を`''`で送ると日付のCHECK制約に引っかかるため、送信対象から外す。
文字列欄は`''`をそのまま送るので、画面から消せる。
ただしコード類（得意先コード・商品ID）はUNIQUE制約があり、
空文字が複数行に入ると衝突するため、こちらも空欄なら送らない。

**原酒の酒蔵は、選択と自由入力の両方を残した。**
6-6・8-2の通り紐付けが緩やかなので、一覧から選べばFKで結び、
「一覧にない酒蔵名を直接入力」を選べば`brewery_name_raw`に退避される
（移行データと同じ扱い）。過去データを順次入れていく段階で、
酒蔵マスタが未整備でも原酒を登録できるようにするため。

### 14-4. 制約違反メッセージの日本語化

この画面から初めて「重複した名前で登録」「他から参照されている酒蔵を削除」が
起こせるようになった。従来は`errorHandler`がSQLiteの英語メッセージを
そのまま409で返していたため、次の2つだけ日本語にした。

| 状況 | 返すメッセージ |
|---|---|
| UNIQUE制約違反 | その{項目名}はすでに登録されています。 |
| 外部キー制約違反 | 他の記録から参照されているため削除できません。先に参照している側を消してください。 |

項目名は`errorHandler.js`の`COLUMN_LABELS`で`テーブル.カラム`から引く。
該当がなければ元のメッセージを添えて返すので、未知の制約でも情報は失われない。

### 14-5. テスト

`npm test`で136件（全てpass）。`tests/services/masters.test.js`（10件）を追加し、
得意先の登録・部分更新・重複拒否、日付形式の拒否、酒蔵と原酒のCRUD、
酒蔵ID／酒蔵名の同時指定拒否、参照されている酒蔵の削除拒否、
未ログイン時のリダイレクトを確認している。

画面もPlaywrightで通しで確認した：得意先の登録→編集→重複エラー、
商品の登録→レシピ2行の保存（DB上の`product_recipes`まで確認）、
酒蔵の登録→原酒での選択、一覧にない酒蔵名の直接入力→`brewery_name_raw`への退避、
参照されている酒蔵の削除拒否、タンク編集時の容器ID・初期在庫量の入力不可まで。

---

## 15. GAS版README（2026年8月）との突合（15章）

最新のGAS版READMEと現行実装を1項目ずつ突き合わせ、
足りないもの・食い違っているものを埋めた記録。

### 15-1. 間違っていたこと：受注番号がUNIQUEだった

`DATA_STRUCTURE.md` 3章に
「1つの受注で複数商品を頼まれた場合は、**同じ受注番号で複数行に分かれます**」
とあるのに、`orders.order_no` に UNIQUE を付けていた。
**この状態では複数商品の受注が登録できない。** 設計の読み違いによる実装バグ。

`0006_gas_parity.sql` で UNIQUE を外し、`line_no`（受注番号内の明細行番号）を追加、
`(order_no, line_no)` の複合UNIQUEに置き換えた。
APIは `items` 配列で複数明細を受け取り、単品指定（`productId` / `quantity`）も従来どおり通る。
**送料は受注単位なので1行目にだけ載せる**（全行に載せると二重計上になる）。

UNIQUEを外すにはテーブル再作成が必要で、SQLiteでは外部キーを一時的に切らなければならない。
PRAGMAはトランザクション内では効かないため、マイグレーションランナーに
`-- migrate:no-transaction` マーカーを追加し、そのファイルだけ
BEGIN/COMMITとPRAGMAを自分で面倒みる形にした。

### 15-2. 足りなかったもの

| GAS版の機能 | 埋めた内容 |
|---|---|
| 箱詰めのロット選択・複数ロットまたぎ | `wip_lot_allocations` を新設。瓶詰め1件＝1ロットとして残量を管理し、指定ロット優先＋不足分は古い順に自動補完 |
| 仕掛品滞留アラート（7日） | `GET /api/wip-lots/stale`。ダッシュボードに表示 |
| 記録の取り消し（直近30件・理由必須） | `ledgerCancelService`。瓶詰め・箱詰め・出荷・返品を取消フラグで戻す |
| 送料自動計算 | `prefecture_zones` / `carton_rules`（旧「段ボール対応表」）/ `shipping_rates` と `/api/shipping/quote`。受注画面から「対応表に追加」できる |
| 未入金アラート | `GET /api/dashboard/unpaid`（入金予定日超過かつ入金日なし） |
| 本日の出荷予定 | `GET /api/dashboard/shipments-due` |
| 次回注文予測（確度付き） | `GET /api/dashboard/order-forecast`。直近5回の注文間隔の平均＋ばらつきで確度を出す |
| 営業メモ | `customer_notes`。マスタ画面の得意先編集中に追記できる |
| CSV一括登録（得意先・資材・酒蔵） | `masterImportService`。同名は更新扱い。取り込み前に「確認だけする」ができる |
| タンクのプレフィックス自動採番 | `GET /api/tanks/next-code`。T／B／SP／U／G／JP／Q／DISTL |
| タンクの廃棄（ログを残して非表示） | `tanks.discarded_on`。行は消さない（履歴が参照している） |
| 商品の複製登録 | `POST /api/products/:id/duplicate`。レシピは引き継ぎ、在庫の起点は引き継がない |
| 未対応アラートの消込 | `POST /api/distillations/:id/acknowledge-alert` |
| 原酒入荷時の前ロット残存警告 | `GET /api/raw-sake-receipts/tanks/:id/receipt-check` |

### 15-3. 取消の設計

在庫の現在値はすべて台帳から再計算しており、3つのビューはいずれも
`is_cancelled` の行を0として集計している。
そのため**取消フラグを立てるだけで、商品・仕掛品・資材・タンク残量が同時に戻る。**
数値を直接書き戻さないので、二重に戻す事故が起きない。

- 資材消費・タンク移動は `product_ledger_id` で紐付いているので、まとめて取り消す
- 出荷の取消は受注を「未着手」に戻す（再出荷できるように）
- 箱詰めで使われている瓶詰めは取り消せない。先に箱詰めを取り消してもらう
  （先に瓶詰めを消すと、箱詰め済みの本数の出どころが無くなる）
- 取消理由・実施者・日時を台帳の行に残す（旧「修正履歴」シート相当）

### 15-4. 送料は仕組みだけを作り、運賃表は持たない

決め方は3段階（都道府県→地帯、商品×本数→段ボール、地帯×段ボール→料金）で、
GAS版と同じ。ただし**運賃表の中身はこちらでは持たない。**
どの県がどの地帯かも、いくらかも、契約と運送会社で変わる。
推測で表を作ると実際の請求書に誤った金額が載るため、
`/shipping.html` から実際の運賃表を見て登録してもらう方式にした。

3つとも揃った組み合わせだけ自動で入り、足りないものは受注画面に理由が出る。
段ボールが決まらないときは、その場で選んで計算し、
「対応表に追加」を押せば次回から自動になる（GAS版と同じ運用）。

なお対応表は「商品×本数」の1対1なので、**複数商品の受注は自動で決まらない。**
その場合は段ボールを選ぶよう促す。

### 15-5. 埋めていないもの

- **ゆうパックCSV（72列・ヘッダーなし・Shift_JIS）とマネーフォワードCSV（csv_type 40202・横型明細7品目）。**
  現行の実装は列数も文字コードも仕様と違う。ただし**72列の並び順がREADMEに書かれていない**ため、
  推測で並べるとゆうプリ側で取り込めないファイルになる。
  `CsvExportCode.gs` の列定義をもらえれば、そのまま移せる
- **遮断型ポップアップ**：重大な警告を画面全体を覆うポップアップで出す挙動。
  現状は画面上部のメッセージと `confirm()` で止めている。業務は成立するが操作感は同じではない
- **ダッシュボードのPC版／スマホ版の切替**：現状は1つの画面をレスポンシブに畳んでいる
- **製造記録簿との連携**（はかりマス・二次浄溜・混和）：GAS版でも未実装

### 15-6. シートとして持たなかったもの

GAS版が別シートで持っている次のものは、こちらでは台帳と操作ログに持たせた。
別テーブルにすると同じ事実が2箇所に増え、片方だけ直る事故が起きるため。

| GAS版のシート | こちらでの持ち方 |
|---|---|
| 修正履歴 | 台帳行の `is_cancelled` / `cancel_reason` / `cancelled_at` / `cancelled_by` |
| アラート処理履歴 | `distillations.alert_acknowledged_on` ほか |
| 棚卸調整履歴 | 各台帳の「棚卸調整」区分の行そのもの |
| 資材在庫モニター | `v_material_stock`（ビューなので再計算不要） |

### 15-7. テスト

`npm test` で165件（全てpass）。`tests/services/gasParity.test.js`（29件）を追加した。
複数明細の受注、ロットの引当とFIFO補完、取消による在庫・資材・ロットの復元、
出荷取消での受注差し戻し、送料の3段階判定と未登録時の理由、
未入金・出荷予定・注文予測、タンクの採番と廃棄、営業メモ、商品複製、
アラート消込、CSV一括登録の検証を含む。

画面もPlaywrightで通しで確認した：地帯と料金の登録 →
受注画面で送料が「未登録」と出る → 段ボールを選んで「対応表に追加」 → 送料が自動で入る →
2明細の受注を同じ受注番号で登録（送料は1行目のみ）→ 瓶詰め → ロットを見ながら箱詰め →
取消で在庫が戻る → QBテナーの自動採番（Q-01）→ 廃棄 → 商品複製（レシピ引き継ぎ）→
営業メモ → CSV一括登録まで。

---

## 16. 更新時の「Unexpected token '<'」への対処（16章）

### 16-1. 何が起きていたか

`git pull` の後、全画面の上部に
`Unexpected token '<', "<!DOCTYPE "... is not valid JSON` が出た。

原因は**アプリの不具合ではなく、サーバーを再起動していなかったこと**。

- 画面ファイル（`public/`）は**リクエストのたびにディスクから読む**ので、`git pull` で即座に新しくなる
- ルーティング（`src/routes/`）は**起動時に読み込む**ので、再起動するまで古いまま

その結果、新しい画面が新しいAPI（`/api/dashboard/...`、`/api/shipping/...` 等）を呼び、
古いサーバーがそれを知らずにExpress既定の**HTMLの404ページ**を返す。
画面側はJSONを期待して `JSON.parse` するので、HTMLの先頭 `<` で落ちていた。

### 16-2. なぜメッセージが役に立たなかったか

`Unexpected token '<'` は**JSONパーサの都合を言っているだけ**で、
利用者にとっては何が起きたか分からない。原因（サーバーが古い）にも、
対処（再起動）にもたどり着けない。これは実装側の落ち度なので直した。

### 16-3. 直したこと

**1. 存在しない `/api/...` はJSONで返す**

`app.js` の最後、`errorHandler` の手前に `/api` の404ハンドラを置いた。

```
この機能はサーバー側にありません（GET /api/dashboard/unpaid）。
画面だけが新しく、サーバーが更新前のまま動いている可能性があります。
サーバー機でアプリを再起動してください。
```

`/api` の下だけを対象にしているので、画面ファイルの404は従来どおり。

**2. 画面側がJSON以外の応答を判別する**

`public/assets/js/app.js` の `api()` で `JSON.parse` を try/catch に入れ、
JSONでなければ「この機能がサーバーにありません（パス）。再起動してください」を出す。
ログイン画面へのリダイレクトHTMLが返るケースも同じ経路で拾える。

**3. 1つの取得の失敗で画面全体が止まらないようにする**

ダッシュボードは10個のAPIを `Promise.all` で並列に呼んでいたため、
1つ404になるだけで**全部の数字が「-」**になっていた。
`Promise.allSettled` に変え、取れたものは表示して、失敗したものだけ理由を出す。
マスタ画面も同様で、補助的な取得（酒蔵・資材・タンク種別・CSVの見出し）が失敗しても、
得意先・商品の登録は続けられるようにした。

### 16-4. 確認方法

古いサーバー（`da4e83b`）に新しい画面ファイルだけを載せた環境を作り、
実際にブラウザで再現・修正を確認した。修正後は次のように出る。

```
【ダッシュボード】この機能がサーバーにありません（/api/dashboard/shipments-due）。
                 サーバー機でアプリを再起動してください。
   → 未着手の受注などは表示されたまま
【マスタ】タブも入力欄も描画され、操作できる
```

`npm test` は168件（`/api` の404がJSONであること、
画面ファイルの404は変えていないことの検証を3件追加）。

---

## 17. マスタコードの自動採番（17章）

### 17-1. シートの「顧客ID」＝ 得意先コード

`DATA_STRUCTURE.md` 得意先マスタ A列「顧客ID」（`C0001` 形式）が、
このアプリの `customers.code`（画面上の「得意先コード」）にあたる。
移行スクリプトも `顧客ID` 列をそのまま `code` に入れている。

同じ対応関係が他のマスタにもある。

| シートの列 | テーブル | 画面 |
|---|---|---|
| 得意先マスタ A「顧客ID」 | `customers.code` | 得意先コード |
| 商品マスタ K「商品ID」 | `products.code` | 商品ID |
| 資材マスタ A「資材ID」 | `materials.code` | 資材ID |
| タンクマスタ 容器ID | `tanks.code` | 容器ID |
| 酒蔵マスタ A「酒蔵ID」 | `breweries.code` | 酒蔵ID（17-3で追加） |

原酒マスタ H列の「ID」は8桁ランダムの内部IDなので、これは `code` ではなく
全マスタ共通の `uid` にあたる。表示用コードの列は無い。

### 17-2. 新規登録時に次の番号を先に出す

GAS版READMEのマスター登録は「IDはすべて自動採番」だが、
こちらの画面は空欄の手入力のままだった。次の番号を初期値として入れるようにした。

**プレフィックスと桁数は既存データから読み取る**（`src/utils/masterCode.js`）。
こちらで `C` や4桁を決め打ちにすると、移行した過去データと形が変わって
`C0001` と `CUST-1` が混ざる。1件も無いときだけ既定値（C／P／M／B）を使う。

- `C0035` まであれば次は `C0036`
- 書き方が混在していたら**多数派に合わせる**。誰かが1件だけ違う形で登録しても、
  以降の採番がそちらに引きずられない
- 登録後は次の番号に更新される

**採番は「決定」ではなく初期表示**にしてある。入力欄なので手で書き換えて登録でき、
確定するのは保存したときだけ。編集モードでは既存の値に触らない。

タンクだけは仕組みが違い、容器種別（タンク／ボンベ／QBテナー等）を選ぶと
その種別のプレフィックスで採番する（15-2）。番号の体系が種別ごとに分かれているため。

### 17-3. 酒蔵マスタにコード列を足した

シートの酒蔵マスタにはA列「酒蔵ID」があるのに、こちらのテーブルは列を落としていた。
酒蔵は移行対象外のマスタなので実データの取りこぼしは無いが、
画面から登録するときに採番できないため `0007_brewery_code.sql` で追加した。
NULLを許す部分UNIQUEにしてあるので、コードを入れずに登録することもできる。

### 17-4. テスト

`npm test` で174件（全てpass）。採番まわりを6件追加した。
既存データの続きになること、1件も無ければ既定のプレフィックスで1番から始まること、
多数派の書き方が保たれること、`/next-code` が `/:id` ルートに食われていないこと、
酒蔵IDの重複が拒否されることを見ている。

画面でも、`C0001`〜`C0035` が入った状態から
得意先タブに `C0036` と「C0035 の次の番号です。変更もできます」が出ること、
そのまま登録できること、登録後に `C0037` へ進むこと、
手で `C9999` に書き換えても登録できること、
編集モードでは既存の値が書き換わらないことを確認した。

---

## 18. CSV一括登録が実データを受け取れなかった件（18章）

### 18-1. 直接の原因

`Invalid Record Length: columns length is 14, got 15 on line 2`

**こちらのテンプレートの見出し行（14列）に、スプレッドシートのデータ行（15列）を
貼り付けた**ために起きた。列数が合わないのでcsv-parseが読めずに止まった。

シートの書き出しファイル自体は正常で、単体では問題なく読める（156行）。
つまりデータの不備ではなく、**こちらのテンプレートに合わせて貼り直させる作りが原因**。

こちらの見出しとシートの見出しは、名前も並び順も違っていた。

| こちら | シート |
|---|---|
| 得意先コード | 顧客ID |
| 支払いサイト日 | 支払いサイト日付 |
| 請求書送付期日 | 請求日送付期日 |
| （列なし） | 最終訪問日 |

### 18-2. 直したこと：シートの書き出しをそのまま受け取る

- **シート側の列名を別名として登録**した（顧客ID＝得意先コード など）。
  見出しを書き換えずに貼り付けられる
- **列の並び順は問わない**。見出し名で対応づける
- **知らない列は取り込まずに報告するだけ**にした。従来はエラーで全体を止めていたが、
  シートには使わない列も混ざるので、そこで止めるのは実務に合わない
- **タブ区切りを自動判別**する。スプレッドシートから直接コピーするとタブ区切りになる
- 最終訪問日を取り込み対象に追加した（`customers.last_visited_on` は元からある）

エラーメッセージも英語のまま出していたので、日本語にした。

```
見出し行は3列ですが、2行目は6列あります。
見出し行とデータ行が別々のところから来ていないか確認してください
（こちらのテンプレートの見出しに、スプレッドシートの行をそのまま貼ると起きます）。
スプレッドシートの見出し行ごと貼り付ければ、そのまま取り込めます。
```

### 18-3. 見つかった設計不一致：支払いサイト月数

実データを通したところ17件がエラーになった。原因は**言葉と数値の食い違い**。

シートの「支払いサイト月数」は `当月` `翌月` `翌々月` という**言葉**で入っている
（`DATA_STRUCTURE.md` 得意先マスタ G列）。
一方こちらの `customers.payment_term_months` は INTEGER で、
入金予定日の計算（`calcPaymentDueOn`）が納品日に月数を足す前提になっている。

数値で持つ方針自体は変えない（言葉のままでは日付計算ができない）。
`src/utils/paymentTerm.js` に読み替えを作り、当月=0／翌月=1／翌々月=2 で取り込む。

**同じ不具合が移行スクリプトにもあった。**
`scripts/loaders/customers.js` は `Number(row['支払いサイト月数'])` としており、
`Number('翌月')` は例外にならず NaN になる。
そのまま流していたら**支払いサイトが全件失われ、入金予定日の自動計算が効かなくなっていた。**
こちらも同じ読み替えを通すようにした。

解釈できない言葉（「応相談」など）は、受け付ける書き方を添えて行番号つきで指摘する。

### 18-4. ついでに直したこと：得意先を選んだ時点の反映

GAS版READMEは「得意先選択で掛け率・支払いサイト・住所を自動反映」だが、
こちらは商品と本数まで揃わないと何も反映していなかった。
得意先を選んだ時点で掛率・支払いサイト・請求日送付期日を出し、
配送先に住所を初期値として入れるようにした（入力済みなら触らない）。

### 18-5. 確認

実際にいただいたシートの書き出しファイル（156件）で確認した。

```
確認だけする → 新規 156件 / 更新 0件 / 取り込まない列: なし
取り込む     → DB 156件、掛率 156件、支払いサイト 17件（シートで埋まっている件数と一致）
一覧「カナカン」で絞り込み → 7件
受注画面の得意先検索「カナカン」 → 12件、選ぶと掛率0.7・住所・支払いサイトが入る
次の得意先コード → C0157（シートはC0156まで）
```

住所に改行を含む行（I.P.S.(株)）、引用符を含む名前（`Dining Table 10"1`）も壊れない。

`npm test` は182件（全てpass）。CSV取り込みまわりを8件追加した。

---

## 19. スプレッドシート／GAS本体との突合（19章）

### 19-1. 今回は実物を読んで照合した

これまでは `DATA_STRUCTURE.md`（人が書いた仕様書）を根拠にしていたが、
今回は**スプレッドシート本体とGASプロジェクトのソースそのもの**を取得して突き合わせた。

- スプレッドシート「受注管理」全31シートの見出し行
- GASプロジェクト全23ファイル（`.gs` 5,555行 ＋ `.html` 11本）

その結果、仕様書だけでは分からない食い違いがいくつも見つかった。

### 19-2. 資材の一括登録が実物と別物だった

こちらのテンプレートは9列、実際の資材マスタは14列で、並び順も違っていた。
**シートの列と並びをそのまま採用**し、落ちていた項目を全部つないだ。

| 落ちていた列 | 対応先 |
|---|---|
| 資材種別 | `materials.category` |
| 発注先住所 | `materials.supplier_address` |
| 発注先担当者名 | `materials.supplier_contact` |
| 備考 | `materials.note` |

列自体はテーブルにもAPIにもあったのに、取り込みの入口だけが狭かった。
「単価×ロット数(円)」はシート上の計算列なので取り込まず、無視した列として報告する。

**リードタイムは「1日」「3週間」「1.5ヶ月」「-」という書き方**で入っており、
`lead_time_days`（整数）にそのままでは入らない。`src/utils/leadTime.js` で
日数に読み替える（1週間=7日、1ヶ月=30日の目安。「-」は未設定）。
支払いサイト月数（18-3）と同じ種類の不一致で、放置すると黙って全件失われる。

### 19-3. 商品マスタ・製品レシピマスタの一括登録を追加

商品は14列すべて、レシピは5列すべてシートの並びどおりに対応した。

**製品レシピの「ステータス」列が工程（瓶詰／箱詰）**である。
名前から状態を表す列に見えるが、実データは瓶詰30件・箱詰11件で、
`product_recipes.process` にあたる。
レシピは「商品×資材×工程」で1行なので、商品名・資材名でマスタを引いて突き合わせる。
マスタに無い名前は取り込まずに行番号つきで報告する
（ここで商品や資材を勝手に作ると、表記ゆれの分だけマスタが増えて収拾がつかなくなる）。

シートの「レシピID」（`W300-0001` 形式）も持たせた（`0008_recipe_code.sql`）。

### 19-4. 不備のある行は飛ばして、残りを取り込む

実データを流したところ、次のような行が出た。

- 資材 MAT-015 のロット数が `500（3000）`（数値として読めない）
- 商品名称が空の行
- レシピが参照する資材・商品がマスタに無い

従来は1行でもエラーがあると全体を止めていたが、実データには必ず例外が混ざる。
**飛ばした行を理由つきで報告し、残りは取り込む**方式に変えた。

### 19-5. 製品レシピの登録画面

これまでレシピは「商品タブで商品を編集モードにすると出る」場所にしかなく、
気づきにくかった。マスタ画面に**「製品レシピ」タブ**を足し、
全商品のレシピ一覧・絞り込み・1行ずつの追加／読み込み／削除ができるようにした。
`GET/POST /api/products/recipes`、`DELETE /api/products/recipes/:id` を追加している。

### 19-6. タンクの容器種別が推測と違っていた

15-2でタンクのプレフィックス自動採番を入れたとき、種別名をこちらで推測していた。
GASの `TANK_PREFIX_MAP` と実データを見ると、**種別名も採番の桁数も違っていた。**

| 容器種別 | プレフィックス |
|---|---|
| ステンレスタンク | T |
| 木樽 | B |
| 原酒ポリタンク | SP |
| 残渣タンク | U |
| 一斗瓶 | G |
| 出荷用ポリタンク | JP |
| QBテナー | Q |
| 蒸留機 | DISTL |

採番は `T-001` の3桁ゼロ埋め（実データも `T-001` `B-001` `U-001`）。
GAS版に合わせて直した。

### 19-7. 取引系シートの列の照合結果

主要な台帳・記録シートは、次のとおり列が揃っていた。

| シート | 結果 |
|---|---|
| 商品在庫変動履歴 | ✓ 全列 |
| 浄酎容器変動履歴 | ✓ 全列 |
| 蒸留記録／蒸留明細記録／原料受払記録／残渣回収記録 | ✓（食塩ステータス・塩分濃度・蒸留設定時間まで） |
| サンプル、販促資料送付 | ✓（得意先名前・後追い連絡日・電話番号まで） |
| 委託販売実績報告 | ✓ 全列 |
| 資材在庫変動履歴 | ✓（「元ID」はシート側の行識別用ランダムID。こちらは主キーがあるので不要） |
| 営業メモ | **「種別」が無かった** → `0009_customer_note_category.sql` で追加 |

シートの「ID」列（8桁ランダム）は、マスタでは `uid` として持っている。
台帳・トランザクションには持たせていない（0章の方針どおり、主キーで足りるため）。

### 19-8. GASの公開関数と現状の対応

`.gs` 12ファイルの公開関数（画面から呼ばれるAPI相当）を全て洗い出して対応を確認した。
対応済みが大半で、未対応は次のとおり。

| 未対応 | 内容 |
|---|---|
| `exportYupackCsv` / `exportMoneyForwardCsv` | **列定義が手に入った。** ゆうパックは72列・ヘッダーなし・Shift_JIS、差し込み位置も判明。次の作業で移す |
| `getCorrectionHistory` | 取消の履歴一覧。取消自体はできるが、一覧で見る画面が無い |
| `addDistillationDetailItem` | 蒸留中に投入明細を後から足す |
| `getStaffOptions` | 担当者名の候補（既存データから拾う） |
| `repairMaterialLedgerColumnShift` / `runDataMigration` | 過去データの一度きりの修復。移植不要 |

また、シートには**「見積済み」（見積管理）**があり、
見積日・原価・1本あたり利益額・取引利益・確度などを持っている。
GAS側にも対応する関数が無く、手入力のシートとして運用されている。
こちらにも機能は無いので、必要であれば別途。

### 19-9. 確認

`npm test` は183件（全てpass）。

実データでの確認（スプレッドシートの各シートをそのまま貼り付け）：

```
資材   → 新規32件 / 飛ばした1件（MAT-015のロット数「500（3000）」）/ 無視列: 単価×ロット数(円)
商品   → 新規21件 / 飛ばした1件（商品名称が空の行）
レシピ → 新規38件 / 飛ばした3件（マスタに無い商品・資材を参照している行）
```

資材は種別・発注先住所・担当者・備考・リードタイムまで入り、
`1日→1`、`1.5ヶ月→45`、`3週間→21` と日数に変換されている。
取り込んだレシピで瓶詰めを実行し、300mlガラス瓶・コルクキャップ・キャップシールが
実際に引き落とされることも確認した。

---

## 20. 未対応だったGAS機能の移植（20章）

19-8で残していた項目を、GASのソースから列定義・固定値・判定順をそのまま移して実装した。
推測で埋めた箇所は無い。

### 20-1. ゆうパック出荷予定データCSV（72列・ヘッダーなし・Shift_JIS）

`CsvExportCode.gs` の実装をそのまま移した。

- **72列固定**。ヘッダー行は出さない
- **Shift_JIS** でエンコードして返す（`iconv-lite`）。UTF-8のままだとゆうプリ側で文字化けする
- **全セルをダブルクォートで囲む**。郵便番号・電話番号の先頭0がExcelで消えるのを防ぐため
- 差し込み位置（1商品／8お届け先名／11郵便番号／35品名／46ビン類／52配達希望日／63サイズ 等）は
  GASの `row[n]` の代入をそのまま写した
- 自社情報（`SENDER_INFO`）・固定値（`YUPACK_DEFAULTS`）も同じ値
- **同じ受注番号は複数明細でも荷物1件**として1行にまとめる

住所の分解（`parseShippingAddress_`）も判定順ごと移植した（`src/utils/shippingAddress.js`）。
ラベル除去 → 配送指定情報の除去 → 郵便番号 → 電話番号 → 氏名（様/殿/御中）→ 都道府県 →
残りを市区町村郡・丁目番地号・建物名、という順序に意味がある。
郵便番号・都道府県・市区町村郡が揃わない受注は、レスポンスヘッダ `X-Unresolved` で知らせる。

### 20-2. マネーフォワード納品書CSV（csv_type 40202・横型明細7品目）

- 基本24列 ＋ 明細8列 × 7品目 ＝ 80列
- UTF-8 BOM付き、CRLF
- 単価は**単価×掛け率の四捨五入**（GASと同じ）
- 送料は7品目の枠に空きがあれば1明細として足す
- 8品目以上の受注は `X-Overflow` ヘッダで知らせる（収まりきらないため）

### 20-3. 送料の運賃表を実データに置き換えた

15-4では「運賃表は推測できないので空にする」としていたが、
GASの `OrderCode.gs` に日本郵便送料計算シートの内容が定数として入っていた。

- `ZONE_MASTER`：47都道府県 → 県内／第1／第2／第3／第5／第10地帯
- `ZONE_PRICE_TABLE`：6地帯 × 7サイズ（60〜170）＝ 42件

`0010_shipping_rates_seed.sql` で初期データとして入れた（`INSERT OR IGNORE` なので、
すでに手で直した値は上書きしない）。石川県は「県内」で100サイズ739円、
沖縄県は「第10地帯」で170サイズ4,046円。料金改定時は送料設定画面から直せる。

段ボール対応表（`BOX_RULES`）は商品名で書かれているため初期投入はしていない。
サイズの呼び名を揃えるため、`carton_rules.box_name`（300ml12本用 等）を足した。

### 20-4. 修正履歴（旧 getCorrectionHistory）

シートは 日時／ユーザー／対象種別／対象ID／操作内容／理由 の6列。
こちらは15-6の方針どおり別テーブルを作らず、取消した行そのものに理由・実施者・日時を残している。
`correctionHistoryService` がその行を集めて、シートと同じ形の一覧にする。
商品・資材・タンクの各履歴と蒸留明細の部分取消を UNION して新しい順に並べ、
在庫監査画面（`/audit.html`）に出す。伝票番号で絞り込める。

### 20-5. 蒸留中の投入明細の追加（旧 addDistillationDetailItem）

誤ったタンクで登録したときに、明細を取り消してから正しいタンクで入れ直すための操作。
原料受払記録に「払出」を1行足し、明細を1行足して、投入量合計を数え直す。
開始時（`submitDistillationStart`）と同じ流れで、残量チェックも同じ。
完了済みの蒸留には足せない。

### 20-6. 担当者の候補（旧 getStaffOptions）

GAS版は7名の固定リストだった。固定リストだけだと人が増えるたびにコードを直すことになるので、
**固定リスト ＋ 得意先マスタで実際に使われている担当者名**を合わせて返すようにした。

### 20-7. 見積管理（シート「見積済み」）

GASには対応する関数が無く、シートに手入力する運用だった。列はシートのとおり。

| シート | 持ち方 |
|---|---|
| 見積日／得意先名／商品名／個数／単価／原価／掛け率／確度／納品予定日／備考 | `quotations` に保存 |
| 売価／1本あたり利益額／取引金額／取引利益 | `v_quotations` で算出（シートの計算列と同じ式） |

確度は0〜1で持ち、画面では%で入出力する。状態（見積中／受注／失注）を足したので、
見積中だけの合計と、**確度をかけた見込み額**が出せる。

実データで検算した（横山商会・504本・単価3,300・原価1,304・掛率0.6）：
売価1,980／1本あたり利益676／取引金額997,920／取引利益340,704。シートと一致する。

### 20-8. テスト

`npm test` は195件（全てpass）。今回の追加は次のとおり。

- ゆうパックCSVが72列・ヘッダーなし・Shift_JISで、各差し込み位置が正しいこと
- 同じ受注番号が荷物1件にまとまること、住所を分解できない受注が報告されること
- マネーフォワードCSVが csv_type 40202・80列で、小計/税/合計と明細が正しいこと
- 蒸留明細の追加、残量超過の拒否、完了済みへの追加の拒否
- 修正履歴に取消が集まり、伝票番号で絞り込めること
- 担当者候補、見積の計算・状態遷移・確度の範囲チェック

画面もPlaywrightで通しで確認した。

---

## 21. スマホ・タブレット対応と、シート列の再突合（21章）

### 21-1. 画面をスマホ／タブレットで見られるようにする

もともと1440px前提の作りで、iPhoneで開くと横スクロールが出て操作できなかった。
`public/assets/css/app.css` に「幅が狭いときだけ効く」上書きを足した（PC表示は変えていない）。

| 幅 | 変えたこと |
|---|---|
| 1024px以下（iPad） | 余白を詰める／入力欄を16pxにする／ボタンの高さを40pxにする |
| 640px以下（スマホ） | メニューを1段の横スクロールにする／入力欄を1列に積む／ボタンを44px（指で押せる高さ）にする／表の文字を13pxにする／行内のボタンを縦積みにする |
| 380px以下 | ダッシュボードの数値カードを1列にする |

入力欄を**16px**にしているのは見た目の都合ではない。
iOS Safariは16px未満の入力欄にフォーカスすると画面を勝手に拡大し、
その後もとの倍率に戻らない。16pxにしておくと拡大が起きない。

表は消さずに `.table-scroll` の中で横スクロールさせる。
スクロールできることが分かるように、左右の端に薄い影を出している。

実機プロファイル（Playwright）で確認した結果：

| | 横はみ出し | メニュー | 入力欄 | ボタン高 | 入力欄の列数 |
|---|---|---|---|---|---|
| iPhone 14（390px） | 0px | 1段・横スクロール | 16px | 44px | 1列 |
| iPad gen7（810px） | 0px | 2段 | 16px | 40px | 3列 |
| PC（1440px） | 0px | 1段 | 14px | 36px | 4列 |

### 21-2. 蒸留の完了報告をフォームにした

完了報告は `prompt()` を4回続けて出す作りだった。スマホでは1問ずつのダイアログになり、
入力し直しもできない。また、**食塩ステータス・食塩投入量・塩分濃度はDBとAPIにはあるのに
画面から入力できず**、シートにある項目が実質使えなくなっていた。

GAS版の完了タブ（`Form.html`）と同じ項目をそのままフォームにした。

| 項目 | GAS版 | 今回 |
|---|---|---|
| 蒸留量(L)／アルコール度数(%)／払出先タンク | あり | あり |
| 残渣回収量(L)／残渣払出先 | あり | あり（＋回収時のアルコール度数） |
| 食塩ステータス | `無`／`有` のプルダウン | 同じ |
| 食塩投入量(g) | **「有」のときだけ表示** | 同じ |
| 塩分濃度 | シートには列があるがGASは空で書いていた | 任意入力できるようにした |

食塩ステータスが「無」のときの投入量は、GAS版と同じく0で確定させる。
残渣は、回収量・払出先・食塩のいずれかを入力したときだけ記録を作る。

### 21-3. シートと列を突き合わせて見つかった2件

対応済み20シートの列を1列ずつ並べて確認した。ずれていたのは次の2件だけで、
`0012_ledger_source_and_detail_code.sql` で直した。

**(1) 原料受払記録の「受入元」列が無かった**

シートは 受入元／払出先 の2列を、受払区分で使い分けている。

| 受払区分 | 受入元 | 払出先 |
|---|---|---|
| 受入 | 酒蔵名・原酒タンク名（実データ例：鳥屋原酒タンク） | 入荷先タンク（例：SP-001） |
| 払出 | 投入元タンク | 蒸留ID |

こちらは払出先側（`to_ref` / `to_tank_id` / `distillation_id`）しか列を持っておらず、
受入のときの受入元を備考へ `受入元: ○○` という文字列で押し込んでいた。
列で検索できないうえ、**受入元と備考を両方書くと備考のほうが消えていた**。
`raw_sake_ledger.source_ref` を足し、すでに備考に入っている分は移行時に列へ移す。

**(2) 蒸留明細記録の「明細ID」が無かった**

シートは1明細ごとに `DTL-1` 形式のIDを持ち、取消や差し替えの記録がこのIDを指す
（GAS `generateDetailId_`）。`distillation_details.detail_code` を足し、
投入明細を作るときに採番する。部分取消の戻し行の受入元にもこのIDを書く。

なお `planned_duration`（蒸留設定時間）は、シートが "1:39" のような表記なので
数値ではなくTEXTのままが正しい。これは既存のままでよかった。

### 21-4. テスト

`npm test` は201件（全てpass）。今回の追加は次のとおり。

- 受入元が専用列に入り、備考と同時に書いても備考が消えないこと
- 投入明細に `DTL-1` 形式の明細IDが振られること

完了報告フォームはPlaywrightのiPhone 14プロファイルで通した。
食塩ステータスを「有」にしたときだけ投入量が現れること、
残渣（回収量30L・食塩有250g・塩分濃度1.2%・払出先「黒タンク6」）が
そのまま保存されることまで確認している。
