-- 製品レシピマスタの「レシピID」（W300-0001 形式）。
--
-- シートは1行1レシピでIDを持っているが、こちらは列を落としていた。
-- 一括登録で同じ行を二重に入れないための照合キーになるので追加する。
ALTER TABLE product_recipes ADD COLUMN recipe_code TEXT;
CREATE UNIQUE INDEX ux_product_recipes_code ON product_recipes(recipe_code) WHERE recipe_code IS NOT NULL;
