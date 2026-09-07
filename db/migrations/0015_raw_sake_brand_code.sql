-- migrate:no-transaction
-- 原酒マスタを、銘柄名ではなく原酒IDで持つ。
--
-- raw_sake_brands.name は NOT NULL UNIQUE だったので、同じ銘柄名の行を2つ持てない。
-- ところが原酒は「同じ銘柄の別ロット」で度数が違う。実データの原酒マスタには
--
--   toriya-BYR6-L1  浄酎用池月  18.3
--   toriya-BYR6-L2  浄酎用池月  18.8
--
-- が並んでいて、名前が一意でないため片方しか入らず、
-- 流し直すたびに度数が 18.3 と 18.8 で入れ替わっていた。
-- 度数は蒸留の計算に効く値なので、黙って片方を捨てるわけにいかない。
--
-- シート側は既に「ID＝銘柄＋ロット」で採番している（toriya-BYR6-L1）ので、
-- こちらもIDを行の同一性に使う。他のマスタ（得意先・商品・資材・容器・酒蔵）が
-- code を持っているのと同じ形にそろえる。
--
-- 銘柄名は引き続き必須だが、一意ではなくなる。
-- 名前で原酒を引いている箇所（原酒受払記録の「原酒スペック」列）は、
-- 名前が重複していたら引かずに不一致として報告する作りに変えてある。
-- 黙ってどちらかのロットを選ぶと、度数の違うものを取り違えるため。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE raw_sake_brands_new (
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

-- code は既存行には無い。次の取り込みでシートのIDが入る
-- （取り込みは「codeで探す→無ければ名前で探す」の順なので、空のままでも拾える）。
INSERT INTO raw_sake_brands_new
  SELECT id, uid, NULL, name, abv, sake_meter_value, brewery_id, brewery_name_raw,
         status, produced_on, note, registered_on, initial_stock, current_stock
    FROM raw_sake_brands;

DROP TABLE raw_sake_brands;
ALTER TABLE raw_sake_brands_new RENAME TO raw_sake_brands;

-- 銘柄名で引く経路が残っているので、名前にも索引を張っておく
CREATE INDEX idx_raw_sake_brands_name ON raw_sake_brands(name);

COMMIT;

PRAGMA foreign_keys = ON;
