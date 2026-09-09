-- 蒸留記録に備考欄を足す。
--
-- 旧シートの蒸留記録に備考の列が無く、こちらにも無かった。
-- 「原酒を入れ間違えたので途中で足した」「加熱が弱かった」のような、
-- 数字にならない事情を書き残す場所が要る。
-- 投入内訳の自由記述（input_summary）は明細から組み直される（submitDistillationStart が
-- 明細をまとめて書き込む）ので、人が書いたものが消える。別の列にする。

ALTER TABLE distillations ADD COLUMN note TEXT;
