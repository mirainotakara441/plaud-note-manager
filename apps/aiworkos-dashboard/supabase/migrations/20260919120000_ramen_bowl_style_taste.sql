-- =====================================================================
-- ラーメンの種別（形態・味）を手で上書きできる列を足す（2026-09-19）
-- =====================================================================
-- 「ジャンル別に何杯食べたか」を出すための列。
--
-- 種別は基本、メニュー欄・題名・本文からキーワードで自動判定する
-- （lib/ramenBowlType.ts）。形態は162杯すべて判定できたが、味・系統は
-- 本文に手がかりの無い杯が68あり自動では6割止まり（2026-09-19 実測）。
-- そこで、自動判定が違う／分からない杯は本人がカードから選べるようにし、
-- ここに入れる。値が入っていればこちらが勝ち、null なら自動判定を使う。
--
-- 値の語彙は lib/ramenBowlType.ts の BOWL_STYLES / BOWL_TASTES に1本化する
-- （DBの CHECK 制約にはしない。語彙を育てるたびに DDL を打たなくて済むように）。
--
-- rollback: ALTER TABLE public.ramen_logs DROP COLUMN bowl_style, DROP COLUMN bowl_taste;
ALTER TABLE public.ramen_logs
  ADD COLUMN IF NOT EXISTS bowl_style text,
  ADD COLUMN IF NOT EXISTS bowl_taste text;

COMMENT ON COLUMN public.ramen_logs.bowl_style IS
  '形態の手入力。ラーメン／つけ麺／まぜそば・油そば／冷やし／担々麺／ちゃんぽん。null なら本文からの自動判定を使う';
COMMENT ON COLUMN public.ramen_logs.bowl_taste IS
  '味・系統の手入力。醤油／塩／味噌／豚骨／煮干し・魚介／鶏／家系／二郎系／辛。null なら本文からの自動判定を使う';
