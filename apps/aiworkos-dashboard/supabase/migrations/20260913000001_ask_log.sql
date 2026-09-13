-- =====================================================================
-- 相談窓口（/ask）: ask_log テーブル
-- =====================================================================
--
-- ■ 何のための表か
--   /ask で吉井さんが投げた問いと、AIの答え・根拠・調べ方（ツールの足あと）・
--   役に立ったかの評価を残す。
--
-- ■ なぜ残すのか
--   2026-09-12 の総点検の指摘(F)「出したものの半分は流れて消える」を
--   相談窓口で繰り返さないため。加えて、溜まった問いそのものが
--   「吉井さんが何に悩んでいるか」の一次資料になる。夜間参謀の材料に
--   将来加える前提で、最初から構造化して置く。
--
-- ■ RLS
--   ポリシーは付けない（service_role のみ）。insights と同じ扱い。
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.ask_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question    text NOT NULL,
  answer      text NOT NULL,
  -- 答えの末尾に列挙させた根拠（文字列の配列）。検証の入口。
  sources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- AIが何をどう調べたか。{tool, input, resultChars, ms} の配列。
  -- 答えの質が落ちたとき、モデルのせいか調べ方のせいかをここで切り分ける。
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- helpful（役に立った）/ off（ずれてる）/ null（未評価）
  rating      text,
  model       text,
  ms          integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ask_log
  ADD CONSTRAINT ask_log_rating_check
  CHECK (rating IS NULL OR rating IN ('helpful', 'off'));

CREATE INDEX IF NOT EXISTS ask_log_created_at_idx
  ON public.ask_log (created_at DESC);

ALTER TABLE public.ask_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.ask_log IS
  '相談窓口(/ask)の問いと答えのログ。AIが記憶層をtool useで自分で引きながら回答した記録。'
  'steps に調べ方の足あと、rating に人の評価を残す。';
