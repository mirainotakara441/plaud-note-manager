-- =====================================================================
-- AI発信者ウォッチ: x_creator_accounts / x_creator_runs / x_creator_posts（2026-09-19）
-- =====================================================================
--
-- ■ 何のための表か
--   Xで生成AIの最新情報を発信している16名を、毎朝6時にMac上のClaude
--   （Chromeでログイン済み）が読み、直近24時間の投稿を要約して入れる。
--   /news の右カラム「AI発信者ウォッチ」カードと、専用ページ /news/creators が読む。
--
-- ■ 作りは X監視ダイジェスト（x_digest_runs / x_digest_items）と同じ
--   ・runs が1日1行の実行記録。statuses で発信者ごとの成否（ok/partial/blocked/error）を
--     持ち、posts が0件でも「取得できて0件」と「見られなかった」を区別できるようにする。
--   ・posts は runs に外部キーで従い、同じ日を取り直したら消してから入れ直す
--     （登録スクリプト x-creators-put.py 側の責任）。
--   ・違いは accounts 表があること。誰を見張るかをスクリプトにハードコードせず、
--     ここに1行足す・active を落とすだけで増減できるようにする。
--
-- ■ 数値の扱い
--   likes / reposts / replies は「取れなかった」を 0 ではなく null で持つ。
--   0 と混ぜると、ログインの壁で数字が読めなかった朝が「反応ゼロ」に見える。
--
-- ■ RLS
--   ポリシーは付けない（service_role からのみ）。x_digest_* と同じ扱い。
--   画面へは Next.js の API（app/api/news/creators）経由で出す。
--   本番にはイベントトリガ ensure_rls があり新規テーブルには自動でRLSが掛かるが、
--   このファイル単体で新規環境を再現できるように明示しておく。
--
-- rollback:
--   DROP TABLE public.x_creator_posts; DROP TABLE public.x_creator_runs;
--   DROP TABLE public.x_creator_accounts;
-- =====================================================================

-- ===== 1. 監視するアカウント =====
CREATE TABLE IF NOT EXISTS public.x_creator_accounts (
  -- @なし・小文字。URLとの突き合わせ・statuses のキーに使う
  handle        text PRIMARY KEY,
  display_name  text NOT NULL,
  url           text NOT NULL,
  -- 発信の性格。カードの並べ方・「今日いちばんの話題」の切り口に使う
  category      text NOT NULL,
  -- 何を主に発信しているか。1行
  focus         text,
  -- 分かるものだけ。増減を追う表ではないので手で更新する
  followers     integer,
  active        boolean NOT NULL DEFAULT true,
  added_on      date NOT NULL DEFAULT current_date,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT x_creator_accounts_category_check CHECK (
    category = ANY (ARRAY['速報'::text, '検証'::text, '図解'::text, 'ビジネス活用'::text, '経営者・VC'::text, '政治・行政'::text])
  )
);

-- ===== 2. 実行記録（1日1行） =====
CREATE TABLE IF NOT EXISTS public.x_creator_runs (
  digest_date   date PRIMARY KEY,
  collected_at  timestamptz NOT NULL DEFAULT now(),
  -- handle → ok / partial / blocked / error。アクティブな全員ぶん必ず入る
  statuses      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 今日の動向。1〜2文
  headline      text,
  -- 今日いちばん多かった話題。数行
  trend         text,
  -- 今日の学び（吉井さんのスキルアップ用）。数行
  lesson        text,
  -- 今日の「勝ち投稿」から学ぶ書き方。数行
  win_pattern   text,
  note          text
);

-- ===== 3. 投稿 =====
CREATE TABLE IF NOT EXISTS public.x_creator_posts (
  id            bigserial PRIMARY KEY,
  digest_date   date NOT NULL REFERENCES public.x_creator_runs(digest_date) ON DELETE CASCADE,
  handle        text NOT NULL REFERENCES public.x_creator_accounts(handle),
  -- handle ごとに 0,1,2… 。登録スクリプトが採番する
  sort_order    integer NOT NULL DEFAULT 0,
  -- 「3時間前」のような表示文字列でよい（Xの画面から正確な時刻は取りづらい）
  posted_at     text,
  -- 投稿本文。長ければ先頭400字
  body          text NOT NULL,
  -- 日本語の要旨1〜2文
  summary       text,
  url           text,
  -- 取れなければ null。0 と混ぜない
  likes         integer,
  reposts       integer,
  replies       integer,
  -- 投稿の型。速報 / 検証 / リスト / 図解 / 意見 / 実績 / 引用 / その他
  pattern       text,
  -- なぜ伸びたか・真似どころ。1〜2文
  why_it_works  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT x_creator_posts_digest_date_handle_sort_order_key UNIQUE (digest_date, handle, sort_order),
  CONSTRAINT x_creator_posts_pattern_check CHECK (
    pattern IS NULL OR pattern = ANY (ARRAY['速報'::text, '検証'::text, 'リスト'::text, '図解'::text, '意見'::text, '実績'::text, '引用'::text, 'その他'::text])
  )
);

-- カードは「その日のいいね数上位5件」を出す。日付で絞ってから likes で並べる
CREATE INDEX IF NOT EXISTS x_creator_posts_date_likes_idx
  ON public.x_creator_posts USING btree (digest_date DESC, likes DESC NULLS LAST);

-- ===== 4. RLS =====
ALTER TABLE public.x_creator_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_creator_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_creator_posts    ENABLE ROW LEVEL SECURITY;
-- anon にはポリシーを付けない（service role からのみ読み書き）

-- ===== 5. コメント =====
COMMENT ON TABLE public.x_creator_accounts IS 'AI発信者ウォッチで見張るXアカウント（16名）。handle は@なし小文字。誰を見張るかはスクリプトに書かずここで持ち、active を落とせば翌朝から外れる。';
COMMENT ON TABLE public.x_creator_runs IS 'AI発信者ウォッチの実行記録（1日1行）。statuses で発信者ごとの成否を持ち、posts が0件でも「取得できて0件」と言い切れるようにする。headline/trend/lesson/win_pattern はその日の総括。';
COMMENT ON TABLE public.x_creator_posts IS 'AI発信者ウォッチの中身（直近24時間の投稿）。likes/reposts/replies は取れなかったときは0ではなくnull。pattern は投稿の型、why_it_works は真似どころ。';
