-- 入金の消し込み
--
-- 通帳に入金があったときに消し込む手段が無かった。あったのは orders.paid_on
-- （日付だけ。**入金額の列が無い**）と、どの画面からも呼ばれていない
-- POST /api/orders/:id/payment だけ。旧シート21枚にも入金のシートは無い。
--
-- 実際の運用は
--   ・1回の振込で複数の請求がまとめて払われる（まとめ入金）
--   ・振込手数料が引かれて端数が残る
--   ・一部だけ入る
-- なので、受注に日付を1つ持たせる形では表せない。
-- **入金を別の記録として持ち、請求に割り当てる**（wip_lot_allocations /
-- raw_sake_lot_allocations と同じ引き当ての作法）。
--
-- ## 消し込みの単位は受注番号
--
-- 納品書・請求書が受注番号単位で出ている（csvExportService の
-- マネーフォワード納品書CSVは groupByOrderNo でまとめている）ので、
-- 得意先が見ている単位に合わせる。
--
-- order_no に外部キーは張れない。ux_orders_line(order_no, line_no) のとおり
-- 受注番号は明細の数だけ重複する（1受注で複数商品なら同じ番号が複数行）。
-- **存在確認はサービス側で行う。**

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  payment_no   TEXT UNIQUE,                       -- P+年月+連番
  paid_on      TEXT NOT NULL CHECK (paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- 通帳の日付
  customer_id  INTEGER REFERENCES customers(id),  -- 誰からか（通帳だけでは決められないことがあるのでNULL可）
  amount       REAL NOT NULL,                     -- 入金額
  payer_name   TEXT,                              -- 振込名義（通帳の表記。得意先名と違うことがある）
  note         TEXT,
  is_cancelled INTEGER NOT NULL DEFAULT 0,        -- 打ち間違いの取消（受注・台帳と同じ4列）
  cancel_reason TEXT,
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payment_allocations (
  id                    INTEGER PRIMARY KEY,
  payment_id            INTEGER NOT NULL REFERENCES payments(id),
  order_no              TEXT,                                          -- 受注への割当（受注番号）
  consignment_report_id INTEGER REFERENCES consignment_reports(id),    -- 委託への割当
  amount                REAL NOT NULL,
  -- 入金 … その入金の金額を使う。合計は payments.amount を超えられない
  -- 端数 … 振込手数料・値引き。**入金の金額は使わないが、請求の残額は減らす**
  kind                  TEXT NOT NULL DEFAULT '入金' CHECK (kind IN ('入金','端数')),
  note                  TEXT,                                          -- 端数の理由など
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- 割当先は受注か委託のどちらか一方
  -- （product_stock_ledger の order_id / sample_shipment_id と同じ作法）
  CHECK ((order_no IS NULL) <> (consignment_report_id IS NULL))
);

CREATE INDEX idx_payment_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_alloc_order   ON payment_allocations(order_no);
CREATE INDEX idx_payment_alloc_report  ON payment_allocations(consignment_report_id);

-- 委託販売実績報告の報告番号が**採番されていなかった**。
-- 列も「C+年月+連番」というコメントもあるのに、submitConsignmentReport が入れていない。
-- 消し込みの画面でどの報告かを名指しできないと使えないので、ここで既存分を埋める。
-- 報告月ごとに id 順で連番を振る（採番の作法は utils/codeGenerator と同じ C+YYMM-0001）。
UPDATE consignment_reports
   SET report_no = 'C' || substr(report_month, 3, 2) || substr(report_month, 6, 2) || '-' ||
                   substr('0000' || (
                     SELECT COUNT(*) FROM consignment_reports older
                      WHERE older.report_month = consignment_reports.report_month
                        AND older.id <= consignment_reports.id
                   ), -4)
 WHERE report_no IS NULL;
