-- 送り状（Webゆうパックプリント）・納品書（マネーフォワード）への自動登録の記録
--
-- 毎朝8時（と手動実行）に、未出荷のカナカン・COREZOの受注を
-- Webゆうパックプリントの出荷予定データと、マネーフォワードの納品書に登録する。
-- **同じ受注を二重に登録しない**ために、登録できた受注番号をここに残す。
-- 失敗したものは残さない（次の実行でもう一度試す）。

CREATE TABLE ship_doc_uploads (
  id           INTEGER PRIMARY KEY,
  order_no     TEXT NOT NULL,                         -- 受注番号（1受注で複数明細でも1件）
  target       TEXT NOT NULL CHECK (target IN ('yupack', 'moneyforward')),
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  csv_file     TEXT,                                  -- アップロードしたCSV（logs/ship-docs/ 配下）
  UNIQUE (order_no, target)
);
