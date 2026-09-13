-- =====================================================================
-- 夜間参謀（Phase 1）: insights テーブル
-- 設計: docs/night-advisor-design.md
-- =====================================================================
--
-- ■ 何のための表か
--   毎晩の夜間参謀が出す「示唆」を、根拠と人の判断ごと残す。
--
--   既存の「毎朝の参謀」（lib/advisor/）は完全ルールベースで、出した気づきは
--   DBに残らず毎回その場で計算し直される（判断だけを advisor_finding_state に置く）。
--   そのため「先週から同じことを言い続けている」「前に言ったことが解決した」を
--   誰も——AIも人も——検証できなかった。ここはその逆をやる。本文ごと残す。
--
-- ■ なぜ本文を残すのか
--   翌晩の夜間参謀が、直近30日の insights を材料として読む。
--   過去に何を言ったかを読めるからこそ、同じ話を繰り返さずに済み、
--   「前回の示唆はどうなったか」を自分で判定できる。
--   ここが「AIが自分の提案の結果を知る」仕組みの入口になる。
--
-- ■ 記憶層には書き戻さない
--   示唆はこの表に閉じる。memory_chunks へ入れると検索結果にAIの仮説が混ざり、
--   次のAIがそれを事実として引く。Memory 2.0 の「書き込みは store-memory の
--   一本関所」という規律とも整合しない。
--
-- ■ RLS
--   ポリシーは付けない（service_role からのみ）。memory_chunks / proposal_cache と
--   同じ扱い。画面へは Next.js の API 経由で出す。
--   なお本番にはイベントトリガ ensure_rls があり、新規テーブルには自動でRLSが掛かる。
--   ここで明示するのは、このファイル単体で新規環境を再現できるようにするため。
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.insights (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- どの晩の分か（JST）。1晩に複数回走らせても同じ日付で並ぶ。
  generated_on  date NOT NULL,

  -- 改善 / 横断 / 異議 / 問い / 継続
  --   異議 … 吉井さんの現在の判断・進め方への反対の筋。毎晩1件は必ず出させる枠
  --   継続 … 過去の示唆で未解決のものの再掲。新規の件数には数えない
  kind          text NOT NULL,

  -- 一行。何が起きていそうか（原因の断定ではなく、仮説として書く）
  title         text NOT NULL,
  -- 本文。なぜそう言えるか
  body          text NOT NULL,

  -- 根拠。{source_type, title, event_date} の配列。
  -- 根拠の無い示唆は検証できず、検証できないものは信用されない。
  -- 断定は許すが「どの材料から言っているか」は必ず示させる。
  evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 関係する団体（あれば）。後で団体別に引けるように。
  related_orgs  text[] NOT NULL DEFAULT '{}'::text[],

  -- 継続の追跡。前の晩の示唆を引き継いだ場合、その id を指す。
  continues_id  uuid REFERENCES public.insights(id) ON DELETE SET NULL,

  -- 人の判断。ここが自己改善の燃料になる。
  --   adopted（採用） / deferred（見送り） / off_target（的外れ） / null（未判断）
  verdict       text,
  verdict_at    timestamptz,
  -- 「なぜ的外れか」を1行で。翌晩のプロンプトに差し込んで同じ間違いを繰り返させない。
  -- 的外れとだけ記録しても学習に還らないので、この欄が要る。
  verdict_note  text,

  -- 結果の追跡（Phase 3 で使う）。resolved / faded / null
  outcome       text,
  outcome_at    timestamptz,

  model         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.insights
  ADD CONSTRAINT insights_kind_check
  CHECK (kind IN ('改善', '横断', '異議', '問い', '継続'));

ALTER TABLE public.insights
  ADD CONSTRAINT insights_verdict_check
  CHECK (verdict IS NULL OR verdict IN ('adopted', 'deferred', 'off_target'));

ALTER TABLE public.insights
  ADD CONSTRAINT insights_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('resolved', 'faded'));

-- 画面は「その日の分」を引く。翌晩の参謀は「直近30日」を引く。どちらもこの索引で足りる。
CREATE INDEX IF NOT EXISTS insights_generated_on_idx
  ON public.insights (generated_on DESC);

-- 「まだ判断がついていないもの」を数える用（運用2週間後の成否判定に使う）。
CREATE INDEX IF NOT EXISTS insights_verdict_idx
  ON public.insights (verdict)
  WHERE verdict IS NULL;

ALTER TABLE public.insights ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.insights IS
  '夜間参謀が毎晩出す示唆。根拠(evidence)と人の判断(verdict)ごと残す。'
  '翌晩の参謀が直近30日ぶんを材料として読み、同じ話の繰り返しと解決済みを自分で判定する。'
  '設計: docs/night-advisor-design.md';
COMMENT ON COLUMN public.insights.kind IS
  '改善／横断／異議／問い／継続。異議は「吉井さんの判断への反対の筋」で毎晩1件の必須枠。';
COMMENT ON COLUMN public.insights.evidence IS
  '根拠。{source_type,title,event_date} の配列。空の示唆は出させない。';
COMMENT ON COLUMN public.insights.verdict_note IS
  '「なぜ的外れか」。翌晩のプロンプトへ差し込んで同じ間違いを繰り返させないために使う。';
COMMENT ON COLUMN public.insights.continues_id IS
  '前の晩の示唆を引き継いだ場合の元id。同じ話が何回再掲されたかを数えるのに使う。';
