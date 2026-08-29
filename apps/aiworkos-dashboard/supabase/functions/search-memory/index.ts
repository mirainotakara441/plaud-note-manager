// AIワークOS Phase 3: 自然言語クエリを埋め込み化し、memory_chunks を横断検索するRAGエンドポイント
//
// ■ 読む先は match_memory_chunks_v2（第7.8弾・2026-08-29〜）
// v2 は旧 match_memory_chunks に同一性の4列（canonical_document_id /
// source_document_id / chunk_index / ingest_scheme）を足しただけの互換版。
// 本文・ランキング・match_count の意味・dedupの有無はすべて旧と同じで、
// 本番データの200ベクトル×3200通り（54,437行）で旧9列の完全一致を確認済み。
// 旧関数は消していない。戻すときは rpc 名を1つ戻すだけでよい。
//
// ■ ただし外へ返すのは旧9列だけ（互換モード）
// 4列を下流へ公開するのは次のフェーズ。ここで応答の契約まで同時に変えると、
// 何か起きたときに「読む先を変えたせい」か「列を増やしたせい」かを
// 切り分けられなくなる。**偶然落ちているのではなく意図して落としている**ことを
// コードで示すため、V1_COMPAT_COLUMNS で明示的に projection する。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const model = new Supabase.ai.Session("gte-small");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * 外へ返す列。**旧 match_memory_chunks の返却列そのもの**で、順序も同じ。
 * v2 が返す同一性4列は、ここに無いので外へ出ない。
 * 下流に4列を出すと決めたら、このリストに足すのが唯一の入口。
 */
const V1_COMPAT_COLUMNS = [
  "id",
  "source_type",
  "source_id",
  "organization",
  "title",
  "content",
  "event_date",
  "metadata",
  "similarity",
] as const;

/** v2 の行から旧9列だけを取り出す。列の順序も旧に合わせる。 */
function toV1Compat(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of V1_COMPAT_COLUMNS) out[key] = row[key];
  return out;
}

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

    const { data, error } = await supabase.rpc("match_memory_chunks_v2", {
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

    // ★互換モード：v2 の13列から旧9列だけにして返す。
    //   ここを外すと応答の契約が変わる。外すのは意図して決めたときだけ。
    results = results.map((row: Record<string, unknown>) => toV1Compat(row));

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
