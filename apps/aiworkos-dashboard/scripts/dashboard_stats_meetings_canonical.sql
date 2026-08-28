-- dashboard_stats() の会議件数を、チャンク数から実体数（canonical_document_id）に直す。
--
-- ■ 何が起きていたか
-- /status の団体一覧が「八王子市 会議27」と出すのに、/organizations は「2件」。
-- 同じ会議が26チャンクに分かれていて、こちらは count(*) のままだった。
-- 2026-08-26 に org-history 側だけ直し、この関数は取り残されていた。
--
--   八王子市 27→2   新宿区 26→4   墨田区 21→2   事業者対策 19→1
--   練馬区   15→1   横浜市 12→7   札幌市  6→2   豊島区      10→7
--   （食い違っていたのは18団体）
--
-- ■ なぜ canonical_document_id で数えるか
-- タイトルの接尾辞を剥がす方式（アプリ側 stripChunkSuffix）と結果が一致することを
-- 本番で確認済み——会議の全団体で差ゼロ。SQL に接尾辞の正規表現を書き写すと
-- 3つ目の実装になり、また食い違う。列で数えれば実装は増えない。
--
-- ■ 前提の確認（2026-08-29 実測）
-- source_type='会議' に event_date が NULL の行は 0 行。よって
-- /organizations 側（日付なしを数えない）との差は生まれない。
--
-- 変更したのは 'meetings' の1行だけ。他は現行定義のまま。

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
