-- =====================================================================
-- ハイブリッド検索の Shadow（match_memory_chunks_v3）
-- W3「検索精度の底上げ」の積み残し（ベクトル＋全文）への着手
-- =====================================================================
--
-- ■ これは何か
--   ベクトル検索（現行 v2）に日本語全文検索（pgroonga）を重ねた v3 を、
--   **並走用として追加するだけ**のマイグレーション。
--   search-memory（本番の読み口）は v2 のまま。1行も変えない。
--   v3 が v2 より良いかは scripts/shadow-hybrid-search.mjs の実測で判断し、
--   良ければ別のマイグレーション＋production-change-protocol の関門
--   （Golden 突合）を経てから切り替える。実測前に切り替えない。
--
-- ■ なぜ tsvector ではなく pgroonga か
--   scorecard の宿題には「tsvector」と書かれていたが、Postgres 標準の
--   tsvector は日本語を分かち書きできない（'simple' はスペース区切り前提で、
--   日本語文は1トークンの塊になる）。pgroonga は Groonga ベースで
--   日本語をN-gramで索引でき、Supabase で公式提供されている。
--
-- ■ なぜハイブリッドが要るか（実測の根拠）
--   gte-small のベクトル検索は「意味の近さ」には強いが、
--   「アイフル」「内本部長」のような固有名詞の完全一致が上位に来ない
--   ことがある（短い固有名詞は埋め込み空間で潰れやすい）。
--   /ask のツール定義にも「1回で core が引けなくても言い換えて引き直せ」と
--   書かざるを得なかった——それは検索側の弱さの裏返し。
--
-- ■ 融合方式: RRF（Reciprocal Rank Fusion, k=60）
--   ベクトル順位と全文順位それぞれの逆数を足すだけの、パラメータ調整が
--   ほぼ要らない定番。スコアの尺度が違う2系（コサイン類似度と Groonga スコア）を
--   正規化せずに混ぜられるのが利点。
--
-- ■ rollback
--   DROP FUNCTION public.match_memory_chunks_v3(vector, text, integer, text, text);
--   DROP INDEX public.memory_chunks_pgroonga_idx;
--   （拡張は他で使い始める可能性があるので残してよい。消すなら
--     DROP EXTENSION pgroonga; も可。v2 とその索引には一切触れていない）
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA extensions;

-- title と content をまとめて1本の全文索引に。store-memory の埋め込み対象が
-- 「title\n\ncontent」なのと同じ考え方（title にしか無い固有名詞を取りこぼさない）。
-- 1,600行なので構築は一瞬。行が増えても upsert 追随は pgroonga が持つ。
CREATE INDEX IF NOT EXISTS memory_chunks_pgroonga_idx
  ON public.memory_chunks
  USING pgroonga ((title || ' ' || content));

-- ★hnsw の GUC を持つ関数を作る前に vector 演算子を1回使う。
--   未ロードのセッションでは拡張GUCが仮置き扱いになり、
--   permission denied to set parameter で落ちる（rag_iterative_scan.sql で踏んだ罠）。
SELECT ('[1,0]'::vector <=> '[0,1]'::vector);

-- v3: ベクトル上位40 と 全文上位40 を RRF で融合して match_count 件返す。
-- 返却列は v2 の13列そのまま＋診断3列（rrf / vec_rank / text_rank）。
-- 診断列は Shadow 比較のためのもので、昇格時に search-memory 側が捨てればよい。
CREATE OR REPLACE FUNCTION public.match_memory_chunks_v3(
  query_embedding vector,
  query_text text,
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
   ingest_scheme text,
   rrf double precision,
   vec_rank integer,
   text_rank integer
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
 SET hnsw.iterative_scan = 'strict_order'
AS $function$
  with vec as (
    -- ベクトル側。where と並べ替え式は v2 と同一（strict_order も同じ）。
    -- 40 は hnsw.ef_search=40 に合わせた候補幅。
    -- 距離を持ち出して外側で明示的に順位化する（サブクエリの並びが
    -- 保存される保証に依存しない）。
    select s.id,
           row_number() over (order by s.dist) as r
    from (
      select mc.id, mc.embedding <=> query_embedding as dist
      from public.memory_chunks mc
      where mc.embedding is not null
        and (filter_source_type is null or mc.source_type = filter_source_type)
        and (filter_organization is null or mc.organization = filter_organization)
      order by mc.embedding <=> query_embedding
      limit 40
    ) s
  ),
  txt as (
    -- 全文側。pgroonga_query_escape でクエリ構文の特殊文字を無害化
    -- （利用者の入力がそのまま来るため。& や ( で構文エラーにしない）。
    select s.id,
           row_number() over (order by s.score desc) as r
    from (
      select mc.id, pgroonga_score(mc.tableoid, mc.ctid) as score
      from public.memory_chunks mc
      where (mc.title || ' ' || mc.content) &@~ pgroonga_query_escape(query_text)
        and (filter_source_type is null or mc.source_type = filter_source_type)
        and (filter_organization is null or mc.organization = filter_organization)
      order by pgroonga_score(mc.tableoid, mc.ctid) desc
      limit 40
    ) s
  ),
  fused as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) as rrf,
           v.r as vec_rank,
           t.r as text_rank
    from vec v
    full outer join txt t using (id)
  )
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
    mc.ingest_scheme,
    f.rrf,
    f.vec_rank::integer,
    f.text_rank::integer
  from fused f
  join public.memory_chunks mc on mc.id = f.id
  order by f.rrf desc, mc.id
  limit match_count;
$function$;

-- v2 と同じ理由で service_role だけに閉じる。
-- FROM PUBLIC だけでは足りない——Supabase の ALTER DEFAULT PRIVILEGES が
-- anon / authenticated に EXECUTE を個別付与するので名指しで外す（v2 で実証済みの罠）。
REVOKE ALL ON FUNCTION public.match_memory_chunks_v3(vector, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_memory_chunks_v3(vector, text, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.match_memory_chunks_v3(vector, text, integer, text, text) FROM authenticated;

COMMENT ON FUNCTION public.match_memory_chunks_v3(vector, text, integer, text, text) IS
  'ハイブリッド検索のShadow（ベクトル+pgroonga全文のRRF融合）。本番の読み口(search-memory)は v2 のまま。'
  '実測比較は scripts/shadow-hybrid-search.mjs。良ければ関門を経て昇格、悪ければ rollback 手順でDROP。';
