-- 誤登録した受注を取り消せるようにする
--
-- 受注一覧に間違えた商品で登録された行を消す手段が無かった。
-- 一覧のボタンは「発送済にする」と「編集」だけ、APIにも削除が無く、
-- 編集では商品を変えられない（「登録し直してください」と書いてあるのに、
-- 間違った行を消す道が無い）。旧シート21枚にも受注の取消は無い。
--
-- ## なぜ物理削除にしないか
--
-- 1. **発送したことのある受注は、そもそも物理削除できない。**
--    product_stock_ledger.order_id が参照しており（PRAGMA foreign_keys = ON）、
--    **取消済みの出荷行も参照を持ち続ける**。消すには台帳を消すことになる
-- 2. **受注番号が再利用される。** 採番は既存の最大連番+1（utils/codeGenerator.js）。
--    その月の最後の受注を消すと、次の登録が同じ番号を取る
--
-- 行は残し、印と理由をつけて集計から外す。商品在庫変動履歴・資材在庫変動履歴・
-- 原料受払記録・浄酎容器変動履歴・蒸留明細と同じ4列・同じ作法にする。
--
-- 索引は作らない。実データは117行で、一覧も集計も全件走査で足りる。

ALTER TABLE orders ADD COLUMN is_cancelled  INTEGER NOT NULL DEFAULT 0;  -- 取消フラグ
ALTER TABLE orders ADD COLUMN cancel_reason TEXT;                        -- 取消理由（必須入力）
ALTER TABLE orders ADD COLUMN cancelled_at  TEXT;                        -- 取消日時
ALTER TABLE orders ADD COLUMN cancelled_by  INTEGER REFERENCES users(id);
