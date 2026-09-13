-- =====================================================================
-- 検索ログ（search_log）— W3「検索精度の底上げ」の最後の宿題「生成ログの記録」
-- =====================================================================
--
-- ■ 何のための表か
--   記憶層への検索（人が /search で引いたもの・AIが /ask の道具で引いたもの）を
--   1行ずつ残す。「何を探したか」「見つかったか（件数と上位の類似度）」が本体。
--
-- ■ なぜ要るか
--   2026-09-13 のハイブリッド昇格で痛感したこと——検索品質の判断には
--   **実際に投げられたクエリ**が要る。今回の Golden・Shadow のクエリセットは
--   手で発明したもので、次の改善（重み調整・チャンク切り直し）のときも
--   同じ発明を繰り返すことになる。ここに実クエリが溜まれば、
--   Golden は「実際の利用の写し」から作れるようになる。
--   さらに「探したのに見つからなかった」（件数0・類似度が低い）は
--   記憶層の穴そのものであり、夜間参謀の材料になる。
--
-- ■ 書かないもの
--   提案エージェントの成果物取得（fetchDeliverables 等）は書かない。
--   クエリが定型（「◯◯ 提案 論点 打ち手 骨子」）で分析価値が薄く、
--   夜間仕込みで量だけ積み上がるため。人の意図が乗った検索だけを残す。
--
-- ■ RLS: ポリシー無し（service_role のみ）。insights / ask_log と同じ扱い。
-- ■ rollback: DROP TABLE public.search_log;（読者はまだ居ない）
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.search_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- search = /search で人が引いた ／ ask = /ask の道具でAIが引いた
  source        text NOT NULL,
  query         text NOT NULL,
  -- source_type / organization / person / theme / match_count など、指定された絞りだけ
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_count  integer,
  -- 上位5件の {id, source_type, title, similarity}。後から「何が返ったか」を追うため
  top           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ms            integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.search_log
  ADD CONSTRAINT search_log_source_check CHECK (source IN ('search', 'ask'));

CREATE INDEX IF NOT EXISTS search_log_created_at_idx
  ON public.search_log (created_at DESC);

ALTER TABLE public.search_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.search_log IS
  '記憶層への検索ログ（W3の「生成ログの記録」）。人の/searchとAIの/ask道具のクエリ・件数・上位を残す。'
  '「探したのに見つからない」＝記憶層の穴の一次資料。書き込みは fire-and-forget（検索本体を止めない）。';
