-- ============================================================================
-- DRAFT: 自治体カルテ（政令市20＋特別区23）のテーブル一式
-- 設計メモ: docs/municipality-chart-design.md（2026-09-19, Fable 5.1）
--
-- 適用は「本番変更の型」（実データ確認→Shadow→テスト→本番→Golden→rollback確認）に従う。
-- apply_migration はこのプロジェクトでは権限で通らないので、吉井さんが SQL Editor で
-- 手で流す（category-unification と同じ手順）。適用したらファイル名を日付付きに改名する。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 43団体のマスタ（手で育てる。Notion顧客CRMとは notion_page_id で緩く結ぶ）
-- ---------------------------------------------------------------------------
create table if not exists public.municipalities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                       -- 「豊島区」「横浜市」。lib/municipalities.ts と一致させる
  kind text not null check (kind in ('政令市','特別区')),
  prefecture text not null,
  population integer,                              -- 住基人口
  population_as_of date,                           -- 人口の時点（必須で埋める。時点の無い数字は載せない）
  mayor text,
  dx_department text,                              -- DX計画の主管課
  minutes_system text                              -- 会議録検索の系統
    check (minutes_system in ('kaigiroku','voiweb','dbsr','kensakusystem','discuss','other') or minutes_system is null),
  minutes_url text,                                -- 会議録検索の入口
  minutes_api_hint text,                           -- 機械検索の手がかり（kaigiroku: tenant=yokohama id=20 など）
  council_video_url text,                          -- 議会中継（録画）の入口
  adoption_status text not null default '未導入'
    check (adoption_status in ('未導入','検討中','トライアル','導入')),
  postal_center text,                              -- 郵送請求の集約センター有無・委託先
  research_priority smallint not null default 2    -- 1=アプローチ済み（先に調べる） 2=未アプローチ（後）
    check (research_priority in (1,2)),
  notion_page_id text,                             -- notion_organizations.notion_page_id への緩い参照
  memo text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. 計画文書（1団体に複数：DX推進計画・情報化計画・総合計画のDX章・行革プラン）
-- ---------------------------------------------------------------------------
create table if not exists public.municipality_plans (
  id uuid primary key default gen_random_uuid(),
  municipality text not null references public.municipalities(name) on update cascade,
  title text not null,
  plan_type text not null
    check (plan_type in ('DX推進計画','情報化計画','総合計画','行革・BPR','その他')),
  period_from smallint,                            -- 年度（西暦）
  period_to smallint,
  url text,                                        -- 公開URL（PDF直リンク優先）
  storage_path text,                               -- Supabase Storage に保存した原本PDF
  summary text,                                    -- 300字。提案に関係ある章だけ
  next_revision_year smallint,                     -- 改定予定年度（参謀の検知に使う）
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists municipality_plans_municipality_idx on public.municipality_plans (municipality);

-- ---------------------------------------------------------------------------
-- 3. 計画からのキーフレーズ抜粋（提案文にそのまま貼れる単位。原文は改変しない）
-- ---------------------------------------------------------------------------
create table if not exists public.municipality_plan_excerpts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.municipality_plans(id) on delete cascade,
  municipality text not null,                      -- 検索を速くするための非正規化（plan と一致させる）
  keyword text not null,                           -- docs/municipality-chart-design.md §3 のキーワード体系
  layer text not null default '近接'
    check (layer in ('直球','近接','文脈','KPI')),
  excerpt text not null,                           -- 原文そのまま
  page_no smallint,
  kpi_name text,
  kpi_target text,
  kpi_year smallint,
  usage_hint text,                                 -- 「この一文は提案書の○○で使う」1行
  created_at timestamptz not null default now()
);
create index if not exists municipality_plan_excerpts_municipality_idx on public.municipality_plan_excerpts (municipality);
create index if not exists municipality_plan_excerpts_keyword_idx on public.municipality_plan_excerpts (keyword);

-- ---------------------------------------------------------------------------
-- 4. 議会質問の履歴（1件＝1発言）
-- ---------------------------------------------------------------------------
create table if not exists public.council_questions (
  id uuid primary key default gen_random_uuid(),
  municipality text not null references public.municipalities(name) on update cascade,
  asked_on date not null,
  session text,                                    -- 「令和7年第4回定例会」
  meeting text,                                    -- 「本会議」「総務委員会」
  legislator_name text not null,
  party text,
  legislator_id uuid references public.legislators(id) on delete set null,
  question_summary text not null,
  answer_summary text,
  answered_by text,                                -- 「区民部長」
  keywords text[] not null default '{}',
  relevance text not null default '近接'
    check (relevance in ('直球','近接','参考')),   -- 直球=郵送請求・小為替・法人 / 近接=証明書オンライン・キャッシュレス / 参考=窓口DX一般
  figures text,                                    -- 答弁で出た数字（「郵送22,111枚・法人98%」）
  minutes_url text,
  video_url text,
  video_from text,                                 -- 「13:15」
  video_to text,                                   -- 「16:50」
  raw_excerpt text,                                -- 原文抜粋
  source text not null default 'script'
    check (source in ('script','manual')),
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (municipality, asked_on, legislator_name, meeting)
);
create index if not exists council_questions_municipality_idx on public.council_questions (municipality, asked_on desc);

-- ---------------------------------------------------------------------------
-- 5. 記憶層への写し用：source_type に 2値を追加
--    既存 CHECK を落として作り直す（月次報告を足したときと同じ手順）
-- ---------------------------------------------------------------------------
alter table public.memory_chunks drop constraint if exists memory_chunks_source_type_check;
alter table public.memory_chunks add constraint memory_chunks_source_type_check
  check (source_type = any (array['会議','日記','学び','PDF','その他','成果物','学会','振り返り','月次報告','週報','自治体計画','議会質問']::text[]));

-- ---------------------------------------------------------------------------
-- 6. RLS（他の読み取り専用マスタと同じ：anon は SELECT のみ。書き込みは service role）
-- ---------------------------------------------------------------------------
alter table public.municipalities enable row level security;
alter table public.municipality_plans enable row level security;
alter table public.municipality_plan_excerpts enable row level security;
alter table public.council_questions enable row level security;
create policy "anon read municipalities" on public.municipalities for select to anon using (true);
create policy "anon read municipality_plans" on public.municipality_plans for select to anon using (true);
create policy "anon read municipality_plan_excerpts" on public.municipality_plan_excerpts for select to anon using (true);
create policy "anon read council_questions" on public.council_questions for select to anon using (true);

-- ---------------------------------------------------------------------------
-- rollback（確認用。適用前に一度この順で戻せることを Shadow で確かめる）
-- ---------------------------------------------------------------------------
-- drop table public.council_questions;
-- drop table public.municipality_plan_excerpts;
-- drop table public.municipality_plans;
-- drop table public.municipalities;
-- alter table public.memory_chunks drop constraint memory_chunks_source_type_check;
-- alter table public.memory_chunks add constraint memory_chunks_source_type_check
--   check (source_type = any (array['会議','日記','学び','PDF','その他','成果物','学会','振り返り','月次報告','週報']::text[]));
