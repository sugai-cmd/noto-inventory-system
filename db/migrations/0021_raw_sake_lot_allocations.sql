-- 原酒の受入ロットと、蒸留への払出を紐付ける
--
-- 瓶詰め→箱詰めは wip_lot_allocations で「どの瓶詰めロットの何本をどの箱詰めに
-- 使ったか」を持っている。原酒には同じものが無く、払出行は投入元タンクを持つだけで、
-- **そのタンクの中のどの受入ロットを使ったかは記録に無かった**
-- （lotTraceService が銘柄別に按分して推定しているだけ）。
--
-- 実データの原酒ポリは「空にしてから次を入れる」運用なので、古い順に引き当てれば
-- ほとんどが一意に決まる（払出79件のうち73件が受入ロット1件で決まる）。
--
-- **過去分の埋め込みはここではやらない。** FIFOの巻き戻しはループが要り、
-- .sql に書くと読めなくなる。画面のボタンから、実際の引き当てと同じ関数を呼ぶ
-- （提案が画面に出てから確定できるほうが、黙って当てるより安全）。

CREATE TABLE raw_sake_lot_allocations (
  id                INTEGER PRIMARY KEY,
  payout_ledger_id  INTEGER NOT NULL REFERENCES raw_sake_ledger(id),  -- 払出の行
  receipt_ledger_id INTEGER NOT NULL REFERENCES raw_sake_ledger(id),  -- 引当元の受入ロット
  quantity          REAL NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rsla_payout  ON raw_sake_lot_allocations(payout_ledger_id);
CREATE INDEX idx_rsla_receipt ON raw_sake_lot_allocations(receipt_ledger_id);
