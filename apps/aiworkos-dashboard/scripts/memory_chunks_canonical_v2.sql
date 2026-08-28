-- ============================================================================
-- Memory 2.0 最小migration（第5弾）
--   memory_chunks に同一性のための4列を追加し、既存1458行をバックフィルする。
--
-- 方針:
--   既存の読み書き動作を一切変えず、新しい4列を横に足すだけ。
--   既存列・source_id・content・embedding・metadata には一切書き込まない。
--   NOT NULL / UNIQUE / RLS は付けない。取り込み処理もAPIも変更しない。
--
-- 列の責務（第4.3弾で確定）:
--   canonical_document_id … 実体（1本の録音・1つのファイル）。移行時に凍結し、
--                           organization や title を直しても再計算しない
--   source_document_id    … 取り込み文書＝版。source_id からチャンク部分だけ外したもの
--   chunk_index           … その「版」の中での並び（0起点）。ページ番号ではない
--                           （ページの素性は metadata.位置 が持ち続ける）
--   ingest_scheme         … どの規則で canonical を確定させたか（経路の羅列ではない）
--   （既存）source_id     … 行ID。削除・入れ直しの鍵。役割は変えない
--
-- 実行方法:
--   psql "$DATABASE_URL" --single-transaction -f scripts/memory_chunks_canonical_v2.sql
--   （Supabase MCP から流す場合も、必ず単一トランザクションで実行すること）
--   末尾の DO ブロックが検証を兼ねており、1つでも条件を外すと例外で全体がロールバックする。
--
-- rollback:
--   drop index if exists memory_chunks_canonical_idx;
--   alter table public.memory_chunks
--     drop column if exists canonical_document_id,
--     drop column if exists source_document_id,
--     drop column if exists chunk_index,
--     drop column if exists ingest_scheme;
--   既存列に一度も書き込まないため、列を落とすだけで完全に元の状態へ戻る。
-- ============================================================================

alter table public.memory_chunks
  add column if not exists canonical_document_id text,
  add column if not exists source_document_id    text,
  add column if not exists chunk_index           integer,
  add column if not exists ingest_scheme         text;

with src as (
  select id, source_id, title, metadata,
         regexp_replace(source_id, '#[0-9]+$', '')                                 as sid,
         lower(nullif(coalesce(metadata->>'PLAUD_ID', metadata->>'plaud_id'), '')) as plaud,
         metadata->>'位置'                                                          as pos
    from public.memory_chunks
),
ruled as (
  -- どの規則で canonical を決めるか。14経路を6つに畳む
  select src.*,
         case
           when plaud is not null or sid like 'plaud:%' or sid ~ '^[0-9a-f]{32}$'            then 'plaud'
           when sid ~ '^https?://'                                                           then 'notion'
           when sid like 'meeting:%'                                                         then 'meeting'
           when sid like 'deliverable:%'                                                     then 'deliverable'
           when sid ~ '^(weekly_report|retrospective|refine|slide-refine|procedure-refine):' then 'internal'
           when sid ~ '^(qa|weapon|gakkai|metrics):'                                         then 'catalog'
         end as scheme
    from src
),
keyed as (
  select ruled.*,
         -- 版＝取り込み文書。source_id からチャンク部分だけを外す。
         -- deliverable は正規表現を使わず metadata.位置 との文字列一致で外す
         -- （ファイル名にコロンや数字が入る実データがあり、正規表現だと削り過ぎる）
         case scheme
           when 'deliverable' then case when pos is not null and sid like '%:' || pos
                                        then left(sid, length(sid) - length(pos) - 1)
                                        else sid end
           when 'meeting'  then regexp_replace(sid, ':[0-9]+$', '')
           when 'internal' then regexp_replace(sid, ':[0-9]+$', '')
           when 'catalog'  then regexp_replace(sid, ':[0-9]+$', '')
           else sid
         end as sdid,
         -- 明示的なチャンク番号（1起点で拾う）
         coalesce(
           nullif(substring(source_id from '#([0-9]+)$'),      '')::int,  -- 復元スクリプトの #N
           nullif(substring(title     from '｜([0-9]+)$'),      '')::int,  -- タイトル末尾の ｜N
           nullif(substring(pos       from '^([0-9]+)/[0-9]+$'),'')::int,  -- 位置の i/n の分子
           nullif(substring(sid       from ':([0-9]+)$'),      '')::int   -- source_id 末尾の :N
         ) as n_explicit,
         nullif(substring(pos from '^[a-z]+([0-9]+)'), '')::int                      as pos_major,
         coalesce(nullif(substring(pos from '^[a-z]+[0-9]+-([0-9]+)$'), '')::int, 0) as pos_minor
    from ruled
),
final as (
  select keyed.*,
         -- 実体。版のキーに、PLAUD_ID / NotionページID による束ねだけを上書きとして重ねる
         case scheme
           when 'plaud'  then 'plaud:'  || coalesce(plaud,
                                                    lower(nullif(split_part(sid, ':', 2), '')),
                                                    lower(substring(sid from '^[0-9a-f]{32}')))
           when 'notion' then 'notion:' || lower(substring(sid from '([0-9a-f]{32})$'))
           else sdid
         end as cdid,
         -- ★ partition は canonical ではなく「版」。別版のチャンクを一列に混ぜない。
         --   明示番号が無く 位置 も無い行は 0 に固定する。通し番号で埋めると
         --   別版どうしが 0,1 と並んで衝突が消えて見えるため。
         coalesce(
           n_explicit - 1,
           case when pos_major is not null
                then (row_number() over (partition by sdid
                                         order by pos_major, pos_minor, id))::int - 1
           end,
           0
         ) as cidx
    from keyed
)
update public.memory_chunks m
   set canonical_document_id = f.cdid,
       source_document_id    = f.sdid,
       chunk_index           = f.cidx,
       ingest_scheme         = f.scheme
  from final f
 where m.id = f.id;

-- 埋めてから張る（先に張ると UPDATE で index が膨らむ）。UNIQUE は付けない。
create index if not exists memory_chunks_canonical_idx
    on public.memory_chunks (canonical_document_id, source_document_id, chunk_index);

-- ============================================================================
-- 検証。1つでも外れたら例外を投げてトランザクション全体をロールバックする。
-- ============================================================================
do $$
declare
  v_total      bigint;
  v_c_null     bigint;
  v_s_null     bigint;
  v_i_null     bigint;
  v_g_null     bigint;
  v_canonicals bigint;
  v_variants   bigint;
  v_schemes    bigint;
  v_dup_sdid   bigint;
  v_dup_cdid   bigint;
  v_fp         record;
begin
  select count(*),
         count(*) filter (where canonical_document_id is null),
         count(*) filter (where source_document_id    is null),
         count(*) filter (where chunk_index           is null),
         count(*) filter (where ingest_scheme         is null),
         count(distinct canonical_document_id),
         count(distinct source_document_id),
         count(distinct ingest_scheme)
    into v_total, v_c_null, v_s_null, v_i_null, v_g_null,
         v_canonicals, v_variants, v_schemes
    from public.memory_chunks;

  if v_total      <> 1458 then raise exception '総行数が想定外: %', v_total; end if;
  if v_c_null     <> 0    then raise exception 'canonical_document_id が null: % 行', v_c_null; end if;
  if v_s_null     <> 0    then raise exception 'source_document_id が null: % 行', v_s_null; end if;
  if v_i_null     <> 0    then raise exception 'chunk_index が null: % 行', v_i_null; end if;
  if v_g_null     <> 0    then raise exception 'ingest_scheme が null: % 行', v_g_null; end if;
  if v_canonicals <> 553  then raise exception 'canonical文書数が想定外: %', v_canonicals; end if;
  if v_variants   <> 557  then raise exception '取り込み文書数が想定外: %', v_variants; end if;
  if v_schemes    <> 6    then raise exception 'ingest_scheme の種類数が想定外: %', v_schemes; end if;

  -- 版の中で chunk_index が重複してはならない
  select count(*) into v_dup_sdid from (
    select 1 from public.memory_chunks
     group by source_document_id, chunk_index having count(*) > 1) z;
  if v_dup_sdid <> 0 then
    raise exception '(source_document_id, chunk_index) の重複が % 件', v_dup_sdid;
  end if;

  -- canonical 側の重複は「既知の3録音だけ」。件数ではなく実体IDまで一致を見る
  select count(*) into v_dup_cdid from (
    select 1 from public.memory_chunks
     group by canonical_document_id, chunk_index having count(*) > 1) z;
  if v_dup_cdid <> 3 then
    raise exception 'canonical側の重複が % 件（既知は3件）', v_dup_cdid;
  end if;

  if exists (
    select 1 from public.memory_chunks
     group by canonical_document_id, chunk_index
    having count(*) > 1
       and canonical_document_id not in (
             'plaud:36dba3aa883b02b799a6a9e4e6b8bd43',
             'plaud:8da2d2ce625804aedbfa8dd2e5193e35',
             'plaud:b08f952edde1234412b51c23b51af665')
  ) then
    raise exception 'canonical側の重複IDが既知の3録音と違う';
  end if;

  -- 既存列が1文字も変わっていないこと（migration前に採取した指紋と照合）
  select md5(string_agg(md5(content),                 '' order by id)) as content,
         md5(string_agg(source_id,                    '' order by id)) as source_id,
         md5(string_agg(source_type,                  '' order by id)) as source_type,
         md5(string_agg(title,                        '' order by id)) as title,
         md5(string_agg(coalesce(organization,'~'),   '' order by id)) as organization,
         md5(string_agg(coalesce(event_date::text,'~'),'' order by id)) as event_date,
         md5(string_agg(coalesce(metadata::text,'~'), '' order by id)) as metadata,
         count(*) filter (where embedding is not null)                 as with_embedding
    into v_fp
    from public.memory_chunks;

  if v_fp.content      <> 'fb8066db5ab956b87aa3f2d4180cef41' then raise exception 'content が変化した'; end if;
  if v_fp.source_id    <> 'c86ff37f02f639c1c7c05012beaf3c7f' then raise exception 'source_id が変化した'; end if;
  if v_fp.source_type  <> '3a58448d4887bc4551409357dc5e79a7' then raise exception 'source_type が変化した'; end if;
  if v_fp.title        <> '867963456bc50f453bd338b9e0c8efca' then raise exception 'title が変化した'; end if;
  if v_fp.organization <> '193aaad81f2928700e249d31633930ed' then raise exception 'organization が変化した'; end if;
  if v_fp.event_date   <> '35ad667431d9cab77e5bc633f8d8f994' then raise exception 'event_date が変化した'; end if;
  if v_fp.metadata     <> '7073e941882634263f78a88c4176f737' then raise exception 'metadata が変化した'; end if;
  if v_fp.with_embedding <> 1458 then raise exception 'embedding の本数が変化した: %', v_fp.with_embedding; end if;

  raise notice 'OK: 1458行 / canonical %件 / 取り込み文書 %件 / scheme %種 / 版の衝突0 / 実体の衝突3（既知）',
               v_canonicals, v_variants, v_schemes;
end $$;
