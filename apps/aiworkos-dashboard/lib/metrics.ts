// 実績数値（自治体数・事業者数・人口カバー率）の「正」を1枚に持たせた記録の取得。
// 類似度の順位に頼ると取りこぼす（通常のクエリでは共通資料120件中14位で、
// match_count を絞ると圏外に落ちる）ため、専用クエリで取ってプロンプト先頭に固定する。
// 実体は memory_chunks の source_id="metrics:共通:最新実績サマリ"（更新はそこへ上書き）。
// metadata.資料名 が "最新実績サマリ" のものを拾う。
//
// /agent と /weapons で同じ定数・ロジックが重複していたため一本化
// （2026-07-25 アーキテクチャレビュー P2対応）。

export const COMMON_ORG = "共通";
export const METRICS_QUERY = "最新実績サマリ 自治体トライアル 参加事業者 人口カバー率 団体数";

type MetricsRow = {
  metadata: Record<string, unknown> | null;
};

export async function fetchLatestMetrics<T extends MetricsRow>(
  supabaseUrl: string,
  anonKey: string
): Promise<T | null> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: METRICS_QUERY,
        source_type: "成果物",
        organization: COMMON_ORG,
        match_count: 5,
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows: T[] = Array.isArray(data?.results) ? data.results : [];
    return rows.find((r) => (r.metadata?.["資料名"] as string) === "最新実績サマリ") ?? null;
  } catch (err) {
    console.error("fetchLatestMetrics: search-memory呼び出し失敗", err);
    return null;
  }
}
