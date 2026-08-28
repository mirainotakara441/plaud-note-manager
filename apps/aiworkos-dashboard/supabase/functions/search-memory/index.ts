// AIワークOS Phase 3: 自然言語クエリを埋め込み化し、memory_chunks を横断検索するRAGエンドポイント
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const model = new Supabase.ai.Session("gte-small");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const { query, source_type, organization, match_count, person, theme } = await req.json();
    if (!query || typeof query !== "string") {
      return new Response(JSON.stringify({ error: "query (string) is required" }), { status: 400 });
    }

    const embedding = await model.run(query, { mean_pool: true, normalize: true });
    const requestedCount = match_count ?? 8;
    const hasMetadataFilter = Boolean(person) || Boolean(theme);
    // 人物/テーマはmetadata jsonb内のみに存在しRPCの列フィルタでは絞れないため、
    // フィルタが指定された場合はRPCから広めに取得してからここで絞り込む。
    const fetchCount = hasMetadataFilter ? Math.max(requestedCount * 5, 40) : requestedCount;

    const { data, error } = await supabase.rpc("match_memory_chunks", {
      query_embedding: embedding,
      match_count: fetchCount,
      filter_source_type: source_type ?? null,
      filter_organization: organization ?? null,
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    let results = data ?? [];
    if (person) {
      results = results.filter((row: { metadata?: Record<string, unknown> }) =>
        Array.isArray(row.metadata?.["人物"]) && (row.metadata!["人物"] as string[]).includes(person)
      );
    }
    if (theme) {
      results = results.filter((row: { metadata?: Record<string, unknown> }) =>
        Array.isArray(row.metadata?.["テーマ"]) && (row.metadata!["テーマ"] as string[]).includes(theme)
      );
    }
    results = results.slice(0, requestedCount);

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
