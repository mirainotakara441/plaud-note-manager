// 検索ログ（search_log）への書き込み。W3「生成ログの記録」の実装。
//
// ■ 使い方のルール
//   - fire-and-forget。await はするが、失敗しても呼び出し元へ投げない。
//     ログが書けないことを理由に検索そのものを失敗させない（本末転倒）。
//   - 書くのは「人の意図が乗った検索」だけ:
//       /api/search（人が画面から引く）→ source: "search"
//       /ask の道具 search_memory（AIが問いのために引く）→ source: "ask"
//     提案エージェントの定型取得（fetchDeliverables 等）は書かない。
//     クエリが機械的で分析価値が薄く、夜間仕込みで量だけ積むため。
//
// ■ 何に使うか
//   - 次の検索改善（重み調整・チャンク切り直し）の Golden を、発明したクエリでなく
//     実クエリから作る
//   - 「探したのに見つからない」（件数0・上位の類似度が低い）＝記憶層の穴の検出。
//     夜間参謀の材料に加える入口（まだ加えていない。溜まってから判断する）

import { restHeaders, type Creds } from "@/lib/supabase";

type ResultRow = {
  id?: unknown;
  source_type?: unknown;
  title?: unknown;
  similarity?: unknown;
};

export async function logSearch(
  creds: Creds,
  entry: {
    source: "search" | "ask";
    query: string;
    filters: Record<string, unknown>;
    results: ResultRow[];
    ms: number;
  }
): Promise<void> {
  try {
    // filters は指定されたものだけ残す（null/undefined を落とす）。
    const filters: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.filters)) {
      if (v !== null && v !== undefined && v !== "") filters[k] = v;
    }
    const top = entry.results.slice(0, 5).map((r) => ({
      id: r.id,
      source_type: r.source_type,
      title: typeof r.title === "string" ? r.title.slice(0, 80) : null,
      similarity:
        typeof r.similarity === "number" ? Number(r.similarity.toFixed(3)) : null,
    }));
    await fetch(`${creds.url}/rest/v1/search_log`, {
      method: "POST",
      headers: restHeaders(creds.key, { Prefer: "return=minimal" }),
      body: JSON.stringify({
        source: entry.source,
        query: entry.query.slice(0, 500),
        filters,
        result_count: entry.results.length,
        top,
        ms: entry.ms,
      }),
    });
  } catch (err) {
    // 検索本体を巻き込まない。静かに残す。
    console.error("search_log: 書き込み失敗（検索自体は成功している）", err);
  }
}
