-- 法人請求QA 外部公開サイト（/qa-open）の来訪者・アクセス記録・修正案
create table if not exists public.qa_open_visitors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  org text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  visits integer not null default 0
);
create table if not exists public.qa_open_access_log (
  id bigserial primary key,
  visitor_id uuid not null references public.qa_open_visitors(id) on delete cascade,
  at timestamptz not null default now(),
  path text,
  user_agent text
);
create index if not exists qa_open_access_log_visitor_idx on public.qa_open_access_log(visitor_id, at desc);
create table if not exists public.qa_open_feedback (
  id bigserial primary key,
  visitor_id uuid not null references public.qa_open_visitors(id) on delete cascade,
  item_id text,
  kind text not null default '修正案',
  message text not null,
  status text not null default '未対応',
  created_at timestamptz not null default now()
);
create index if not exists qa_open_feedback_created_idx on public.qa_open_feedback(created_at desc);
alter table public.qa_open_visitors enable row level security;
alter table public.qa_open_access_log enable row level security;
alter table public.qa_open_feedback enable row level security;
-- anon には一切のポリシーを付けない（service role からのみ読み書き）
