-- DRAFT: not applied. rename with timestamp when approved
--   例: 202609XX000000_approval_queue.sql
--   適用前に production-change-protocol の関門（実データ確認→Shadow→テスト→本番→Golden→rollback）を通すこと。
-- =====================================================================
-- 承認キュー（approval queue）: approval_queue / approval_queue_events
-- 設計: docs/approval-queue-design.md
-- =====================================================================
--
-- ■ 何のための表か
--   AIが書いた「外へ出るもの」（Xの投稿・Facebookの投稿・note.comの下書き、
--   将来はメール・カレンダー）を、必ず 下書き → 人の承認（iPhone） → 投稿 の順に通すための
--   一本の関所。Claude Code のスキル・定期タスクは投稿せず、ここへ積むだけにする。
--
-- ■ なぜ表を分けるのか（integration_jobs に kind を足さない理由）
--   integration_jobs は「Macでしか実行できない取込を注文する」箱で、status は
--   queued/running/done/error の実行ライフサイクル。こちらは「人が承認したか」が主語で、
--   状態の意味が違う。同じ表に混ぜると「done＝投稿済み」なのか「done＝承認済み」なのかが
--   列の値だけでは読めなくなる。既存の kind CHECK 制約を触らずに済む利点もある。
--
-- ■ 本文は body（text）と body_json（jsonb）の二重持ち
--   body は画面に出す・人が編集する正本。body_json は投稿先が要る構造
--   （スレッド配列、メディア参照、引用元、URLの有無）を持つ。X の課金は本文にURLが
--   含まれるかで13倍変わる（$0.015 → $0.20）ので、cost_usd は積む時点で見積もって入れ、
--   投稿時に確定値で上書きする。
--
-- ■ RLS
--   ポリシーは付けない（service_role のみ）。insights / ask_log と同じ扱い。
--   下書きとはいえ外に出す前の文面と投稿先の識別子を持つので、anon には読ませない。
--   画面へは Next.js の API（合言葉cookie）経由で出す。
--   なお本番にはイベントトリガ ensure_rls があり、新規テーブルには自動でRLSが掛かる。
--   ここで明示するのは、このファイル単体で新規環境を再現できるようにするため。
--
-- ■ updated_at
--   baseline にある共通トリガ関数 public.set_updated_at() をそのまま使う
--   （health_metrics / salt2_members と同じ。関数を新しく書かない）。
--
-- rollback（適用前に書いておく。DBの他の表には一切触れていないので、これだけで戻る）:
--   DROP TABLE IF EXISTS public.approval_queue_events;
--   DROP TABLE IF EXISTS public.approval_queue;
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.approval_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 投稿先の種類。x_post / fb_post / note_draft / email / calendar
  --   email / calendar は v1 では受け付けるだけで、投稿（送信・登録）の実装は無い。
  --   承認後は fb_post と同じく「コピーして手動」で扱う。
  kind           text NOT NULL,

  -- 状態。draft / pending / approved / rejected / posted / failed
  --   draft    … スキルがまだ組み立て中（メディア添付待ち等）。画面には出さない
  --   pending  … 人の判断待ち。ホームのカードに出る
  --   approved … 承認済み。x_post は投稿待ち／投稿中、fb_post・note_draft は手動作業待ち
  --   rejected … 却下（終端。文面は残す。翌日の生成側が「何が却下されたか」を読める）
  --   posted   … 外に出た（終端）。external_id と post_result に証跡
  --   failed   … 投稿を試みて失敗。post_result に理由。人が approved へ戻して再試行する
  status         text NOT NULL DEFAULT 'pending',

  -- 一行の見出し。カードの1行目。X なら本文の先頭、note なら記事タイトル
  title          text NOT NULL,
  -- 本文の正本。人が画面で編集するのはここ
  body           text NOT NULL,
  -- 投稿先ごとの構造。例（x_post）:
  --   {"thread":["1本目","2本目"], "media":[{"bucket":"...","path":"..."}],
  --    "quote_tweet_id":null, "has_url":false, "weighted_len":238, "account":"sales_ai_lab"}
  -- 例（note_draft）: {"tags":["営業DX"], "eyecatch":null}
  body_json      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- どのスキル／エージェントが積んだか。例: x-sales-ai-lab-morning-draft / ramen-draft / manual
  source         text NOT NULL,
  -- 元になった記録の参照。例: insights:<uuid> / diary:2026-09-18 / ramen_logs:123 / x_digest:2026-09-18
  -- 外部キーにしないのは、参照先の表が複数あるため（表名:ID の文字列で持つ）
  source_ref     text,

  -- 予約投稿。null なら承認後すぐ。入っていれば cron がその時刻以降に投稿する
  scheduled_for  timestamptz,

  -- 人の判断。approved_by は単独運用なので端末や経路の識別で足りる
  -- （'iphone-card' / 'mac-card' / 'cli'）。将来の複数人運用で人名に変える
  approved_at    timestamptz,
  approved_by    text,
  rejected_at    timestamptz,
  reject_note    text,

  -- 投稿の結果
  posted_at      timestamptz,
  -- 投稿先の識別子。X なら tweet id（スレッドは先頭）。fb/note は手動なので人が貼るか null
  external_id    text,
  -- 投稿APIの応答や失敗理由をそのまま。{"tweet_ids":[...], "url":"...", "error":"..."}
  post_result    jsonb,
  -- X の見積もり／確定コスト（USD）。積む時点で本文のURL有無から見積もり、投稿時に確定
  cost_usd       numeric(8,4),

  -- 二重投稿防止の排他ロック。ramen_logs.x_post_lock と同じ考え方だが、
  -- 行の status 自体を 'approved' → 'posting' に変えず、別列で予約する
  -- （status は人が読む列。投稿処理中の一瞬の状態を status に混ぜると
  --  CHECK も画面も複雑になるため、ロックは専用列に閉じる）。
  --   NULL                       … ロック無し
  --   posting                    … 投稿処理中（cron / approve が原子的UPDATEで取る）
  --   post_failed_needs_review   … 投稿は成功したが書き戻しに失敗。二重投稿防止のため止めたまま残す
  post_lock      text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.approval_queue
  ADD CONSTRAINT approval_queue_kind_check
  CHECK (kind IN ('x_post', 'fb_post', 'note_draft', 'email', 'calendar'));

ALTER TABLE public.approval_queue
  ADD CONSTRAINT approval_queue_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'posted', 'failed'));

-- 投稿済みなら external_id か post_result のどちらかは必ずある
-- （「posted なのに何も証跡が無い」行を作らせない。ramen_logs の x_url 乖離の教訓）
ALTER TABLE public.approval_queue
  ADD CONSTRAINT approval_queue_posted_evidence_check
  CHECK (status <> 'posted' OR external_id IS NOT NULL OR post_result IS NOT NULL);

-- ホームのカードは「判断待ち」を新しい順に引く。cron は「承認済みで時刻が来たもの」を引く。
-- どちらも部分索引で小さく済む（終端状態の行は索引に入らない）。
CREATE INDEX IF NOT EXISTS approval_queue_pending_idx
  ON public.approval_queue (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS approval_queue_approved_sched_idx
  ON public.approval_queue (scheduled_for NULLS FIRST, approved_at)
  WHERE status = 'approved';

-- 月間コストの集計（kind='x_post' AND posted_at が今月）用
CREATE INDEX IF NOT EXISTS approval_queue_posted_at_idx
  ON public.approval_queue (posted_at DESC)
  WHERE status = 'posted';

-- 同じ元ネタから二重に積まない判定用（source + source_ref で引く）
CREATE INDEX IF NOT EXISTS approval_queue_source_ref_idx
  ON public.approval_queue (source, source_ref)
  WHERE source_ref IS NOT NULL;

ALTER TABLE public.approval_queue
  ADD CONSTRAINT approval_queue_post_lock_check
  CHECK (post_lock IS NULL OR post_lock IN ('posting', 'post_failed_needs_review'));

CREATE TRIGGER trg_approval_queue_updated_at
  BEFORE UPDATE ON public.approval_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.approval_queue ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.approval_queue IS
  'AIが書いた外向け文面（X/Facebook/note/メール/カレンダー）の承認キュー。'
  'スキルは積むだけ、人がiPhoneで承認、投稿は承認済みだけを cron/approve が行う。'
  '設計: docs/approval-queue-design.md';
COMMENT ON COLUMN public.approval_queue.kind IS
  'x_post / fb_post / note_draft / email / calendar。fb_post・note_draft・email・calendar は v1 では自動投稿しない（手動コピー／Playwright下書き）。';
COMMENT ON COLUMN public.approval_queue.status IS
  'draft / pending / approved / rejected / posted / failed。pending だけがホームのカードに出る。';
COMMENT ON COLUMN public.approval_queue.body_json IS
  '投稿先ごとの構造。x_post は {thread[], media[], quote_tweet_id, has_url, weighted_len, account}。';
COMMENT ON COLUMN public.approval_queue.source_ref IS
  '元ネタの参照。表名:ID の文字列（insights:<uuid> / ramen_logs:123 / x_digest:2026-09-18）。同じ元ネタからの二重起票を防ぐ判定に使う。';
COMMENT ON COLUMN public.approval_queue.cost_usd IS
  'X の課金見積もり／確定値（USD）。URL無し $0.015、URL有り $0.20。積む時に見積もり、posted で確定。';
COMMENT ON COLUMN public.approval_queue.post_lock IS
  '投稿の排他制御専用。NULL=ロック無し, posting=投稿処理中, post_failed_needs_review=投稿成功だが書き戻し失敗で要確認。status とは別物。';

-- ---------------------------------------------------------------------
-- 監査ログ approval_queue_events
--   「誰がいつ何を変えたか」を行の更新とは別に残す。approval_queue の行は
--   最新状態しか持たないので、承認後に編集して投稿した場合に
--   「承認した文面」と「実際に出た文面」が同じかを、ここでしか確かめられない。
--   外に出るものなので、この証跡は消さない（DELETE しない運用）。
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.approval_queue_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id    uuid NOT NULL REFERENCES public.approval_queue(id) ON DELETE CASCADE,
  -- created / submitted / edited / approved / rejected / posting / posted / failed / copied / retried
  --   copied … fb_post 等で「コピーして手動投稿」ボタンが押された（外に出た可能性の証跡）
  event       text NOT NULL,
  -- 誰が。'skill:x-sales-ai-lab-morning-draft' / 'iphone-card' / 'cron:approval-post' / 'cli'
  actor       text NOT NULL,
  -- 変更前後。edited なら {"before":{"body":...},"after":{"body":...}}、posted なら API 応答
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.approval_queue_events
  ADD CONSTRAINT approval_queue_events_event_check
  CHECK (event IN ('created', 'submitted', 'edited', 'approved', 'rejected',
                   'posting', 'posted', 'failed', 'copied', 'retried'));

CREATE INDEX IF NOT EXISTS approval_queue_events_queue_id_idx
  ON public.approval_queue_events (queue_id, created_at);

ALTER TABLE public.approval_queue_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.approval_queue_events IS
  'approval_queue の監査ログ。承認した文面と実際に出た文面の一致を後から確かめるために残す。消さない。';
