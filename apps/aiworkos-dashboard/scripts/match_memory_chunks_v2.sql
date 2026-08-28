-- match_memory_chunks_v2 ── 同一性4列を返す「旧RAG互換版」。
--
-- ■ 目的（第7.6弾後半）
-- 旧 match_memory_chunks はそのまま残し、返却列に同一性の4列を足しただけの
-- 双子を並走させる。読み側を canonical に寄せる前に、まず「Identity付きの
-- 旧RAG互換版」を作って、旧との差がゼロであることを確かめるのが目的。
--
-- ■ ここでは絶対にやらないこと
--   ・document 単位への畳み込み（dedup）。canonical を返すからといって畳まない
--   ・ランキングの変更。検索単位は chunk のまま、順位は chunk の similarity のまま
--   ・match_count の意味の変更。chunk 件数のまま
-- v2 は「列が4本増えただけ」であること。それ以外の差が出たら切替に進まない。
--
-- ■ 旧関数と1文字でも変えてはいけない箇所
--   ・LANGUAGE sql / STABLE / SET search_path TO 'public','extensions'
--   ・where 句（embedding is not null ＋ 2つのフィルタ）
--   ・order by mc.embedding <=> query_embedding（並べ替え式）
--   ・limit match_count
--   ・similarity の式 1 - (mc.embedding <=> query_embedding)
-- 並べ替えに tiebreaker を足したくなるが、**足さない**。旧と順位が変わるため。
-- 同一 embedding は本番で0組なので、そもそも同点は起きない（2026-08-29実測）。
--
-- ■ 近似検索であることの確認（2026-08-29）
-- memory_chunks_embedding_idx は hnsw (embedding vector_cosine_ops)。
-- EXPLAIN で Index Scan using memory_chunks_embedding_idx が出る＝**旧RAGは
-- 既に近似検索**。hnsw.ef_search=40 / iterative_scan=off。
-- v2 も同じ本文なので同じ計画に乗るはずだが、それは実測で確かめる（Step 3）。
-- ef_search=40 で filter を掛けると、候補40件から絞るので match_count に
-- 満たない件数しか返らないことがある。これは旧の挙動であり、v2 も同じでよい。
--
-- ■ 返却列の並び
-- 旧の9列をそのままの順序で先頭に置き、4列を末尾に足す。
-- select * の呼び出し側で列位置がずれないようにするため。
--
-- ■ 権限
-- 旧は PUBLIC / anon / authenticated にも EXECUTE があるが、v2 は
-- **service_role だけ**にする。まだユーザー向けの経路に出さないため。
-- CREATE FUNCTION は既定で PUBLIC に EXECUTE を与えるので、明示的に REVOKE する。

CREATE OR REPLACE FUNCTION public.match_memory_chunks_v2(
  query_embedding vector,
  match_count integer DEFAULT 8,
  filter_source_type text DEFAULT NULL::text,
  filter_organization text DEFAULT NULL::text
)
 RETURNS TABLE(
   id uuid,
   source_type text,
   source_id text,
   organization text,
   title text,
   content text,
   event_date date,
   metadata jsonb,
   similarity double precision,
   canonical_document_id text,
   source_document_id text,
   chunk_index integer,
   ingest_scheme text
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
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

REVOKE ALL ON FUNCTION public.match_memory_chunks_v2(vector, integer, text, text) FROM PUBLIC;
-- ★FROM PUBLIC だけでは足りない。Supabase の ALTER DEFAULT PRIVILEGES が
--   anon / authenticated に EXECUTE を**個別付与**するので、名指しで外す。
--   （実際 FROM PUBLIC だけ流したら anon が実行できる状態で残った）
REVOKE ALL ON FUNCTION public.match_memory_chunks_v2(vector, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.match_memory_chunks_v2(vector, integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.match_memory_chunks_v2(vector, integer, text, text) TO service_role;

COMMENT ON FUNCTION public.match_memory_chunks_v2(vector, integer, text, text) IS
  'match_memory_chunks に同一性4列を足しただけの互換版（第7.6弾）。ランキング・match_countの意味・dedupの有無はすべて旧と同じ。まだ search-memory からは呼ばれていない。';
