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
