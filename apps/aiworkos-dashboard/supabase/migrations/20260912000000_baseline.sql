-- =====================================================================
-- AIワークOS 本番スキーマ ベースライン（baseline migration）
-- 生成日: 2026-09-12
-- 対象: Supabase project_id = zuadqnarsoykplkafyxv / schema = public
-- =====================================================================
--
-- ■ これは何か
--   2026-09-12 時点の「本番Supabaseのスキーマをそのまま写し取った」ファイル。
--   データ（行の中身）は一切含まない。構造だけ。
--
-- ■ なぜ作ったか
--   これまで本番の全テーブル定義がどこにも版管理されていなかった。
--   本番だけが唯一の正であり、誰も差分を追えない状態だった。
--   このファイルを「起点（ゼロ地点）」として置くことで、
--   以後のスキーマ変更をGitの差分として追えるようにする。
--
-- ■ 注意（重要）
--   ・このファイルを本番に対して実行してはいけない。本番は既にこの状態。
--   ・用途は2つだけ:
--       (1) 新規環境（ローカル/ステージング）をゼロから再構築するとき
--       (2) 「今の本番は正しいか」を見るときの差分レビューの基準
--   ・以後のスキーマ変更は production-change-protocol スキルに従い、
--     このファイルを書き換えるのではなく、
--     supabase/migrations/ に新しいマイグレーションを追加すること。
--
-- ■ 収録順（依存関係の都合でこの順序を守ること）
--   1. 拡張機能  2. シーケンス  3. テーブル  4. 制約
--   5. インデックス  5-2. ビュー  6. 関数  6-2. トリガ
--   7. RLS/ポリシー  8. コメント
--
-- ■ 規模（2026-09-12 実測）
--   テーブル77 / 主キー・一意102 / CHECK37 / 外部キー12 / インデックス83
--   ビュー1 / 関数23 / トリガ9 / RLSポリシー51 / コメント83
--
-- =====================================================================


-- ===== 1. 拡張機能（EXTENSIONS） =====
-- plpgsql / supabase_vault は Supabase 既定のため省略。

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector      WITH SCHEMA extensions;  -- pgvector 0.8.2 / embedding vector(384)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net      WITH SCHEMA public;      -- 注: public に入っている（Supabase既定はextensions）
CREATE EXTENSION IF NOT EXISTS pg_cron;                             -- pg_catalog（定期ジョブ）


-- ===== 2. シーケンス（SEQUENCES） =====
-- GENERATED ALWAYS AS IDENTITY 由来のものは自動生成されるためここには書かない。
-- 明示的に nextval() を DEFAULT に持つテーブル用の serial シーケンスのみ。

CREATE SEQUENCE IF NOT EXISTS public.bunshin_logs_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.home_visit_logs_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.home_visit_members_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.salt2_members_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.x_digest_items_id_seq;


-- ===== 3. テーブル（TABLES） =====
-- public スキーマの通常テーブル（relkind='r'）全件。
-- 主キー・外部キー・CHECK は「4. 制約」でまとめて付与する。

CREATE TABLE IF NOT EXISTS public.advisor_finding_state (
  finding_id text NOT NULL,
  dismissed_at timestamp with time zone,
  due_date date,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.app_config (
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.bootcamp_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sprint text NOT NULL,
  phase text NOT NULL,
  topic text NOT NULL,
  source_content text,
  source_url text,
  notes text,
  decisions text,
  business_application text NOT NULL,
  qa_session jsonb,
  quiz jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.bunshin_logs (
  id bigint DEFAULT nextval('bunshin_logs_id_seq'::regclass) NOT NULL,
  member_name text NOT NULL,
  question text NOT NULL,
  answer text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.career_criteria (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  label text NOT NULL,
  description text,
  weight integer DEFAULT 3 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.career_emails (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  gmail_message_id text NOT NULL,
  gmail_thread_id text,
  sender text,
  sender_domain text,
  subject text,
  received_at timestamp with time zone,
  source text,
  kind text,
  snippet text,
  body_text text,
  processed_at timestamp with time zone,
  extract_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.career_ingest_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  trigger text,
  fetched integer DEFAULT 0 NOT NULL,
  new_emails integer DEFAULT 0 NOT NULL,
  new_jobs integer DEFAULT 0 NOT NULL,
  updated_jobs integer DEFAULT 0 NOT NULL,
  new_scouts integer DEFAULT 0 NOT NULL,
  scored integer DEFAULT 0 NOT NULL,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.career_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  dedup_key text NOT NULL,
  company text NOT NULL,
  title text NOT NULL,
  salary_min integer,
  salary_max integer,
  salary_text text,
  location text,
  employment_type text,
  industry text,
  description text,
  url text,
  source text,
  source_email_id uuid,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  seen_count integer DEFAULT 1 NOT NULL,
  status text DEFAULT 'new'::text NOT NULL,
  fit_score integer,
  fit_summary text,
  fit_pros jsonb,
  fit_cons jsonb,
  fit_model text,
  fit_scored_at timestamp with time zone,
  tags text[],
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.career_recruiters (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  dedup_key text NOT NULL,
  name text NOT NULL,
  company text,
  email text,
  source text,
  rank text,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.career_scouts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_email_id uuid,
  recruiter_id uuid,
  gmail_thread_id text,
  subject text,
  body_excerpt text,
  received_at timestamp with time zone,
  company text,
  position_title text,
  salary_text text,
  source text,
  reply_status text DEFAULT 'pending'::text NOT NULL,
  replied_at timestamp with time zone,
  deadline_at timestamp with time zone,
  resend_count integer DEFAULT 0 NOT NULL,
  dedup_key text,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.claude_usage_daily (
  work_date date NOT NULL,
  hours numeric NOT NULL,
  note text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.code_session_prefs (
  session_id text NOT NULL,
  hidden boolean DEFAULT false NOT NULL,
  pinned boolean,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.code_session_snapshots (
  snapshot_date date NOT NULL,
  session_id text NOT NULL,
  title text DEFAULT ''::text NOT NULL,
  cwd_label text DEFAULT ''::text NOT NULL,
  last_activity_at timestamp with time zone,
  days_idle numeric,
  is_pinned boolean DEFAULT false NOT NULL,
  is_archived boolean DEFAULT false NOT NULL,
  is_stalled boolean DEFAULT false NOT NULL,
  last_event text DEFAULT ''::text NOT NULL,
  captured_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.daily_actions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  entry_date date NOT NULL,
  kind text NOT NULL,
  content text NOT NULL,
  done boolean DEFAULT false NOT NULL,
  done_at timestamp with time zone,
  "position" integer DEFAULT 0 NOT NULL,
  source text DEFAULT 'diary'::text NOT NULL,
  source_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  due_date date
);

CREATE TABLE IF NOT EXISTS public.daily_work_log (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  work_date date NOT NULL,
  session_title text NOT NULL,
  session_id text,
  workstream text,
  summary jsonb DEFAULT '[]'::jsonb NOT NULL,
  deliverables jsonb DEFAULT '[]'::jsonb NOT NULL,
  status text DEFAULT 'in_progress'::text NOT NULL,
  next_action text,
  source text DEFAULT 'ccd_session'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.diary_import_log (
  source_id text NOT NULL,
  event_date date,
  item_count integer DEFAULT 0 NOT NULL,
  imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  doc_key text NOT NULL,
  source_type text NOT NULL,
  organization text,
  title text NOT NULL,
  content text NOT NULL,
  sections jsonb,
  event_date date,
  metadata jsonb,
  origin text DEFAULT 'restored'::text NOT NULL,
  chunk_count integer,
  restore_note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.dx_news (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  theme text DEFAULT '自治体DX'::text NOT NULL,
  title text NOT NULL,
  link text NOT NULL,
  source text,
  pub_date timestamp with time zone,
  fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.family_logs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  happened_on date NOT NULL,
  title text NOT NULL,
  place text,
  place_kind text,
  area text,
  members text[] DEFAULT '{}'::text[] NOT NULL,
  memo text,
  highlight text,
  stars smallint,
  cost integer,
  photo_paths text[] DEFAULT '{}'::text[] NOT NULL,
  photo_count integer GENERATED ALWAYS AS (cardinality(photo_paths)) STORED,
  status text DEFAULT 'logged'::text NOT NULL,
  source text DEFAULT 'web'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.glossary (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  term text NOT NULL,
  reading text NOT NULL,
  aliases text[] DEFAULT '{}'::text[] NOT NULL,
  category text DEFAULT 'AI'::text NOT NULL,
  short text NOT NULL,
  essence text NOT NULL,
  usage_note text,
  related text[] DEFAULT '{}'::text[] NOT NULL,
  source_sprint text,
  source_chapter text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.health_conditions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  start_day date NOT NULL,
  end_day date,
  title text NOT NULL,
  max_temp_c numeric,
  symptoms text[] DEFAULT '{}'::text[] NOT NULL,
  ruled_out text[] DEFAULT '{}'::text[] NOT NULL,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.health_goals (
  metric text NOT NULL,
  target numeric NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.health_metrics (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  day date NOT NULL,
  metric text NOT NULL,
  value numeric,
  unit text,
  source text DEFAULT 'unknown'::text NOT NULL,
  extra jsonb DEFAULT '{}'::jsonb NOT NULL,
  measured_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  user_id uuid
);

CREATE TABLE IF NOT EXISTS public.health_weekly_reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  week_start date NOT NULL,
  week_end date NOT NULL,
  ratings jsonb DEFAULT '{}'::jsonb NOT NULL,
  notes text,
  body text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  advice text
);

CREATE TABLE IF NOT EXISTS public.home_visit_logs (
  id bigint DEFAULT nextval('home_visit_logs_id_seq'::regclass) NOT NULL,
  member_id bigint NOT NULL,
  visit_date date NOT NULL,
  met boolean,
  topics text,
  next_action text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.home_visit_members (
  id bigint DEFAULT nextval('home_visit_members_id_seq'::regclass) NOT NULL,
  name text NOT NULL,
  division text DEFAULT '壮年部'::text NOT NULL,
  district text,
  block text,
  role text,
  birth_date date,
  age_manual integer,
  note text,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 999 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  address text
);

CREATE TABLE IF NOT EXISTS public.influence_edges (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_name text NOT NULL,
  from_person text NOT NULL,
  to_person text NOT NULL,
  relation text NOT NULL,
  note text,
  source_ref text,
  status text DEFAULT 'draft'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.integration_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  kind text NOT NULL,
  params jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'queued'::text NOT NULL,
  result text,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.job_heartbeats (
  job text NOT NULL,
  last_ok_at timestamp with time zone,
  note text,
  last_fail_at timestamp with time zone,
  last_exit_code integer,
  fail_note text
);

CREATE TABLE IF NOT EXISTS public.learning_logs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  learned_on date DEFAULT CURRENT_DATE NOT NULL,
  theme text NOT NULL,
  title text NOT NULL,
  insight text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  user_id uuid
);

CREATE TABLE IF NOT EXISTS public.lecture_archives (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  instructor text NOT NULL,
  title text NOT NULL,
  lecture_date date,
  platform text DEFAULT 'other'::text NOT NULL,
  url text,
  passcode text,
  material_url text,
  audio_url text,
  note text,
  insight text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.lecture_archives_backup_20260822 (
  id uuid,
  instructor text,
  title text,
  lecture_date date,
  platform text,
  url text,
  passcode text,
  material_url text,
  audio_url text,
  note text,
  insight text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.legislator_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name_key text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.legislators (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  municipality text NOT NULL,
  party text NOT NULL,
  name text NOT NULL,
  name_kana text,
  phone text,
  email text,
  party_site boolean,
  personal_site boolean,
  assembly_roster_label text,
  minutes_search_label text,
  contact_page_id text,
  memo text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.memory_chunks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_type text NOT NULL,
  source_id text,
  organization text,
  title text NOT NULL,
  content text NOT NULL,
  event_date date,
  metadata jsonb DEFAULT '{}'::jsonb,
  embedding vector(384),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  canonical_document_id text,
  source_document_id text,
  chunk_index integer,
  ingest_scheme text
);

CREATE TABLE IF NOT EXISTS public.memory_chunks_text_backup_20260804 (
  id uuid,
  organization text,
  title text,
  content text,
  backed_up_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.monthly_briefings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  month text NOT NULL,
  reported_on date,
  audience text NOT NULL,
  title text NOT NULL,
  summary text,
  feedback text,
  decisions text,
  homework text,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.monthly_reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  month text NOT NULL,
  kpi jsonb DEFAULT '{}'::jsonb NOT NULL,
  one_liner text,
  highlights jsonb DEFAULT '[]'::jsonb,
  handover jsonb DEFAULT '[]'::jsonb,
  signature text NOT NULL,
  notion_url text,
  model text,
  edited boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.news_themes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  theme text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  category text,
  subcategory text
);

CREATE TABLE IF NOT EXISTS public.notion_contacts (
  notion_page_id text NOT NULL,
  name text NOT NULL,
  org_page_id text,
  org_name text,
  department text,
  title text,
  status text,
  flag text,
  sources text[] DEFAULT '{}'::text[] NOT NULL,
  memo text,
  eight_registered_on date,
  last_verified_on date,
  notion_last_edited_at timestamp with time zone,
  synced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notion_organizations (
  notion_page_id text NOT NULL,
  name text NOT NULL,
  category text,
  raw_category text,
  status text,
  priority text,
  counterpart text,
  proposal text,
  issues text,
  next_action text,
  next_action_due date,
  last_contact_on date,
  visit_notes text,
  sources text[] DEFAULT '{}'::text[] NOT NULL,
  notion_last_edited_at timestamp with time zone,
  synced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.org_priority (
  org_name text NOT NULL,
  stars smallint NOT NULL,
  note text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.organization_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization text NOT NULL,
  section text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.partner_companies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  name_kana text,
  category text NOT NULL,
  website text,
  headquarters text,
  founded text,
  listing text,
  employees text,
  revenue text,
  business text,
  certifications text,
  values_summary text,
  values_quote text,
  values_source text,
  memo text,
  as_of date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  relationship text
);

CREATE TABLE IF NOT EXISTS public.partner_executives (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  name text NOT NULL,
  name_kana text,
  title text NOT NULL,
  career text,
  source_url text,
  sort_order integer DEFAULT 0 NOT NULL,
  memo text,
  as_of date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.partner_reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  summary text,
  body text NOT NULL,
  companies text[] DEFAULT '{}'::text[] NOT NULL,
  artifact_url text,
  reported_on date DEFAULT CURRENT_DATE NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.procedure_refine_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.procedure_refine_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  theme text NOT NULL,
  organization text,
  category text,
  purpose text,
  template_id text DEFAULT 'reason-municipal'::text,
  period text,
  items jsonb DEFAULT '[]'::jsonb,
  open_items jsonb DEFAULT '[]'::jsonb,
  constraints text,
  title text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  base_doc text,
  base_doc_name text
);

CREATE TABLE IF NOT EXISTS public.proposal_cache (
  organization text NOT NULL,
  signature text NOT NULL,
  proposal jsonb NOT NULL,
  meetings jsonb NOT NULL,
  model text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  edited boolean DEFAULT false NOT NULL,
  edited_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ramen_hall_of_fame (
  shop text NOT NULL,
  inducted_month text,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ramen_logs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  eaten_on date NOT NULL,
  bowl_no integer,
  bowl_label text,
  shop text NOT NULL,
  area text,
  genre text,
  visit_count integer,
  menu text,
  price integer,
  score numeric(3,1),
  score_time text,
  score_food numeric(3,1),
  score_service numeric(3,1),
  score_mood numeric(3,1),
  score_cp numeric(3,1),
  title text,
  excerpt text,
  photo_count integer DEFAULT 0 NOT NULL,
  tabelog_url text,
  tabelog_shop_url text,
  x_url text,
  x_posted_on date,
  x_excerpt text,
  is_ramen boolean DEFAULT true NOT NULL,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'posted'::text NOT NULL,
  source text DEFAULT 'import'::text NOT NULL,
  memo text,
  photo_urls text[] DEFAULT '{}'::text[] NOT NULL,
  draft_tabelog text,
  draft_x text,
  drafted_at timestamp with time zone,
  tabelog_posted_at timestamp with time zone,
  x_posted_at timestamp with time zone,
  stars numeric(2,1),
  date_precision text DEFAULT 'day'::text NOT NULL,
  tabelog_review_id text,
  stars_label text,
  x_post_lock text
);

CREATE TABLE IF NOT EXISTS public.ramen_monthly_posts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  month text NOT NULL,
  kind text NOT NULL,
  x_url text,
  posted_on date,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ramen_shop_accounts (
  shop text NOT NULL,
  official_handle text,
  owner_handle text,
  group_handle text,
  followers_hint integer,
  status text DEFAULT '未調査'::text NOT NULL,
  note text,
  checked_on date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.refine_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.refine_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization text NOT NULL,
  category text DEFAULT '自治体'::text NOT NULL,
  title text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  theme text,
  closed_at timestamp with time zone,
  base_doc text,
  base_doc_name text
);

CREATE TABLE IF NOT EXISTS public.retrospective_sections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  retrospective_id uuid NOT NULL,
  category text NOT NULL,
  rating smallint,
  body text,
  items jsonb DEFAULT '[]'::jsonb NOT NULL,
  "position" smallint DEFAULT 0 NOT NULL,
  assessment text,
  impact text
);

CREATE TABLE IF NOT EXISTS public.retrospectives (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  period_type text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  title text,
  one_liner text,
  insights jsonb DEFAULT '[]'::jsonb NOT NULL,
  next_plans jsonb DEFAULT '[]'::jsonb NOT NULL,
  notion_page_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  action_guideline text
);

CREATE TABLE IF NOT EXISTS public.salt2_members (
  id bigint DEFAULT nextval('salt2_members_id_seq'::regclass) NOT NULL,
  name text NOT NULL,
  kana text,
  slack_display text NOT NULL,
  email text,
  company text,
  role text,
  career text,
  ai_usage text,
  goal text,
  hobbies text[] DEFAULT '{}'::text[] NOT NULL,
  personal text,
  note text,
  track text,
  tags text[] DEFAULT '{}'::text[] NOT NULL,
  posted_at timestamp with time zone,
  source text DEFAULT 'slack:#0402_自己紹介'::text NOT NULL,
  search_text text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  industry_tags text[] DEFAULT '{}'::text[] NOT NULL,
  stance_tags text[] DEFAULT '{}'::text[] NOT NULL,
  hobby_tags text[] DEFAULT '{}'::text[] NOT NULL,
  raw_intro text,
  team text,
  linkedin text,
  x_url text,
  note_url text,
  facebook text,
  sns_other text,
  sns_confidence text
);

CREATE TABLE IF NOT EXISTS public.salt2_qa_log (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  message_ts text NOT NULL,
  thread_ts text,
  user_name text,
  user_id text,
  text text NOT NULL,
  permalink text,
  posted_at timestamp with time zone,
  synced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.service_health (
  service text NOT NULL,
  label text NOT NULL,
  last_ok_at timestamp with time zone,
  last_note text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.slide_refine_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.slide_refine_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  theme text NOT NULL,
  organization text,
  category text,
  title text,
  slides jsonb DEFAULT '[]'::jsonb,
  visuals jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  purpose text,
  visual_candidates jsonb DEFAULT '[]'::jsonb,
  constraints text,
  template_id text DEFAULT 'conclusion-evidence-action'::text
);

CREATE TABLE IF NOT EXISTS public.stakeholders_retired_20260730 (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  category text NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.strategic_todos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  notion_page_id text,
  task_name text NOT NULL,
  genre text NOT NULL,
  status text DEFAULT '未着手'::text NOT NULL,
  target_month text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  due_date date
);

CREATE TABLE IF NOT EXISTS public.transcription_dictionary (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  wrong text NOT NULL,
  correct text NOT NULL,
  category text DEFAULT 'その他'::text NOT NULL,
  note text,
  enabled boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.typo_candidates (
  kind text NOT NULL,
  wrong text NOT NULL,
  suggested text NOT NULL,
  hits integer NOT NULL,
  sample text,
  detected_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.typo_ignores (
  word text NOT NULL,
  reason text NOT NULL,
  decided_on date DEFAULT CURRENT_DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS public.weapon_proposal_sections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  "position" integer NOT NULL,
  section text NOT NULL,
  guidance text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.weekly_focus (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  week_start date NOT NULL,
  "position" smallint NOT NULL,
  content text NOT NULL,
  done boolean DEFAULT false NOT NULL,
  done_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  week_start date NOT NULL,
  category text NOT NULL,
  organization text,
  summary text,
  insight text,
  tactic text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.weekly_work_minutes (
  week_start date NOT NULL,
  minutes integer NOT NULL,
  sessions integer DEFAULT 0 NOT NULL,
  active_days integer DEFAULT 0 NOT NULL,
  by_workstream jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.x_digest_items (
  id bigint DEFAULT nextval('x_digest_items_id_seq'::regclass) NOT NULL,
  digest_date date NOT NULL,
  section text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  label text NOT NULL,
  metric integer,
  summary text,
  original text,
  url text,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.x_digest_runs (
  digest_date date NOT NULL,
  collected_at timestamp with time zone DEFAULT now() NOT NULL,
  statuses jsonb DEFAULT '{}'::jsonb NOT NULL,
  note text
);

CREATE TABLE IF NOT EXISTS public.x_follower_snapshots (
  snapshot_date date NOT NULL,
  followers_count integer NOT NULL,
  following_count integer NOT NULL,
  tweet_count integer NOT NULL,
  like_count integer NOT NULL,
  media_count integer NOT NULL,
  captured_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.x_monthly_posts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  month text NOT NULL,
  kind text NOT NULL,
  tweet_id text NOT NULL,
  url text NOT NULL,
  posted_at date,
  title text,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.x_post_metrics (
  post_id text NOT NULL,
  posted_at timestamp with time zone,
  post_text text,
  post_url text,
  impressions integer,
  likes integer,
  reposts integer,
  replies integer,
  quotes integer,
  bookmarks integer,
  shares integer,
  profile_clicks integer,
  url_clicks integer,
  detail_expands integer,
  media_views integer,
  engagements integer,
  new_follows integer,
  raw jsonb,
  source_file text,
  imported_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- シーケンスの所有者を紐づけ（テーブル削除時にシーケンスも消えるように）
ALTER SEQUENCE public.bunshin_logs_id_seq       OWNED BY public.bunshin_logs.id;
ALTER SEQUENCE public.home_visit_logs_id_seq    OWNED BY public.home_visit_logs.id;
ALTER SEQUENCE public.home_visit_members_id_seq OWNED BY public.home_visit_members.id;
ALTER SEQUENCE public.salt2_members_id_seq      OWNED BY public.salt2_members.id;
ALTER SEQUENCE public.x_digest_items_id_seq     OWNED BY public.x_digest_items.id;


-- ===== 4. 制約（CONSTRAINTS） =====

-- --- 4-1. 主キー / 一意制約（PRIMARY KEY / UNIQUE） ---

ALTER TABLE public.advisor_finding_state ADD CONSTRAINT advisor_finding_state_pkey PRIMARY KEY (finding_id);
ALTER TABLE public.app_config ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);
ALTER TABLE public.bootcamp_logs ADD CONSTRAINT bootcamp_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.bunshin_logs ADD CONSTRAINT bunshin_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.career_criteria ADD CONSTRAINT career_criteria_pkey PRIMARY KEY (id);
ALTER TABLE public.career_criteria ADD CONSTRAINT career_criteria_label_key UNIQUE (label);
ALTER TABLE public.career_emails ADD CONSTRAINT career_emails_pkey PRIMARY KEY (id);
ALTER TABLE public.career_emails ADD CONSTRAINT career_emails_gmail_message_id_key UNIQUE (gmail_message_id);
ALTER TABLE public.career_ingest_runs ADD CONSTRAINT career_ingest_runs_pkey PRIMARY KEY (id);
ALTER TABLE public.career_jobs ADD CONSTRAINT career_jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.career_jobs ADD CONSTRAINT career_jobs_dedup_key_key UNIQUE (dedup_key);
ALTER TABLE public.career_recruiters ADD CONSTRAINT career_recruiters_pkey PRIMARY KEY (id);
ALTER TABLE public.career_recruiters ADD CONSTRAINT career_recruiters_dedup_key_key UNIQUE (dedup_key);
ALTER TABLE public.career_scouts ADD CONSTRAINT career_scouts_pkey PRIMARY KEY (id);
ALTER TABLE public.career_scouts ADD CONSTRAINT career_scouts_dedup_key_key UNIQUE (dedup_key);
ALTER TABLE public.claude_usage_daily ADD CONSTRAINT claude_usage_daily_pkey PRIMARY KEY (work_date);
ALTER TABLE public.code_session_prefs ADD CONSTRAINT code_session_prefs_pkey PRIMARY KEY (session_id);
ALTER TABLE public.code_session_snapshots ADD CONSTRAINT code_session_snapshots_pkey PRIMARY KEY (snapshot_date, session_id);
ALTER TABLE public.daily_actions ADD CONSTRAINT daily_actions_pkey PRIMARY KEY (id);
ALTER TABLE public.daily_work_log ADD CONSTRAINT daily_work_log_pkey PRIMARY KEY (id);
ALTER TABLE public.daily_work_log ADD CONSTRAINT daily_work_log_date_session_uniq UNIQUE (work_date, session_id);
ALTER TABLE public.diary_import_log ADD CONSTRAINT diary_import_log_pkey PRIMARY KEY (source_id);
ALTER TABLE public.documents ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
ALTER TABLE public.documents ADD CONSTRAINT documents_doc_key_key UNIQUE (doc_key);
ALTER TABLE public.dx_news ADD CONSTRAINT dx_news_pkey PRIMARY KEY (id);
ALTER TABLE public.dx_news ADD CONSTRAINT dx_news_link_key UNIQUE (link);
ALTER TABLE public.family_logs ADD CONSTRAINT family_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.glossary ADD CONSTRAINT glossary_pkey PRIMARY KEY (id);
ALTER TABLE public.health_conditions ADD CONSTRAINT health_conditions_pkey PRIMARY KEY (id);
ALTER TABLE public.health_goals ADD CONSTRAINT health_goals_pkey PRIMARY KEY (metric);
ALTER TABLE public.health_metrics ADD CONSTRAINT health_metrics_pkey PRIMARY KEY (id);
ALTER TABLE public.health_metrics ADD CONSTRAINT health_metrics_metric_day_source_key UNIQUE (metric, day, source);
ALTER TABLE public.health_weekly_reports ADD CONSTRAINT health_weekly_reports_pkey PRIMARY KEY (id);
ALTER TABLE public.health_weekly_reports ADD CONSTRAINT health_weekly_reports_week_start_key UNIQUE (week_start);
ALTER TABLE public.home_visit_logs ADD CONSTRAINT home_visit_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.home_visit_members ADD CONSTRAINT home_visit_members_pkey PRIMARY KEY (id);
ALTER TABLE public.influence_edges ADD CONSTRAINT influence_edges_pkey PRIMARY KEY (id);
ALTER TABLE public.integration_jobs ADD CONSTRAINT integration_jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.job_heartbeats ADD CONSTRAINT job_heartbeats_pkey PRIMARY KEY (job);
ALTER TABLE public.learning_logs ADD CONSTRAINT learning_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.lecture_archives ADD CONSTRAINT lecture_archives_pkey PRIMARY KEY (id);
ALTER TABLE public.legislator_notes ADD CONSTRAINT legislator_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.legislator_notes ADD CONSTRAINT legislator_notes_name_key_key UNIQUE (name_key);
ALTER TABLE public.legislators ADD CONSTRAINT legislators_pkey PRIMARY KEY (id);
ALTER TABLE public.legislators ADD CONSTRAINT legislators_municipality_name_key UNIQUE (municipality, name);
ALTER TABLE public.memory_chunks ADD CONSTRAINT memory_chunks_pkey PRIMARY KEY (id);
ALTER TABLE public.monthly_briefings ADD CONSTRAINT monthly_briefings_pkey PRIMARY KEY (id);
ALTER TABLE public.monthly_reports ADD CONSTRAINT monthly_reports_pkey PRIMARY KEY (id);
ALTER TABLE public.monthly_reports ADD CONSTRAINT monthly_reports_month_key UNIQUE (month);
ALTER TABLE public.news_themes ADD CONSTRAINT news_themes_pkey PRIMARY KEY (id);
ALTER TABLE public.news_themes ADD CONSTRAINT news_themes_theme_key UNIQUE (theme);
ALTER TABLE public.notion_contacts ADD CONSTRAINT notion_contacts_pkey PRIMARY KEY (notion_page_id);
ALTER TABLE public.notion_organizations ADD CONSTRAINT notion_organizations_pkey PRIMARY KEY (notion_page_id);
ALTER TABLE public.org_priority ADD CONSTRAINT org_priority_pkey PRIMARY KEY (org_name);
ALTER TABLE public.organization_notes ADD CONSTRAINT organization_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.organization_notes ADD CONSTRAINT organization_notes_organization_section_key UNIQUE (organization, section);
ALTER TABLE public.partner_companies ADD CONSTRAINT partner_companies_pkey PRIMARY KEY (id);
ALTER TABLE public.partner_companies ADD CONSTRAINT partner_companies_name_key UNIQUE (name);
ALTER TABLE public.partner_executives ADD CONSTRAINT partner_executives_pkey PRIMARY KEY (id);
ALTER TABLE public.partner_reports ADD CONSTRAINT partner_reports_pkey PRIMARY KEY (id);
ALTER TABLE public.procedure_refine_messages ADD CONSTRAINT procedure_refine_messages_pkey PRIMARY KEY (id);
ALTER TABLE public.procedure_refine_sessions ADD CONSTRAINT procedure_refine_sessions_pkey PRIMARY KEY (id);
ALTER TABLE public.proposal_cache ADD CONSTRAINT proposal_cache_pkey PRIMARY KEY (organization);
ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
ALTER TABLE public.ramen_hall_of_fame ADD CONSTRAINT ramen_hall_of_fame_pkey PRIMARY KEY (shop);
ALTER TABLE public.ramen_logs ADD CONSTRAINT ramen_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.ramen_monthly_posts ADD CONSTRAINT ramen_monthly_posts_pkey PRIMARY KEY (id);
ALTER TABLE public.ramen_monthly_posts ADD CONSTRAINT ramen_monthly_posts_month_kind_key UNIQUE (month, kind);
ALTER TABLE public.ramen_shop_accounts ADD CONSTRAINT ramen_shop_accounts_pkey PRIMARY KEY (shop);
ALTER TABLE public.refine_messages ADD CONSTRAINT refine_messages_pkey PRIMARY KEY (id);
ALTER TABLE public.refine_sessions ADD CONSTRAINT refine_sessions_pkey PRIMARY KEY (id);
ALTER TABLE public.retrospective_sections ADD CONSTRAINT retrospective_sections_pkey PRIMARY KEY (id);
ALTER TABLE public.retrospective_sections ADD CONSTRAINT retrospective_sections_retrospective_id_category_key UNIQUE (retrospective_id, category);
ALTER TABLE public.retrospectives ADD CONSTRAINT retrospectives_pkey PRIMARY KEY (id);
ALTER TABLE public.retrospectives ADD CONSTRAINT retrospectives_period_type_period_start_key UNIQUE (period_type, period_start);
ALTER TABLE public.salt2_members ADD CONSTRAINT salt2_members_pkey PRIMARY KEY (id);
ALTER TABLE public.salt2_qa_log ADD CONSTRAINT salt2_qa_log_pkey PRIMARY KEY (id);
ALTER TABLE public.salt2_qa_log ADD CONSTRAINT salt2_qa_log_channel_id_message_ts_key UNIQUE (channel_id, message_ts);
ALTER TABLE public.service_health ADD CONSTRAINT service_health_pkey PRIMARY KEY (service);
ALTER TABLE public.slide_refine_messages ADD CONSTRAINT slide_refine_messages_pkey PRIMARY KEY (id);
ALTER TABLE public.slide_refine_sessions ADD CONSTRAINT slide_refine_sessions_pkey PRIMARY KEY (id);
ALTER TABLE public.stakeholders_retired_20260730 ADD CONSTRAINT stakeholders_pkey PRIMARY KEY (id);
ALTER TABLE public.stakeholders_retired_20260730 ADD CONSTRAINT stakeholders_category_name_key UNIQUE (category, name);
ALTER TABLE public.strategic_todos ADD CONSTRAINT strategic_todos_pkey PRIMARY KEY (id);
ALTER TABLE public.strategic_todos ADD CONSTRAINT strategic_todos_notion_page_id_key UNIQUE (notion_page_id);
ALTER TABLE public.transcription_dictionary ADD CONSTRAINT transcription_dictionary_pkey PRIMARY KEY (id);
ALTER TABLE public.transcription_dictionary ADD CONSTRAINT transcription_dictionary_wrong_key UNIQUE (wrong);
ALTER TABLE public.typo_candidates ADD CONSTRAINT typo_candidates_pkey PRIMARY KEY (kind, wrong);
ALTER TABLE public.typo_ignores ADD CONSTRAINT typo_ignores_pkey PRIMARY KEY (word);
ALTER TABLE public.weapon_proposal_sections ADD CONSTRAINT weapon_proposal_sections_pkey PRIMARY KEY (id);
ALTER TABLE public.weekly_focus ADD CONSTRAINT weekly_focus_pkey PRIMARY KEY (id);
ALTER TABLE public.weekly_focus ADD CONSTRAINT weekly_focus_week_start_position_key UNIQUE (week_start, "position");
ALTER TABLE public.weekly_reports ADD CONSTRAINT weekly_reports_pkey PRIMARY KEY (id);
ALTER TABLE public.weekly_work_minutes ADD CONSTRAINT weekly_work_minutes_pkey PRIMARY KEY (week_start);
ALTER TABLE public.x_digest_items ADD CONSTRAINT x_digest_items_pkey PRIMARY KEY (id);
ALTER TABLE public.x_digest_items ADD CONSTRAINT x_digest_items_digest_date_section_sort_order_key UNIQUE (digest_date, section, sort_order);
ALTER TABLE public.x_digest_runs ADD CONSTRAINT x_digest_runs_pkey PRIMARY KEY (digest_date);
ALTER TABLE public.x_follower_snapshots ADD CONSTRAINT x_follower_snapshots_pkey PRIMARY KEY (snapshot_date);
ALTER TABLE public.x_monthly_posts ADD CONSTRAINT x_monthly_posts_pkey PRIMARY KEY (id);
ALTER TABLE public.x_monthly_posts ADD CONSTRAINT x_monthly_posts_month_kind_key UNIQUE (month, kind);
ALTER TABLE public.x_post_metrics ADD CONSTRAINT x_post_metrics_pkey PRIMARY KEY (post_id);

-- --- 4-2. CHECK 制約 ---
-- 取りうる値（ドメイン）の定義がここに集まっている。アプリ側の enum と必ず一致させること。

ALTER TABLE public.daily_actions ADD CONSTRAINT daily_actions_kind_check CHECK ((kind = ANY (ARRAY['action'::text, 'point'::text])));
ALTER TABLE public.daily_actions ADD CONSTRAINT daily_actions_source_check CHECK ((source = ANY (ARRAY['diary'::text, 'manual'::text, 'weekly_report'::text, 'reminders'::text])));
ALTER TABLE public.daily_work_log ADD CONSTRAINT daily_work_log_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'follow_up'::text, 'in_progress'::text, 'blocked'::text])));
ALTER TABLE public.family_logs ADD CONSTRAINT family_logs_stars_check CHECK (((stars >= 1) AND (stars <= 5)));
ALTER TABLE public.health_conditions ADD CONSTRAINT health_conditions_period_ok CHECK (((end_day IS NULL) OR (end_day >= start_day)));
ALTER TABLE public.health_goals ADD CONSTRAINT health_goals_metric_check CHECK ((metric = ANY (ARRAY['weight_kg'::text, 'body_fat_pct'::text, 'steps'::text, 'kcal'::text])));
ALTER TABLE public.influence_edges ADD CONSTRAINT influence_edges_relation_check CHECK ((relation = ANY (ARRAY['上司'::text, '部下'::text, '後任'::text, '前任'::text, '推薦'::text, '紹介'::text, '同席'::text, '慎重派'::text, '決裁'::text])));
ALTER TABLE public.influence_edges ADD CONSTRAINT influence_edges_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'confirmed'::text])));
ALTER TABLE public.integration_jobs ADD CONSTRAINT integration_jobs_kind_check CHECK ((kind = ANY (ARRAY['eight'::text, 'plaud'::text, 'slides'::text, 'proposal'::text])));
ALTER TABLE public.integration_jobs ADD CONSTRAINT integration_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'error'::text])));
ALTER TABLE public.lecture_archives ADD CONSTRAINT lecture_archives_platform_check CHECK ((platform = ANY (ARRAY['youtube'::text, 'zoom'::text, 'vimeo'::text, 'other'::text])));
ALTER TABLE public.memory_chunks ADD CONSTRAINT memory_chunks_source_type_check CHECK ((source_type = ANY (ARRAY['会議'::text, '日記'::text, '学び'::text, 'PDF'::text, 'その他'::text, '成果物'::text, '学会'::text, '振り返り'::text, '月次報告'::text, '週報'::text])));
ALTER TABLE public.monthly_briefings ADD CONSTRAINT monthly_briefings_month_format CHECK ((month ~ '^\d{4}-\d{2}$'::text));
ALTER TABLE public.org_priority ADD CONSTRAINT org_priority_stars_check CHECK (((stars >= 1) AND (stars <= 3)));
ALTER TABLE public.organization_notes ADD CONSTRAINT organization_notes_section_check CHECK ((section = ANY (ARRAY['現状'::text, '課題'::text, '施策'::text, '基礎データ'::text])));
ALTER TABLE public.partner_companies ADD CONSTRAINT partner_companies_category_check CHECK ((category = ANY (ARRAY['委託会社'::text, '事業者'::text])));
ALTER TABLE public.procedure_refine_messages ADD CONSTRAINT procedure_refine_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])));
ALTER TABLE public.ramen_logs ADD CONSTRAINT ramen_logs_date_precision_check CHECK ((date_precision = ANY (ARRAY['day'::text, 'month'::text])));
ALTER TABLE public.ramen_logs ADD CONSTRAINT ramen_logs_score_time_check CHECK ((score_time = ANY (ARRAY['昼'::text, '夜'::text])));
ALTER TABLE public.ramen_logs ADD CONSTRAINT ramen_logs_source_check CHECK ((source = ANY (ARRAY['import'::text, 'shortcut'::text, 'web'::text])));
ALTER TABLE public.ramen_logs ADD CONSTRAINT ramen_logs_stars_check CHECK (((stars IS NULL) OR ((stars >= 0.5) AND (stars <= (5)::numeric))));
ALTER TABLE public.ramen_logs ADD CONSTRAINT ramen_logs_status_check CHECK ((status = ANY (ARRAY['captured'::text, 'drafted'::text, 'posted'::text])));
ALTER TABLE public.ramen_monthly_posts ADD CONSTRAINT ramen_monthly_posts_kind_check CHECK ((kind = ANY (ARRAY['summary'::text, 'feature'::text, 'awards'::text, 'memories'::text])));
ALTER TABLE public.refine_messages ADD CONSTRAINT refine_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])));
ALTER TABLE public.retrospective_sections ADD CONSTRAINT retrospective_sections_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE public.retrospectives ADD CONSTRAINT retrospectives_period_type_check CHECK ((period_type = ANY (ARRAY['週次'::text, '月次'::text])));
ALTER TABLE public.slide_refine_messages ADD CONSTRAINT slide_refine_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])));
ALTER TABLE public.slide_refine_sessions ADD CONSTRAINT slide_refine_sessions_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['自治体'::text, '事業者'::text, '銀行'::text, '議員'::text, '委託会社'::text, 'その他'::text]))));
ALTER TABLE public.stakeholders_retired_20260730 ADD CONSTRAINT stakeholders_category_check CHECK ((category = ANY (ARRAY['自治体'::text, '事業者'::text, '委託会社'::text, '銀行'::text, '議員'::text, '官民連携'::text, '社内'::text, 'その他'::text])));
ALTER TABLE public.strategic_todos ADD CONSTRAINT strategic_todos_genre_check CHECK ((genre = ANY (ARRAY['自治体'::text, '事業者'::text, '委託会社'::text, '銀行'::text, '議員'::text, '官民連携'::text, '社内'::text, 'その他'::text])));
ALTER TABLE public.strategic_todos ADD CONSTRAINT strategic_todos_status_check CHECK ((status = ANY (ARRAY['未着手'::text, '進行中'::text, '完了'::text])));
ALTER TABLE public.transcription_dictionary ADD CONSTRAINT dictionary_not_identity CHECK ((wrong <> correct));
ALTER TABLE public.transcription_dictionary ADD CONSTRAINT transcription_dictionary_category_check CHECK ((category = ANY (ARRAY['人名'::text, '団体名'::text, '用語'::text, '製品・サービス'::text, '場所'::text, 'その他'::text])));
ALTER TABLE public.weekly_focus ADD CONSTRAINT weekly_focus_position_check CHECK ((("position" >= 1) AND ("position" <= 5)));
ALTER TABLE public.weekly_reports ADD CONSTRAINT weekly_reports_category_check CHECK ((category = ANY (ARRAY['全体'::text, '支店'::text, '自治体'::text, '事業者'::text, '議員'::text, '委託会社'::text, '銀行'::text, 'プロモーション'::text])));
ALTER TABLE public.x_digest_items ADD CONSTRAINT x_digest_items_section_check CHECK ((section = ANY (ARRAY['keyword'::text, 'manus'::text, 'takano'::text])));
ALTER TABLE public.x_monthly_posts ADD CONSTRAINT x_monthly_posts_kind_check CHECK ((kind = ANY (ARRAY['summary'::text, 'feature'::text, 'awards'::text])));

-- --- 4-3. 外部キー（FOREIGN KEY） ---
-- テーブルを全部作り終えてからまとめて付ける。

ALTER TABLE public.career_jobs ADD CONSTRAINT career_jobs_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.career_emails(id) ON DELETE SET NULL;
ALTER TABLE public.career_scouts ADD CONSTRAINT career_scouts_recruiter_id_fkey FOREIGN KEY (recruiter_id) REFERENCES public.career_recruiters(id) ON DELETE SET NULL;
ALTER TABLE public.career_scouts ADD CONSTRAINT career_scouts_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.career_emails(id) ON DELETE SET NULL;
ALTER TABLE public.health_metrics ADD CONSTRAINT health_metrics_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE public.home_visit_logs ADD CONSTRAINT home_visit_logs_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.home_visit_members(id) ON DELETE CASCADE;
ALTER TABLE public.learning_logs ADD CONSTRAINT learning_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.partner_executives ADD CONSTRAINT partner_executives_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.partner_companies(id) ON DELETE CASCADE;
ALTER TABLE public.procedure_refine_messages ADD CONSTRAINT procedure_refine_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.procedure_refine_sessions(id) ON DELETE CASCADE;
ALTER TABLE public.refine_messages ADD CONSTRAINT refine_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.refine_sessions(id) ON DELETE CASCADE;
ALTER TABLE public.retrospective_sections ADD CONSTRAINT retrospective_sections_retrospective_id_fkey FOREIGN KEY (retrospective_id) REFERENCES public.retrospectives(id) ON DELETE CASCADE;
ALTER TABLE public.slide_refine_messages ADD CONSTRAINT slide_refine_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.slide_refine_sessions(id) ON DELETE CASCADE;
ALTER TABLE public.x_digest_items ADD CONSTRAINT x_digest_items_digest_date_fkey FOREIGN KEY (digest_date) REFERENCES public.x_digest_runs(digest_date) ON DELETE CASCADE;


-- ===== 5. インデックス（INDEXES） =====
-- 主キー/一意制約に付随するインデックスは「4. 制約」で自動生成されるためここには含めない。
-- memory_chunks_embedding_idx は pgvector の HNSW（エイチエヌエスダブリュー）索引。
-- ベクトル検索（match_memory_chunks_v2 等）の性能はこれに依存する。消さないこと。

CREATE INDEX IF NOT EXISTS bootcamp_logs_created_at_idx ON public.bootcamp_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS bootcamp_logs_sprint_phase_idx ON public.bootcamp_logs USING btree (sprint, phase);
CREATE INDEX IF NOT EXISTS bunshin_logs_created_at_idx ON public.bunshin_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS bunshin_logs_member_idx ON public.bunshin_logs USING btree (member_name, created_at DESC);
CREATE INDEX IF NOT EXISTS career_emails_kind_idx ON public.career_emails USING btree (kind);
CREATE INDEX IF NOT EXISTS career_emails_processed_idx ON public.career_emails USING btree (processed_at) WHERE (processed_at IS NULL);
CREATE INDEX IF NOT EXISTS career_emails_received_idx ON public.career_emails USING btree (received_at DESC);
CREATE INDEX IF NOT EXISTS career_ingest_runs_started_idx ON public.career_ingest_runs USING btree (started_at DESC);
CREATE INDEX IF NOT EXISTS career_jobs_fit_idx ON public.career_jobs USING btree (fit_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS career_jobs_last_seen_idx ON public.career_jobs USING btree (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS career_jobs_status_idx ON public.career_jobs USING btree (status);
CREATE INDEX IF NOT EXISTS career_jobs_unscored_idx ON public.career_jobs USING btree (created_at) WHERE (fit_score IS NULL);
CREATE INDEX IF NOT EXISTS career_scouts_received_idx ON public.career_scouts USING btree (received_at DESC);
CREATE INDEX IF NOT EXISTS career_scouts_reply_idx ON public.career_scouts USING btree (reply_status);
CREATE INDEX IF NOT EXISTS code_session_snapshots_date_idx ON public.code_session_snapshots USING btree (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS daily_actions_date_idx ON public.daily_actions USING btree (entry_date DESC, "position");
CREATE UNIQUE INDEX IF NOT EXISTS daily_actions_diary_dedup ON public.daily_actions USING btree (entry_date, kind, md5(content)) WHERE (source = 'diary'::text);
CREATE UNIQUE INDEX IF NOT EXISTS daily_actions_reminder_uniq ON public.daily_actions USING btree (source_id) WHERE (source = 'reminders'::text);
CREATE UNIQUE INDEX IF NOT EXISTS daily_actions_source_weekly_report_unique ON public.daily_actions USING btree (source, source_id) WHERE (source = 'weekly_report'::text);
CREATE INDEX IF NOT EXISTS daily_work_log_date_idx ON public.daily_work_log USING btree (work_date);
CREATE INDEX IF NOT EXISTS documents_event_date_idx ON public.documents USING btree (event_date);
CREATE INDEX IF NOT EXISTS documents_organization_idx ON public.documents USING btree (organization);
CREATE INDEX IF NOT EXISTS documents_source_type_idx ON public.documents USING btree (source_type);
CREATE INDEX IF NOT EXISTS family_logs_happened_on_idx ON public.family_logs USING btree (happened_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS glossary_reading_idx ON public.glossary USING btree (reading);
CREATE UNIQUE INDEX IF NOT EXISTS glossary_term_key ON public.glossary USING btree (lower(term));
CREATE INDEX IF NOT EXISTS health_conditions_start_day_idx ON public.health_conditions USING btree (start_day DESC);
CREATE INDEX IF NOT EXISTS health_metrics_day_idx ON public.health_metrics USING btree (day DESC);
CREATE INDEX IF NOT EXISTS health_metrics_metric_idx ON public.health_metrics USING btree (metric);
CREATE INDEX IF NOT EXISTS health_metrics_user_id_idx ON public.health_metrics USING btree (user_id);
CREATE INDEX IF NOT EXISTS home_visit_logs_date_idx ON public.home_visit_logs USING btree (visit_date DESC);
CREATE INDEX IF NOT EXISTS home_visit_logs_member_idx ON public.home_visit_logs USING btree (member_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS influence_edges_org_idx ON public.influence_edges USING btree (org_name);
CREATE INDEX IF NOT EXISTS integration_jobs_status_idx ON public.integration_jobs USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS learning_logs_user_id_idx ON public.learning_logs USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS lecture_archives_instructor_title_key ON public.lecture_archives USING btree (instructor, title);
CREATE INDEX IF NOT EXISTS lecture_archives_lecture_date_idx ON public.lecture_archives USING btree (lecture_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS memory_chunks_canonical_idx ON public.memory_chunks USING btree (canonical_document_id, source_document_id, chunk_index);
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_idx ON public.memory_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_chunks_event_date_idx ON public.memory_chunks USING btree (event_date);
CREATE INDEX IF NOT EXISTS memory_chunks_organization_idx ON public.memory_chunks USING btree (organization);
CREATE INDEX IF NOT EXISTS memory_chunks_source_type_idx ON public.memory_chunks USING btree (source_type);
CREATE INDEX IF NOT EXISTS monthly_briefings_month_idx ON public.monthly_briefings USING btree (month DESC, reported_on DESC);
CREATE INDEX IF NOT EXISTS monthly_reports_month_idx ON public.monthly_reports USING btree (month);
CREATE INDEX IF NOT EXISTS notion_contacts_org_name_idx ON public.notion_contacts USING btree (org_name);
CREATE INDEX IF NOT EXISTS notion_contacts_org_page_id_idx ON public.notion_contacts USING btree (org_page_id);
CREATE INDEX IF NOT EXISTS notion_organizations_category_idx ON public.notion_organizations USING btree (category);
CREATE INDEX IF NOT EXISTS notion_organizations_name_idx ON public.notion_organizations USING btree (name);
CREATE INDEX IF NOT EXISTS organization_notes_organization_idx ON public.organization_notes USING btree (organization);
CREATE INDEX IF NOT EXISTS partner_companies_category_idx ON public.partner_companies USING btree (category, name);
CREATE INDEX IF NOT EXISTS partner_executives_company_idx ON public.partner_executives USING btree (company_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS partner_executives_unique_idx ON public.partner_executives USING btree (company_id, name, title);
CREATE INDEX IF NOT EXISTS partner_reports_companies_idx ON public.partner_reports USING gin (companies);
CREATE INDEX IF NOT EXISTS partner_reports_reported_on_idx ON public.partner_reports USING btree (reported_on DESC);
CREATE INDEX IF NOT EXISTS procedure_refine_messages_session_idx ON public.procedure_refine_messages USING btree (session_id, created_at);
CREATE INDEX IF NOT EXISTS procedure_refine_sessions_updated_idx ON public.procedure_refine_sessions USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS ramen_logs_eaten_on_idx ON public.ramen_logs USING btree (eaten_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ramen_logs_review_id_key ON public.ramen_logs USING btree (tabelog_review_id);
CREATE INDEX IF NOT EXISTS ramen_logs_status_idx ON public.ramen_logs USING btree (status);
CREATE INDEX IF NOT EXISTS refine_messages_session_idx ON public.refine_messages USING btree (session_id, created_at);
CREATE INDEX IF NOT EXISTS refine_sessions_closed_at_updated_at_idx ON public.refine_sessions USING btree (closed_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS refine_sessions_updated_idx ON public.refine_sessions USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS retrospectives_period_idx ON public.retrospectives USING btree (period_type, period_start DESC);
CREATE INDEX IF NOT EXISTS salt2_members_company_idx ON public.salt2_members USING btree (company);
CREATE UNIQUE INDEX IF NOT EXISTS salt2_members_email_key ON public.salt2_members USING btree (email) WHERE ((email IS NOT NULL) AND (email <> ''::text));
CREATE INDEX IF NOT EXISTS salt2_members_hobbies_idx ON public.salt2_members USING gin (hobbies);
CREATE INDEX IF NOT EXISTS salt2_members_hobby_tags_idx ON public.salt2_members USING gin (hobby_tags);
CREATE INDEX IF NOT EXISTS salt2_members_industry_tags_idx ON public.salt2_members USING gin (industry_tags);
CREATE UNIQUE INDEX IF NOT EXISTS salt2_members_slack_display_key ON public.salt2_members USING btree (slack_display);
CREATE INDEX IF NOT EXISTS salt2_members_stance_tags_idx ON public.salt2_members USING gin (stance_tags);
CREATE INDEX IF NOT EXISTS salt2_members_tags_idx ON public.salt2_members USING gin (tags);
CREATE INDEX IF NOT EXISTS salt2_members_team_idx ON public.salt2_members USING btree (team);
CREATE INDEX IF NOT EXISTS salt2_members_track_idx ON public.salt2_members USING btree (track);
CREATE INDEX IF NOT EXISTS idx_salt2_qa_log_channel_posted ON public.salt2_qa_log USING btree (channel_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS stakeholders_category_idx ON public.stakeholders_retired_20260730 USING btree (category, name);
CREATE INDEX IF NOT EXISTS strategic_todos_due_date_idx ON public.strategic_todos USING btree (due_date) WHERE (due_date IS NOT NULL);
CREATE INDEX IF NOT EXISTS transcription_dictionary_len_idx ON public.transcription_dictionary USING btree (length(wrong) DESC) WHERE enabled;
CREATE INDEX IF NOT EXISTS weapon_proposal_sections_position_idx ON public.weapon_proposal_sections USING btree ("position");
CREATE INDEX IF NOT EXISTS weekly_focus_week_idx ON public.weekly_focus USING btree (week_start DESC, "position");
CREATE INDEX IF NOT EXISTS weekly_reports_week_start_idx ON public.weekly_reports USING btree (week_start);
CREATE INDEX IF NOT EXISTS x_digest_items_date_section_idx ON public.x_digest_items USING btree (digest_date DESC, section, sort_order);
CREATE INDEX IF NOT EXISTS x_post_metrics_impressions_idx ON public.x_post_metrics USING btree (impressions DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS x_post_metrics_posted_at_idx ON public.x_post_metrics USING btree (posted_at DESC);


-- ===== 5-2. ビュー（VIEWS） =====
-- public に1本だけ。refresh_typo_candidates() が誤字走査の対象コーパスとして使う。
-- 走査対象テーブルを増やすときはここに UNION ALL を足す。

CREATE OR REPLACE VIEW public.typo_scan_corpus AS
 SELECT 'memory_chunks'::text AS src,
    memory_chunks.id::text AS rid,
    concat_ws(' / '::text, memory_chunks.organization, memory_chunks.title, memory_chunks.content) AS txt
   FROM memory_chunks
UNION ALL
 SELECT 'weekly_reports'::text AS src,
    weekly_reports.id::text AS rid,
    concat_ws(' / '::text, weekly_reports.organization, weekly_reports.summary, weekly_reports.insight, weekly_reports.tactic) AS txt
   FROM weekly_reports
UNION ALL
 SELECT 'daily_actions'::text AS src,
    daily_actions.id::text AS rid,
    daily_actions.content AS txt
   FROM daily_actions
UNION ALL
 SELECT 'strategic_todos'::text AS src,
    strategic_todos.id::text AS rid,
    concat_ws(' / '::text, strategic_todos.task_name, strategic_todos.notes) AS txt
   FROM strategic_todos
UNION ALL
 SELECT 'retrospective_sections'::text AS src,
    retrospective_sections.id::text AS rid,
    retrospective_sections.body AS txt
   FROM retrospective_sections
UNION ALL
 SELECT 'organization_notes'::text AS src,
    organization_notes.id::text AS rid,
    concat_ws(' / '::text, organization_notes.organization, organization_notes.content) AS txt
   FROM organization_notes
UNION ALL
 SELECT 'daily_work_log'::text AS src,
    daily_work_log.id::text AS rid,
    concat_ws(' / '::text, daily_work_log.session_title, daily_work_log.next_action) AS txt
   FROM daily_work_log
UNION ALL
 SELECT 'home_visit_logs'::text AS src,
    home_visit_logs.id::text AS rid,
    concat_ws(' / '::text, home_visit_logs.topics, home_visit_logs.next_action) AS txt
   FROM home_visit_logs
UNION ALL
 SELECT 'learning_logs'::text AS src,
    learning_logs.id::text AS rid,
    concat_ws(' / '::text, learning_logs.theme, learning_logs.title, learning_logs.insight) AS txt
   FROM learning_logs
UNION ALL
 SELECT 'ramen_logs'::text AS src,
    ramen_logs.id::text AS rid,
    concat_ws(' / '::text, ramen_logs.shop, ramen_logs.title, ramen_logs.excerpt, ramen_logs.memo, ramen_logs.note) AS txt
   FROM ramen_logs
UNION ALL
 SELECT 'family_logs'::text AS src,
    family_logs.id::text AS rid,
    concat_ws(' / '::text, family_logs.title, family_logs.memo, family_logs.highlight) AS txt
   FROM family_logs
UNION ALL
 SELECT 'legislator_notes'::text AS src,
    legislator_notes.id::text AS rid,
    legislator_notes.content AS txt
   FROM legislator_notes;


-- ===== 6. 関数（FUNCTIONS） =====
-- public スキーマのユーザー定義関数（拡張機能が持ち込んだものは除く）。
-- トリガ関数（set_updated_at / trg_hb_* など）もここに含まれる。

CREATE OR REPLACE FUNCTION public.apply_transcription_dictionary(input text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  pats text[];
  reps text[];
  n int;
  i int;
  k int;
  len int;
  out_text text := '';
  pos int := 1;
  matched boolean;
BEGIN
  IF input IS NULL OR input = '' THEN
    RETURN input;
  END IF;

  -- 置換規則と素通し規則をまとめ、長い順に並べる
  SELECT array_agg(p ORDER BY length(p) DESC, p),
         array_agg(r ORDER BY length(p) DESC, p)
    INTO pats, reps
  FROM (
    SELECT wrong AS p, correct AS r
      FROM transcription_dictionary
     WHERE enabled
       AND NOT (length(wrong) <= 3 AND wrong ~ '^[ぁ-ん]+$')
    UNION
    -- 素通し候補（正しい表記はそのまま出す）
    SELECT correct, correct
      FROM transcription_dictionary
     WHERE enabled
  ) s;

  IF pats IS NULL THEN
    RETURN input;
  END IF;

  n := array_length(pats, 1);
  len := length(input);

  WHILE pos <= len LOOP
    matched := false;
    k := 1;
    WHILE k <= n LOOP
      IF substr(input, pos, length(pats[k])) = pats[k] THEN
        out_text := out_text || reps[k];
        pos := pos + length(pats[k]);
        matched := true;
        EXIT;
      END IF;
      k := k + 1;
    END LOOP;
    IF NOT matched THEN
      out_text := out_text || substr(input, pos, 1);
      pos := pos + 1;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dashboard_stats()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'generated_at', now(),
    'memory_total', (select count(*) from memory_chunks),
    'memory_last24h', (select count(*) from memory_chunks where created_at > now() - interval '24 hours'),
    'memory_last7d', (select count(*) from memory_chunks where created_at > now() - interval '7 days'),
    'db_size_mb', (select round(pg_database_size(current_database())::numeric / 1048576, 1)),
    'memory_by_type', coalesce((
      select jsonb_agg(x order by (x->>'count')::int desc) from (
        select jsonb_build_object('type', source_type, 'count', count(*), 'last', max(created_at),
          'd1', count(*) filter (where created_at > now() - interval '24 hours'),
          'd7', count(*) filter (where created_at > now() - interval '7 days')) x
        from memory_chunks group by source_type
      ) s), '[]'::jsonb),
    'memory_by_org', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('org', coalesce(organization,'(未設定)'), 'count', count(*)) x
        from memory_chunks group by organization order by count(*) desc limit 12
      ) s), '[]'::jsonb),
    'org_status', coalesce((
      select jsonb_agg(x order by (x->>'has_proposal')::boolean, (x->>'party_rank')::int, (x->>'meetings')::int desc) from (
        select jsonb_build_object(
          'name', t.name,
          -- ★チャンク数ではなく実体数。count(*) に戻すと「会議27」が復活する。
          'meetings', (select count(distinct m.canonical_document_id) from memory_chunks m where m.source_type='会議' and m.organization = t.name),
          'last_meeting', (select max(m.event_date) from memory_chunks m where m.source_type='会議' and m.organization = t.name),
          'has_proposal', exists(select 1 from proposal_cache p where p.organization = t.name),
          'has_refine', exists(select 1 from refine_sessions r where r.organization = t.name),
          -- 会派の並び順。議員以外は同順（99）にして従来どおり会議数順になる。
          'party_rank', case t.name
            when '自由民主党' then 1
            when '公明党' then 2
            when '中道改革連合' then 3
            when '立憲民主党' then 4
            when '日本維新の会' then 5
            else 99 end
        ) x
        from (
          select distinct name from (
            select organization as name from memory_chunks where source_type='会議' and organization is not null
            union
            -- 団体マスタは全種別を候補にするが、「対象外」にしたものは外す。
            select name from notion_organizations
             where name is not null and coalesce(status,'') <> '対象外'
          ) u
        ) t
      ) s), '[]'::jsonb),
    'memory_daily', coalesce((
      select jsonb_agg(x order by x->>'d') from (
        select jsonb_build_object('d', to_char(created_at,'YYYY-MM-DD'), 'count', count(*)) x
        from memory_chunks where created_at > now() - interval '13 days'
        group by to_char(created_at,'YYYY-MM-DD')
      ) s), '[]'::jsonb),
    'jobs_summary', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('status', status, 'count', count(*)) x
        from integration_jobs where created_at > now() - interval '7 days' group by status
      ) s), '[]'::jsonb),
    'jobs_recent', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('id', id, 'kind', kind, 'status', status,
          'error', error, 'created_at', created_at, 'updated_at', updated_at) x
        from integration_jobs order by created_at desc limit 8
      ) s), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(x order by x->>'service') from (
        select jsonb_build_object('service', service, 'label', label,
          'last_ok_at', last_ok_at, 'note', last_note) x
        from service_health
      ) s), '[]'::jsonb),
    'refine_sessions', (select count(*) from refine_sessions),
    'refine_messages', (select count(*) from refine_messages),
    'refine_last7d', (select count(*) from refine_sessions where created_at > now() - interval '7 days'),
    'refine_recent', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('id', s.id, 'organization', s.organization,
          'title', s.title, 'updated_at', s.updated_at, 'msgs', count(m.id)) x
        from refine_sessions s left join refine_messages m on m.session_id = s.id
        group by s.id, s.organization, s.title, s.updated_at
        order by s.updated_at desc limit 6
      ) s2), '[]'::jsonb),
    'proposals', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('organization', organization, 'edited', edited,
          'created_at', created_at, 'updated_at', updated_at) x
        from proposal_cache order by updated_at desc limit 12
      ) s), '[]'::jsonb),
    'proposal_last7d', (select count(*) from proposal_cache where updated_at > now() - interval '7 days'),
    'learning_total', (select count(*) from learning_logs),
    'news_recent', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('title', n.title, 'theme', n.theme, 'pub_date', n.pub_date, 'link', n.link) x
        from dx_news n join news_themes nt on nt.theme = n.theme and nt.active
        order by coalesce(n.pub_date, n.fetched_at) desc limit 5
      ) s), '[]'::jsonb),
    'news_by_theme', coalesce((
      select jsonb_agg(x order by (x->>'count')::int desc) from (
        select jsonb_build_object('theme', n.theme, 'category', nt.category, 'count', count(*),
          'last_fetch', max(n.fetched_at), 'last_pub', max(n.pub_date)) x
        from dx_news n join news_themes nt on nt.theme = n.theme and nt.active
        group by n.theme, nt.category
      ) s), '[]'::jsonb),
    'stakeholders', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('category', category, 'count', count(*)) x
        from notion_organizations
        where category is not null and coalesce(status,'') <> '対象外'
        group by category order by count(*) desc
      ) s), '[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.health_daily_summary(target_day date)
 RETURNS TABLE(day date, weight_kg numeric, body_fat_pct numeric, bmi numeric, steps integer, kcal integer, protein_g numeric, fat_g numeric, carbs_g numeric, walking_speed_kmh numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT metric, source, value FROM public.health_metrics WHERE day = target_day
  )
  SELECT
    target_day,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'weight_body_mass' AND source = 'photo' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'weight_body_mass' AND source = 'HealthPlanet' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'body_mass' AND source = 'Apple Health' LIMIT 1)
    ), 1) AS weight_kg,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'body_fat_percentage' AND source = 'photo' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'body_fat_percentage' AND source = 'HealthPlanet' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'body_fat_percentage' AND source = 'Apple Health' LIMIT 1)
    ), 1) AS body_fat_pct,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'body_mass_index' AND source = 'photo' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'body_mass_index' AND source = 'HealthPlanet' LIMIT 1)
    ), 1) AS bmi,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'step_count' AND source = 'photo' LIMIT 1),
      (SELECT max(value) FROM m WHERE metric = 'step_count')
    ))::integer AS steps,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'dietary_energy' AND source = 'カロミル' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'dietary_energy' AND source = 'Apple Health' LIMIT 1)
    ) / 4.184)::integer AS kcal,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'protein' AND source = 'カロミル' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'protein' AND source = 'Apple Health' LIMIT 1)
    ), 1) AS protein_g,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'total_fat' AND source = 'カロミル' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'total_fat' AND source = 'Apple Health' LIMIT 1)
    ), 1) AS fat_g,
    ROUND(COALESCE(
      (SELECT value FROM m WHERE metric = 'carbohydrates' AND source = 'カロミル' LIMIT 1),
      (SELECT value FROM m WHERE metric = 'carbohydrates' AND source = 'Apple Health' LIMIT 1)
    ), 1) AS carbs_g,
    ROUND(
      (SELECT avg(value) FROM m WHERE metric = 'walking_speed')
    , 2) AS walking_speed_kmh
$function$;

CREATE OR REPLACE FUNCTION public.health_range_summary(from_day date, to_day date)
 RETURNS TABLE(day date, weight_kg numeric, body_fat_pct numeric, muscle_kg numeric, bmi numeric, steps integer, kcal integer, protein_g numeric, fat_g numeric, carbs_g numeric, salt_g numeric, walking_speed_kmh numeric, walking_step_length_cm numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    WITH days AS (SELECT generate_series(from_day, to_day, interval '1 day')::date AS day),
    m AS (SELECT day, metric, source, value FROM public.health_metrics
          WHERE day BETWEEN from_day AND to_day)
    SELECT
      d.day,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='weight_body_mass' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='weight_body_mass' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='weight_body_mass' AND source='HealthPlanet' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_mass' AND source='Apple Health' LIMIT 1)
      ),2) AS weight_kg,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_fat_percentage' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_fat_percentage' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_fat_percentage' AND source='HealthPlanet' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_fat_percentage' AND source='Apple Health' LIMIT 1)
      ),2) AS body_fat_pct,
      -- 手入力＞写メ＞それ以外。順序を書かないと同じ日に2つ source があるとき不定になる
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='muscle_mass' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='muscle_mass' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='muscle_mass' LIMIT 1)
      ),2) AS muscle_kg,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_mass_index' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='body_mass_index' AND source='HealthPlanet' LIMIT 1)
      ),1) AS bmi,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='step_count' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='step_count' AND source='photo' LIMIT 1),
        (SELECT max(value) FROM m WHERE m.day=d.day AND metric='step_count')
      ))::integer AS steps,
      COALESCE(
        ROUND(COALESCE(
          (SELECT value FROM m WHERE m.day=d.day AND metric='meal_energy' AND source='manual' LIMIT 1),
          (SELECT value FROM m WHERE m.day=d.day AND metric='meal_energy' AND source='photo' LIMIT 1),
          (SELECT value FROM m WHERE m.day=d.day AND metric='meal_energy' LIMIT 1)
        ))::integer,
        ROUND(COALESCE(
          (SELECT value FROM m WHERE m.day=d.day AND metric='dietary_energy' AND source='カロミル' LIMIT 1),
          (SELECT value FROM m WHERE m.day=d.day AND metric='dietary_energy' AND source='Apple Health' LIMIT 1)
        ) / 4.184)::integer
      ) AS kcal,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_protein' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_protein' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_protein' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='protein' AND source='カロミル' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='protein' AND source='Apple Health' LIMIT 1)
      ),1) AS protein_g,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_fat' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_fat' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_fat' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='total_fat' AND source='カロミル' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='total_fat' AND source='Apple Health' LIMIT 1)
      ),1) AS fat_g,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_carbs' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_carbs' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_carbs' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='carbohydrates' AND source='カロミル' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='carbohydrates' AND source='Apple Health' LIMIT 1)
      ),1) AS carbs_g,
      ROUND(COALESCE(
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_salt' AND source='manual' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_salt' AND source='photo' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='meal_salt' LIMIT 1),
        (SELECT value FROM m WHERE m.day=d.day AND metric='sodium' LIMIT 1) * 2.54 / 1000
      ),2) AS salt_g,
      ROUND((SELECT avg(value) FROM m WHERE m.day=d.day AND metric='walking_speed'),2) AS walking_speed_kmh,
      ROUND((SELECT avg(value) FROM m WHERE m.day=d.day AND metric='walking_step_length'),1) AS walking_step_length_cm
    FROM days d ORDER BY d.day
  $function$;

CREATE OR REPLACE FUNCTION public.import_diary_actions(lookback_days integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  inserted_count int;
begin
  with src as (
    select
      mc.source_id,
      mc.event_date,
      replace(replace(mc.content, chr(13), ' '), chr(10), ' ') as flat
    from memory_chunks mc
    where mc.source_type = '日記'
      and mc.event_date is not null
      and mc.event_date >= current_date - lookback_days
      and mc.source_id is not null
      -- ★ここが変更点。行の生死ではなく「取り込んだ事実」で弾く。
      and not exists (
        select 1 from diary_import_log l where l.source_id = mc.source_id
      )
  ),
  sections as (
    select
      source_id,
      event_date,
      regexp_replace(
        substring(flat from 'やってみよう[：:]\s*(.*)$'),
        '本日の(要点|ポイント).*$', ''
      ) as yatte,
      substring(flat from '本日の(?:要点|ポイント)[^：:]*[：:]\s*(.*)$') as pointtxt
    from src
  ),
  items as (
    select source_id, event_date, 'action'::text as kind, trim(item) as content,
      (row_number() over (partition by source_id order by ord))::int - 1 as position
    from sections s,
      lateral regexp_split_to_table(s.yatte, '。') with ordinality as t(item, ord)
    where s.yatte is not null and trim(item) <> ''
    union all
    select source_id, event_date, 'point'::text as kind, trim(item) as content,
      (row_number() over (partition by source_id order by ord))::int - 1 as position
    from sections s,
      lateral regexp_split_to_table(s.pointtxt, '。') with ordinality as t(item, ord)
    where s.pointtxt is not null and trim(item) <> ''
  ),
  ins as (
    insert into daily_actions (entry_date, kind, content, position, source, source_id)
    select event_date, kind, content, position, 'diary', source_id from items
    on conflict do nothing
    returning 1
  ),
  -- 読んだ日記は、項目が取れたかどうかに関わらず履歴に残す。
  -- 0件の日記を毎回読み直しても結果は変わらないため。
  logged as (
    insert into diary_import_log (source_id, event_date, item_count)
    select s.source_id, s.event_date,
           (select count(*) from items i where i.source_id = s.source_id)
    from src s
    on conflict (source_id) do nothing
    returning 1
  )
  select count(*) into inserted_count from ins;
  return coalesce(inserted_count, 0);
end;
$function$;

CREATE OR REPLACE FUNCTION public.match_memory_chunks(query_embedding vector, match_count integer DEFAULT 8, filter_source_type text DEFAULT NULL::text, filter_organization text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, source_type text, source_id text, organization text, title text, content text, event_date date, metadata jsonb, similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
 SET "hnsw.iterative_scan" TO 'strict_order'
AS $function$
  select
    mc.id,
    mc.source_type,
    mc.source_id,
    mc.organization,
    mc.title,
    mc.content,
    mc.event_date,
    mc.metadata,
    1 - (mc.embedding <=> query_embedding) as similarity
  from public.memory_chunks mc
  where mc.embedding is not null
    and (filter_source_type is null or mc.source_type = filter_source_type)
    and (filter_organization is null or mc.organization = filter_organization)
  order by mc.embedding <=> query_embedding
  limit match_count;
$function$;

CREATE OR REPLACE FUNCTION public.match_memory_chunks_v2(query_embedding vector, match_count integer DEFAULT 8, filter_source_type text DEFAULT NULL::text, filter_organization text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, source_type text, source_id text, organization text, title text, content text, event_date date, metadata jsonb, similarity double precision, canonical_document_id text, source_document_id text, chunk_index integer, ingest_scheme text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
 SET "hnsw.iterative_scan" TO 'strict_order'
AS $function$
  select
    mc.id,
    mc.source_type,
    mc.source_id,
    mc.organization,
    mc.title,
    mc.content,
    mc.event_date,
    mc.metadata,
    1 - (mc.embedding <=> query_embedding) as similarity,
    mc.canonical_document_id,
    mc.source_document_id,
    mc.chunk_index,
    mc.ingest_scheme
  from public.memory_chunks mc
  where mc.embedding is not null
    and (filter_source_type is null or mc.source_type = filter_source_type)
    and (filter_organization is null or mc.organization = filter_organization)
  order by mc.embedding <=> query_embedding
  limit match_count;
$function$;

CREATE OR REPLACE FUNCTION public.memory_identity_problems()
 RETURNS TABLE(canonical_document_id text, source_document_id text, chunk_index integer, ingest_scheme text, source_type text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with base as (
    select id, canonical_document_id, source_document_id, chunk_index,
           ingest_scheme, source_type, created_at
    from public.memory_chunks
  ),
  -- ① 4列のどれかが未設定
  bad_null as (
    select * from base
    where canonical_document_id is null or source_document_id is null
       or chunk_index is null or ingest_scheme is null
  ),
  -- ② 同じ取り込み文書の中で番号が衝突（その組の行を全部返す）
  bad_collide as (
    select b.* from base b
    join (
      select source_document_id, chunk_index from base
      where source_document_id is not null and chunk_index is not null
      group by 1, 2 having count(*) > 1
    ) c on b.source_document_id = c.source_document_id and b.chunk_index = c.chunk_index
  ),
  -- ③ 1つの取り込み文書が複数の実体にまたがる（その文書の行を全部返す）
  bad_span as (
    select b.* from base b
    join (
      select source_document_id from base
      where source_document_id is not null and canonical_document_id is not null
      group by 1 having count(distinct canonical_document_id) > 1
    ) s on b.source_document_id = s.source_document_id
  )
  select distinct canonical_document_id, source_document_id, chunk_index,
         ingest_scheme, source_type, created_at
  from (
    select * from bad_null
    union all select * from bad_collide
    union all select * from bad_span
  ) x
$function$;

CREATE OR REPLACE FUNCTION public.record_heartbeat(p_service text, p_label text, p_note text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.service_health(service, label, last_ok_at, last_note, updated_at)
  values (p_service, p_label, p_at, p_note, now())
  on conflict (service) do update set
    label      = excluded.label,
    last_ok_at = greatest(public.service_health.last_ok_at, excluded.last_ok_at), -- 最新時刻を保つ(nullは無視)
    last_note  = excluded.last_note,
    updated_at = now();
$function$;

CREATE OR REPLACE FUNCTION public.record_job_heartbeats(events jsonb)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  e jsonb;
  n integer := 0;
begin
  for e in select value from jsonb_array_elements(coalesce(events, '[]'::jsonb))
  loop
    if coalesce(e->>'job', '') = '' or (e->>'at') is null then
      continue;  -- 壊れた行は黙って捨てる。スプールが詰まる方が怖い
    end if;

    if coalesce(e->>'kind', 'ok') = 'fail' then
      -- 失敗側だけを書く。新規行の last_ok_at は明示的に NULL（まだ一度も成功していない）。
      -- 既存行の last_ok_at は update 句に挙げないので一切触らない。
      insert into public.job_heartbeats as h (job, last_ok_at, last_fail_at, last_exit_code, fail_note)
      values (e->>'job', null, (e->>'at')::timestamptz, nullif(e->>'exit_code','')::int, e->>'note')
      on conflict (job) do update set
        last_exit_code = case when h.last_fail_at is null or excluded.last_fail_at >= h.last_fail_at
                              then excluded.last_exit_code else h.last_exit_code end,
        fail_note      = case when h.last_fail_at is null or excluded.last_fail_at >= h.last_fail_at
                              then excluded.fail_note else h.fail_note end,
        last_fail_at   = greatest(h.last_fail_at, excluded.last_fail_at);
    else
      -- 成功側。last_fail_at は消さない（last_ok_at が新しくなれば判定側で自然に黙る）。
      insert into public.job_heartbeats as h (job, last_ok_at, note)
      values (e->>'job', (e->>'at')::timestamptz, e->>'note')
      on conflict (job) do update set
        note       = case when h.last_ok_at is null or excluded.last_ok_at >= h.last_ok_at
                          then excluded.note else h.note end,
        last_ok_at = greatest(h.last_ok_at, excluded.last_ok_at);
    end if;

    n := n + 1;
  end loop;

  return n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_typo_candidates()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  delete from typo_candidates;

  insert into typo_candidates (kind, wrong, suggested, hits, sample)
  select 'unapplied', d.wrong, d.correct, count(*),
         min(substring(c.txt from greatest(1, position(d.wrong in c.txt) - 30) for 90))
  from transcription_dictionary d
  join typo_scan_corpus c
    on text_occurrences(c.txt, d.wrong)
       - case when position(d.wrong in d.correct) > 0
              then text_occurrences(c.txt, d.correct) else 0 end > 0
  where d.enabled
    and not (length(d.wrong) <= 3 and d.wrong ~ '^[ぁ-ん]+$')
    and not exists (select 1 from typo_ignores i where i.word = d.wrong)
  group by d.wrong, d.correct;

  insert into typo_candidates (kind, wrong, suggested, hits, sample)
  with toks as (
    select m[1] as tok, c.rid,
           substring(c.txt from greatest(1, position(m[1] in c.txt) - 30) for 90) as snip
    from typo_scan_corpus c,
         lateral regexp_matches(c.txt, '([ァ-ヴ][ァ-ヴー]{3,15})', 'g') m
  ),
  agg as (
    select tok, count(distinct rid) as rows_, count(*) as n, min(snip) as sample
    from toks group by tok
  ),
  norm as (
    select a.*,
           substr(a.tok, 1, 1)
             || translate(substr(a.tok, 2), 'ツヤユヨアイウエオ', 'ッャュョァィゥェォ') as fixed
    from agg a
  )
  select 'kogaki', n.tok, n.fixed, n.rows_, n.sample
  from norm n
  join agg b on b.tok = n.fixed
  where n.fixed <> n.tok
    and b.n > n.n
    and not exists (select 1 from typo_ignores i where i.word = n.tok);

  select count(*) into n from typo_candidates;

  insert into job_heartbeats (job, last_ok_at, note)
  values ('typo-candidates', now(), n || '件の候補')
  on conflict (job) do update set last_ok_at = excluded.last_ok_at, note = excluded.note;

  return n;
end
$function$;

CREATE OR REPLACE FUNCTION public.replace_weapon_template(p_sections jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n integer;
begin
  delete from public.weapon_proposal_sections;

  insert into public.weapon_proposal_sections (position, section, guidance)
  select
    (elem->>'position')::int,
    elem->>'section',
    elem->>'guidance'
  from jsonb_array_elements(p_sections) elem;

  get diagnostics n = row_count;
  return n;
end;
$function$;

-- 注: rls_auto_enable は event_trigger 関数。新規テーブル作成時に自動でRLSを有効化する。
--     対応するイベントトリガ本体は「7. RLS」の末尾に記載。
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_legislator_notes_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_organization_notes_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_salt2_members_search_text()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.search_text :=
    coalesce(new.name, '') || ' ' ||
    coalesce(new.kana, '') || ' ' ||
    coalesce(new.slack_display, '') || ' ' ||
    coalesce(new.company, '') || ' ' ||
    coalesce(new.role, '') || ' ' ||
    coalesce(new.career, '') || ' ' ||
    coalesce(new.ai_usage, '') || ' ' ||
    coalesce(new.goal, '') || ' ' ||
    coalesce(new.personal, '') || ' ' ||
    coalesce(new.note, '') || ' ' ||
    coalesce(new.track, '') || ' ' ||
    coalesce(new.team, '') || ' ' ||
    coalesce(new.raw_intro, '') || ' ' ||
    coalesce(array_to_string(new.hobbies, ' '), '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '') || ' ' ||
    coalesce(array_to_string(new.industry_tags, ' '), '') || ' ' ||
    coalesce(array_to_string(new.stance_tags, ' '), '') || ' ' ||
    coalesce(array_to_string(new.hobby_tags, ' '), '');
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.sync_weekly_report_tactic_to_action()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.tactic is not null and btrim(new.tactic) <> '' then
    insert into public.daily_actions (entry_date, kind, content, source, source_id)
    values (
      new.week_start,
      'action',
      format('[%s] %s', coalesce(new.organization, new.category), new.tactic),
      'weekly_report',
      new.id::text
    )
    on conflict (source, source_id) where source = 'weekly_report'
    do update set
      entry_date = excluded.entry_date,
      content = excluded.content;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.text_occurrences(t text, s text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when coalesce(s,'') = '' or coalesce(t,'') = '' then 0
              else (length(t) - length(replace(t, s, ''))) / length(s) end
$function$;

CREATE OR REPLACE FUNCTION public.trg_hb_jobs()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'done' and (old.status is distinct from 'done') then
    begin
      if new.kind = 'plaud' then perform public.record_heartbeat('plaud','PLAUD取込', coalesce(new.result,'完了'));
      elsif new.kind = 'eight' then perform public.record_heartbeat('eight','Eight取込', coalesce(new.result,'完了'));
      end if;
    exception when others then null;
    end;
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_hb_news()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin perform public.record_heartbeat('news','ニュース収集','記事取得'); exception when others then null; end;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_hb_notion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.source_type in ('会議','学び','日記') then
    begin perform public.record_heartbeat('notion','Notion連携','記憶同期'); exception when others then null; end;
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.trigger_notion_sync()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'net'
AS $function$
declare
  v_url text;
  v_cookie text;
  v_request_id bigint;
begin
  select value into v_url    from public.app_config where key = 'notion_sync_url';
  select value into v_cookie from public.app_config where key = 'notion_sync_auth_cookie';

  -- 設定が無ければ黙って何もしない。ここで例外を投げるとcronのジョブ履歴が
  -- 失敗で埋まり、本当の異常が埋もれるため。
  if v_url is null or v_cookie is null then
    raise notice 'trigger_notion_sync: app_config に notion_sync_url / notion_sync_auth_cookie が無いのでスキップ';
    return null;
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Cookie', 'aiworkos_auth=' || v_cookie,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$function$;


-- ===== 6-2. トリガ（TRIGGERS） =====

CREATE TRIGGER hb_jobs AFTER UPDATE ON public.integration_jobs FOR EACH ROW EXECUTE FUNCTION trg_hb_jobs();
CREATE TRIGGER hb_news AFTER INSERT ON public.dx_news FOR EACH STATEMENT EXECUTE FUNCTION trg_hb_news();
CREATE TRIGGER hb_notion AFTER INSERT ON public.memory_chunks FOR EACH ROW EXECUTE FUNCTION trg_hb_notion();
CREATE TRIGGER legislator_notes_set_updated_at BEFORE UPDATE ON public.legislator_notes FOR EACH ROW EXECUTE FUNCTION set_legislator_notes_updated_at();
CREATE TRIGGER organization_notes_set_updated_at BEFORE UPDATE ON public.organization_notes FOR EACH ROW EXECUTE FUNCTION set_organization_notes_updated_at();
CREATE TRIGGER trg_health_metrics_updated_at BEFORE UPDATE ON public.health_metrics FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_salt2_members_search_text BEFORE INSERT OR UPDATE ON public.salt2_members FOR EACH ROW EXECUTE FUNCTION set_salt2_members_search_text();
CREATE TRIGGER trg_salt2_members_updated_at BEFORE UPDATE ON public.salt2_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_weekly_report_tactic_to_action AFTER INSERT OR UPDATE OF tactic ON public.weekly_reports FOR EACH ROW EXECUTE FUNCTION sync_weekly_report_tactic_to_action();

-- イベントトリガ（DB全体）。新規テーブルに自動でRLSを掛ける仕掛け。
-- ※ Supabase が自前で持つ issue_pg_cron_access / pgrst_ddl_watch 等は管理外なのでここには書かない。
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end EXECUTE FUNCTION public.rls_auto_enable();


-- ===== 7. RLS（行レベルセキュリティ）とポリシー =====
--
-- 【この環境の設計方針】
--   ・public の全テーブル（77本）で RLS が有効。上の ensure_rls により新規テーブルも自動で有効化される。
--   ・アプリ本体は service_role キーで接続するため RLS をバイパスする。
--     よってポリシーは「anon / authenticated に読み取りをどこまで開けるか」だけを決めている。
--   ・ポリシーが0本のテーブルは anon/authenticated からは一切見えない（＝サーバー経由専用）。
--     これは事故ではなく既定の閉じた状態。下の「ポリシー0本」リストを参照。

-- --- 7-1. RLS 有効化（全テーブル） ---

ALTER TABLE public.advisor_finding_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bootcamp_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bunshin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_ingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_recruiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_scouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claude_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_session_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_session_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_work_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diary_import_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dx_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.glossary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_weekly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_visit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_visit_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influence_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lecture_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lecture_archives_backup_20260822 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legislator_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legislators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_chunks_text_backup_20260804 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notion_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notion_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_priority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_executives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procedure_refine_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procedure_refine_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proposal_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ramen_hall_of_fame ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ramen_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ramen_monthly_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ramen_shop_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refine_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refine_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retrospective_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retrospectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salt2_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salt2_qa_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slide_refine_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slide_refine_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stakeholders_retired_20260730 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategic_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_dictionary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.typo_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.typo_ignores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weapon_proposal_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_focus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_work_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_digest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_follower_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_monthly_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x_post_metrics ENABLE ROW LEVEL SECURITY;

-- --- 7-2. ポリシー（POLICIES） 全51本 ---

CREATE POLICY bootcamp_logs_anon_select ON public.bootcamp_logs AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "claude_usage_daily anon read" ON public.claude_usage_daily AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read daily_actions" ON public.daily_actions AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "daily_work_log anon read" ON public.daily_work_log AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "authenticated read access" ON public.dx_news AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "service role full access" ON public.dx_news AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "family_logs anon read" ON public.family_logs AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY glossary_anon_select ON public.glossary AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select health_goals" ON public.health_goals AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "authenticated read health_metrics" ON public.health_metrics AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "home_visit_logs anon read" ON public.home_visit_logs AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "home_visit_members anon read" ON public.home_visit_members AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon select integration_jobs" ON public.integration_jobs AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "Users can delete own learning logs" ON public.learning_logs AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own learning logs" ON public.learning_logs AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own learning logs" ON public.learning_logs AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own learning logs" ON public.learning_logs AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "lecture_archives anon read" ON public.lecture_archives AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read legislator_notes" ON public.legislator_notes AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select legislators" ON public.legislators AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "monthly_reports anon read" ON public.monthly_reports AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "authenticated read access themes" ON public.news_themes AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "service role full access themes" ON public.news_themes AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon read notion_contacts" ON public.notion_contacts AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read notion_organizations" ON public.notion_organizations AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read organization_notes" ON public.organization_notes AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select partner_companies" ON public.partner_companies AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select partner_executives" ON public.partner_executives AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select partner_reports" ON public.partner_reports AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read procedure_refine_messages" ON public.procedure_refine_messages AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read procedure_refine_sessions" ON public.procedure_refine_sessions AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read push_subscriptions" ON public.push_subscriptions AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "ramen_hall_of_fame anon read" ON public.ramen_hall_of_fame AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "ramen_logs anon read" ON public.ramen_logs AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "ramen_monthly_posts anon read" ON public.ramen_monthly_posts AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon read refine_messages" ON public.refine_messages AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read refine_sessions" ON public.refine_sessions AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select retrospective_sections" ON public.retrospective_sections AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select retrospectives" ON public.retrospectives AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "salt2_members anon read" ON public.salt2_members AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY salt2_qa_log_anon_select ON public.salt2_qa_log AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read slide_refine_messages" ON public.slide_refine_messages AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read slide_refine_sessions" ON public.slide_refine_sessions AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read stakeholders" ON public.stakeholders_retired_20260730 AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select strategic_todos" ON public.strategic_todos AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select transcription_dictionary" ON public.transcription_dictionary AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon read weapon_proposal_sections" ON public.weapon_proposal_sections AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "weekly_reports anon read" ON public.weekly_reports AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "anon select weekly_work_minutes" ON public.weekly_work_minutes AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "x_follower_snapshots anon read" ON public.x_follower_snapshots AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "x_monthly_posts anon read" ON public.x_monthly_posts AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

-- --- 7-3. RLSは有効だがポリシーが0本のテーブル（31本） ---
-- service_role（＝サーバー側API）からしか触れない。anon/authenticated には完全に不可視。
-- 意図的にそうなっているものと、ポリシーを付け忘れて画面から読めないだけのものが
-- 混ざっている可能性があるため、棚卸しのときはここを見ること。
--   advisor_finding_state, app_config, bunshin_logs, career_criteria, career_emails,
--   career_ingest_runs, career_jobs, career_recruiters, career_scouts, code_session_prefs,
--   code_session_snapshots, diary_import_log, documents, health_conditions,
--   health_weekly_reports, influence_edges, job_heartbeats,
--   lecture_archives_backup_20260822, memory_chunks, memory_chunks_text_backup_20260804,
--   monthly_briefings, org_priority, proposal_cache, ramen_shop_accounts, service_health,
--   typo_candidates, typo_ignores, weekly_focus, x_digest_items, x_digest_runs, x_post_metrics
-- ※ app_config は notion_sync_auth_cookie 等の秘密を持つので、ここにポリシーを足してはいけない。


-- ===== 8. コメント（COMMENTS） =====
-- 設計意図が書かれている。ここが一番「なぜそうなっているか」を残している場所なので、
-- テーブルを触るときは必ず先に読むこと。

-- --- 8-1. テーブルコメント ---

COMMENT ON TABLE public.advisor_finding_state IS 'ホームの「今朝の気づき」に対する手入れ（非表示・納期）。気づき本体は毎朝再計算されるため、人の判断だけを保存する。';
COMMENT ON TABLE public.app_config IS 'サーバ専用の設定/シークレット置き場。RLS有効・ポリシー無しでservice role以外はアクセス不可。';
COMMENT ON TABLE public.bootcamp_logs IS 'SALT2ブートキャンプの学習ログ。Sprint×フェーズごとに、学んだ内容・判断・新規事業への応用を残す';
COMMENT ON TABLE public.bunshin_logs IS '分身AIへの相談ログ（apps/bunshin-ai）。誰がどんな相談をしたかを吉井さんが振り返るためのもの。評価には使わない。';
COMMENT ON TABLE public.claude_usage_daily IS 'CCDセッションのタイムスタンプ密集度から推定したClaude利用時間（日次・下限値の近似）。ホーム画面「今週のClaude利用時間」の元データ。2026-07-26作成。';
COMMENT ON TABLE public.code_session_prefs IS 'ホームのセッション盤面の手動設定。走査（毎晩22:30）が上書きしないよう日付を持たない。';
COMMENT ON TABLE public.code_session_snapshots IS 'Claude Codeセッションの日次スナップショット（鮮度の盤面）。progress.py がローカルから毎晩upsertする。進捗率は持たない——セッションに完了の定義が無く測れないため、持つのは経過日数と止まり方だけ。';
COMMENT ON TABLE public.daily_actions IS '一行日記の「やってみよう(action)」「本日のポイント(point)」を日付ごとに積み上げるToDo。チェック(done)・編集可。source=diaryは日記由来、manualは手動追加。';
COMMENT ON TABLE public.daily_work_log IS '各CCDセッションの日次処理状況（日報録）。work_date=JST基準の作業日。progressed/next_actions=文字列配列、deliverables=[{name,status}]。forkは1ワークストリームに束ねて1行。';
COMMENT ON TABLE public.diary_import_log IS '一行日記から daily_actions へ取り込んだ source_id の履歴。行を消しても再取込されないようにするための墓標。ここから1行消すと、その日記は再取込できる。';
COMMENT ON TABLE public.documents IS '原文の保管庫。memory_chunksはここから生成する派生物。切り方を変えたら再生成する。';
COMMENT ON TABLE public.health_conditions IS '体調の記録（期間つき）。/health の体調カードから読み書きする。';
COMMENT ON TABLE public.health_goals IS '健康指標の目標値。吉井さんが画面から設定する。値は本人が入れるもので、こちらで勝手に決めない。';
COMMENT ON TABLE public.health_metrics IS 'Apple Health(Health Auto Export)経由で蓄積する個人の健康指標。ロング型。';
COMMENT ON TABLE public.health_weekly_reports IS '健康習慣レポート（週次）。数値は health_metrics が正で、ここは評価とコメントだけを持つ';
COMMENT ON TABLE public.influence_edges IS '組織攻略の影響力マップ（人物間の関係の線）。draft=AI下書き、confirmed=吉井さん確定。';
COMMENT ON TABLE public.job_heartbeats IS '定期実行ジョブの最終成功時刻。cron/daily-todo が途絶を検知して通知する。';
COMMENT ON TABLE public.legislators IS '議員リスト（アプローチ候補）。吉井さんが自分で作っている、DXに強い政令市議員の名簿。まだ接点が無い人も含むため、実際に接点のある人を入れるNotion人脈DB(notion_contacts)とは別に持つ。接点ができた人はcontact_page_idでnotion_contactsと紐づける。';
COMMENT ON TABLE public.memory_chunks_text_backup_20260804 IS '2026-08-04 音声誤字の一括置換(A群14語)の直前スナップショット。本文カラムのみ。問題なければDROPしてよい。';
COMMENT ON TABLE public.monthly_briefings IS '上長への月次報告の議事メモ。/monthly-report から読み書きし、memory_chunks(source_type=月次報告)へも流す。';
COMMENT ON TABLE public.monthly_reports IS '月報ドラフト（暦月単位）。weekly_reportsを集計・AI要約し、部月報会向けの下書きとNotion連携を保持する。';
COMMENT ON TABLE public.notion_contacts IS 'Notion「人脈DB」の写し。Notionが正で、/api/cron/notion-sync が上書きする。直接書き込むと次の同期で消える。';
COMMENT ON TABLE public.notion_organizations IS 'Notion「顧客CRM」の写し。Notionが正で、/api/cron/notion-sync が上書きする。直接書き込むと次の同期で消える。stakeholders の後継。';
COMMENT ON TABLE public.org_priority IS '「次に攻める相手」の優先順位（★1〜3、★3が最優先）。団体名が鍵。狙いは週単位で変わるのでNotionへは往復させない。';
COMMENT ON TABLE public.push_subscriptions IS 'ブラウザのWeb Push購読情報。日々のToDoの朝の通知(残件数)を送るために使う。';
COMMENT ON TABLE public.ramen_shop_accounts IS 'ラーメン店のXアカウント台帳。投稿時に@メンションして店側のRTを狙うため（2026-08-03のバズ分析で、impが跳ねる唯一の実測要因が店アカウントのRTだった）。';
COMMENT ON TABLE public.retrospectives IS '週次・月次の振り返り。★評価と示唆を溜め、時系列で見返すためのもの。事実のログは weekly_reports 側。';
COMMENT ON TABLE public.stakeholders_retired_20260730 IS '【退役】旧・団体マスタ。2026-07-30にNotion「顧客CRM」→ notion_organizations へ移行済み。アプリからは参照していない。移行しなかったのは 熊谷議員（人名・人脈DBのくまがい誠一）／議員連盟（名称が曖昧）／パーソルプロセス＆テクノロジー（旧社名）／パーソルプロセスビジネスデザイン（語順違いの旧表記）の4件。問題が無ければDROPしてよい。';
COMMENT ON TABLE public.transcription_dictionary IS '音声入力の誤変換辞書。取り込み時に wrong を correct へ置換する。長い語から先に適用すること（「東洋信業株式会社」を「東洋信業」より先に処理しないと取り残す）。';
COMMENT ON TABLE public.typo_candidates IS '本文に残っている誤字の候補。refresh_typo_candidates() が毎月入れ替える。判断材料であって、自動では直さない。';
COMMENT ON TABLE public.typo_ignores IS '誤字ではないと判断済みの語。typo_candidates の検知から除外する。ここに入れないと毎月同じものが挙がり続け、カードが信用されなくなる。';
COMMENT ON TABLE public.weapon_proposal_sections IS '武器ビルダーの提案書(資料集)ひな形。節の見出し・順序・書き方の指示をUIから編集できるようにする。';
COMMENT ON TABLE public.weekly_focus IS 'ホーム上部の「今週おこなうこと」。1週あたり最大5件。日々のToDoとは別物で、絞ること自体が目的。';
COMMENT ON TABLE public.weekly_reports IS '週報ダッシュボード。一行日記ベースの週次振り返り（weekly-reportスキル出力）を週始まり(月曜)×カテゴリー×団体で構造化して保持する。';
COMMENT ON TABLE public.weekly_work_minutes IS 'Claude Codeのセッション履歴から機械的に推定した週次の稼働時間。週は月曜はじまり(JST)。nippo-aggregate.py が更新する。';
COMMENT ON TABLE public.x_digest_items IS 'X監視ダイジェストの中身。section=keyword/manus/takano。metric は「いいね数」で、取れなかったときは0ではなくnull。';
COMMENT ON TABLE public.x_digest_runs IS 'X監視ダイジェストの実行記録（1日1行）。statuses で見張りごとの成否を持ち、items が0件でも「取得できて0件」と言い切れるようにする。';
COMMENT ON TABLE public.x_post_metrics IS 'ラーメンXの投稿ごとの反応。analytics.x.com のCSVを取り込む。x_follower_snapshots が「自分が打った量」なのに対し、こちらは「相手の反応」を持つ。';

-- --- 8-2. 列コメント ---

COMMENT ON COLUMN public.bootcamp_logs.decisions IS '壁打ちで決めたことと、その理由';
COMMENT ON COLUMN public.bootcamp_logs.business_application IS '新規事業への応用ポイント。書き忘れ防止のためNOT NULL';
COMMENT ON COLUMN public.bootcamp_logs.qa_session IS 'qa-thinkingスキルのセッション内容（クイズ生成の第一候補の材料）';
COMMENT ON COLUMN public.bunshin_logs.member_name IS 'ログイン時に本人が入力した名前。';
COMMENT ON COLUMN public.claude_usage_daily.hours IS '当日のセッションlastActivityAtの最小〜最大の幅+0.5h緩衝、10h上限でキャップした推定値。実際の利用時間はこれ以上の可能性が高い（下限値）。';
COMMENT ON COLUMN public.code_session_snapshots.days_idle IS '走査時点で最後に動いてからの経過日数。last_activity_at が取れない場合は null。';
COMMENT ON COLUMN public.code_session_snapshots.is_stalled IS 'ツール実行の途中・指示に未応答など、中断したまま止まっている状態。放置（単に古い）とは別物。';
COMMENT ON COLUMN public.code_session_snapshots.last_event IS '止まり方の生の文言（完了／ツール実行の途中／指示に未応答 等）。判定はここまでで、原因は書かない。';
COMMENT ON COLUMN public.daily_actions.due_date IS '納期。entry_date（いつの日記か）とは別。未設定なら納期なし。';
COMMENT ON COLUMN public.documents.sections IS 'スライドや章など、元文書が持っていた自然な区切り。チャンク化はこの境界を最優先で使う。';
COMMENT ON COLUMN public.health_weekly_reports.advice IS '来週への助言。AIが下書きし、人が直してから保存する。';
COMMENT ON COLUMN public.job_heartbeats.last_ok_at IS '最後に成功した時刻。失敗では絶対に更新しない（成功していないのに成功時刻を書き換えたら監視が嘘をつく）。一度も成功していないジョブでは NULL。';
COMMENT ON COLUMN public.job_heartbeats.last_fail_at IS '最後に「走ったが落ちた」時刻。last_ok_at より新しければ、鈍い staleHours を待たずに即座に鳴らす。打刻が無いだけの状態（Macが閉じていた）と区別するためにある。';
COMMENT ON COLUMN public.job_heartbeats.last_exit_code IS 'そのとき本体が返した終了コード。何がどう落ちたかを通知の facts に出すため。';
COMMENT ON COLUMN public.job_heartbeats.fail_note IS '失敗時の短い記録（ラッパー名や状況）。原因の断定はしない。';
COMMENT ON COLUMN public.legislators.party_site IS '会派の公式サイトに本人ページがあるか';
COMMENT ON COLUMN public.legislators.personal_site IS '個人のサイトがあるか';
COMMENT ON COLUMN public.legislators.contact_page_id IS '接点ができてNotion人脈DBにも登録された場合の notion_contacts.notion_page_id。未接点ならNULL。';
COMMENT ON COLUMN public.news_themes.subcategory IS '中カテゴリー。大カテゴリー(category)の下の束ね。例: category=生成AI / subcategory=Claude関係';
COMMENT ON COLUMN public.notion_contacts.org_page_id IS 'Notion「組織名」リレーションの先頭ページID。notion_organizations.notion_page_id と対応するが、外部キー制約は張らない（Notion側でアーカイブされた組織を参照している行があると同期そのものが落ちるため）。';
COMMENT ON COLUMN public.notion_contacts.org_name IS '組織名の非正規化コピー。JOINなしで一覧を出せるように持つ。';
COMMENT ON COLUMN public.notion_contacts.flag IS '「現担当」「過去担当」。Notion側のフラグ列をそのまま写す。';
COMMENT ON COLUMN public.notion_organizations.category IS '正準8分類（lib/categories.ts の ORG_CATEGORIES）へ正規化した値。Notion側が正準外（例:企業）や未設定ならnull。';
COMMENT ON COLUMN public.notion_organizations.raw_category IS 'Notion「種別」の生値。正規化で情報が落ちた場合の追跡用。';
COMMENT ON COLUMN public.partner_companies.relationship IS 'うちとその会社の関係。事業者なら利用状況（利用中／トライアル申込済み・未開始）、委託会社なら提携の度合い（業務連携協定を締結／協力関係）。';
COMMENT ON COLUMN public.procedure_refine_sessions.base_doc IS '壁打ちの土台として持ち込んだ元文書の抽出テキスト。ファイル本体は保存しない。';
COMMENT ON COLUMN public.ramen_logs.status IS 'captured=撮って送っただけ / drafted=文章生成済み・投稿待ち / posted=食べログとXに出し終わった';
COMMENT ON COLUMN public.ramen_logs.memo IS 'その場で吹き込んだ一言。文章生成の一次情報になるので原文のまま残す';
COMMENT ON COLUMN public.ramen_logs.stars_label IS '写真のメモ欄に本人が書いた★の原文（★★★☆ など）。まとめ投稿にはこれをそのまま載せる';
COMMENT ON COLUMN public.ramen_logs.x_post_lock IS 'X投稿の排他制御専用ロック。NULL=ロック無し, posting=投稿予約中, post_failed_needs_review=投稿成功だがDB書き戻し失敗で要確認。一般的なレコード状態を表すstatus列とは別物で、x_urlの有無と合わせて判定する。';
COMMENT ON COLUMN public.ramen_shop_accounts.status IS '未調査 / 調査済 / アカウント無し';
COMMENT ON COLUMN public.refine_sessions.closed_at IS '壁打ちセッションをクローズした時刻。NULLなら進行中。クローズは一覧から引っ込めるだけで、会話ログも成果物も消さない。';
COMMENT ON COLUMN public.refine_sessions.base_doc IS '壁打ちの土台として持ち込んだ資料の抽出テキスト。ファイル本体は保存しない。';
COMMENT ON COLUMN public.retrospective_sections.rating IS '★の数（1〜5）。★が無い節はNULL。';
COMMENT ON COLUMN public.retrospective_sections.assessment IS '【評価】その週をどう見るか。';
COMMENT ON COLUMN public.retrospective_sections.impact IS '【将来への影響】先々どう効くか。';
COMMENT ON COLUMN public.retrospectives.action_guideline IS '【来週の行動指針】どういう週にするかの一文。next_plans（個別の予定）とは別。';
COMMENT ON COLUMN public.salt2_members.sns_confidence IS '本人特定の確度。確実 / たぶん / null（リンクが無い人）';
COMMENT ON COLUMN public.strategic_todos.due_date IS '納期。画面のカレンダーから入れる。Notion「ToDo DB」の納期プロパティと双方向で同期する。未設定はNULL。';
COMMENT ON COLUMN public.weekly_reports.week_start IS 'その週の月曜日。週の切替キー。';
COMMENT ON COLUMN public.weekly_reports.category IS '全体(事業部向けサマリー)/支店/自治体/事業者/議員/委託企業/銀行/プロモーションの8分類。';
COMMENT ON COLUMN public.weekly_reports.organization IS '自治体/事業者/議員/委託企業行の対象団体名。全体行はnull。';
COMMENT ON COLUMN public.x_monthly_posts.kind IS 'summary=①まとめ（式まとめ・活動記録・戦績など呼称は月により揺れる）／feature=②特徴（総括を含む）／awards=③金賞・殿堂（ランキング・トップ5を含む）';
COMMENT ON COLUMN public.x_post_metrics.impressions IS '閲覧数（インプレッション）。フォロワー増の先行指標。';
COMMENT ON COLUMN public.x_post_metrics.likes IS 'もらったいいね。x_follower_snapshots.like_count（自分がしたいいね）とは別物。';


-- =====================================================================
-- 付記：退役テーブル（削除候補）
-- =====================================================================
-- 以下の3本は、現状の写しとして含めているが「使われていない過去の残骸」。
-- アプリからは参照していないので、影響が無いことを確認できたらDROPしてよい。
--   ・public.stakeholders_retired_20260730         … 旧・団体マスタ。notion_organizations へ移行済（2026-07-30）
--   ・public.memory_chunks_text_backup_20260804    … 誤字一括置換の直前スナップショット（2026-08-04）
--   ・public.lecture_archives_backup_20260822      … lecture_archives の退避（2026-08-22）。制約もインデックスも無い素の写し
-- 削除するときは production-change-protocol に従い、
-- このファイルではなく新しいマイグレーションとして DROP を追加すること。

-- ===== ベースライン ここまで =====

-- =====================================================================
-- 追補（2026-09-12 同日・ベースライン作成直後に判明）
-- =====================================================================
-- health_labs / health_medications / health_profile_sections の3本が
-- 上の本体に入っていない。ベースラインを吸い出している最中に本番へ
-- 追加されたため、写し取った時点では存在しなかった。
--
-- 本番と突き合わせて（relkind='r' の全80本 vs 本体の77本）判明した漏れ。
-- ベースラインは「本番と一致していること」だけが価値なので、ここで埋める。
--
-- ※次から新しいテーブルを足すときは、このファイルへ追記するのではなく
--   supabase/migrations/ に新しいファイルを作ること。ここへの追記は
--   「ベースライン作成時に取りこぼした分」に限る。
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.health_labs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  measured_on date NOT NULL,
  item text NOT NULL,
  value numeric,
  value_text text,
  unit text,
  category text,
  flag text,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.health_medications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  category text,
  name text NOT NULL,
  dose text,
  purpose text,
  note text,
  started_on date,
  ended_on date,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  efficacy text,
  efficacy_updated_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.health_profile_sections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.health_labs ADD CONSTRAINT health_labs_pkey PRIMARY KEY (id);
ALTER TABLE public.health_medications ADD CONSTRAINT health_medications_pkey PRIMARY KEY (id);
ALTER TABLE public.health_medications ADD CONSTRAINT health_medications_kind_check
  CHECK ((kind = ANY (ARRAY['継続処方'::text, '頓用・臨時'::text, '完了'::text, 'サプリ'::text])));
ALTER TABLE public.health_profile_sections ADD CONSTRAINT health_profile_sections_pkey PRIMARY KEY (id);
ALTER TABLE public.health_profile_sections ADD CONSTRAINT health_profile_sections_key_key UNIQUE (key);

CREATE INDEX IF NOT EXISTS health_labs_date_idx ON public.health_labs USING btree (measured_on DESC);
CREATE INDEX IF NOT EXISTS health_labs_item_idx ON public.health_labs USING btree (item, measured_on DESC);

-- この3本もポリシーは0本（service_role のみ）。7-3節の一覧に足して読むこと。
ALTER TABLE public.health_labs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_profile_sections ENABLE ROW LEVEL SECURITY;

-- --- ベースラインに含めていないテーブル（意図的に除外） ---------------
-- public.insights  … 夜間参謀 Phase 1。20260913000000_insights.sql が正。
-- public.diary_raw … 一行日記の原文保管。このベースラインを作った直後に
--   別作業で本番へ追加された（2026-09-12）。その作業側のマイグレーションで
--   管理されるべきものなので、ここには写さない。
--   ※本番のテーブル数を数えるときは、この2本を足した数になる。
