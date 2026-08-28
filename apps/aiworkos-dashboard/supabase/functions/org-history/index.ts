// AIワークOS ②提案エージェント: 自治体を指定すると会議履歴を時系列で返すエンドポイント。
// organizationを省略すると、会議データを持つ自治体一覧（件数付き）を返す。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// タイトル末尾のチャンク接尾辞を落とす規則。**ここには書き写さない。**
// 以前はこのファイルに `/｜\d+\/\d+$/` を1回かけるだけの実装を持っていたが、
// アプリ側（lib/organizations.ts）だけが他形式まで落とすよう育ち、食い違った。
// 本番の会議287行に ｜n/m は0行しか無く、ここは実データを1行も剥がせていなかった
// ——札幌市が「会議6件」（実際2件）と表示されていた原因がこれ。
import { stripChunkSuffix } from "../_shared/chunkTitle.mjs";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const organization =
      typeof body.organization === "string" ? body.organization.trim() : "";

    // 一覧モード: organizationが無ければ、会議データを持つ自治体一覧を返す
    if (!organization) {
      const { data, error } = await supabase
        .from("memory_chunks")
        .select("organization, title, event_date")
        .eq("source_type", "会議")
        .not("organization", "is", null);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
      // 「会議1件」はチャンク1行ではなく、タイトル（チャンク番号除去）＋実施日の組で数える。
      // event_dateが無い行はどの会議か特定できないため数えない（元々ゼロ件だが念のため）。
      const seen: Record<string, Set<string>> = {};
      for (const row of data ?? []) {
        const org = (row as { organization: string }).organization;
        const title = (row as { title: string }).title ?? "";
        const date = (row as { event_date: string | null }).event_date;
        if (!date) continue;
        const key = `${stripChunkSuffix(title)}__${date}`;
        if (!seen[org]) seen[org] = new Set<string>();
        seen[org].add(key);
      }
      const organizations = Object.entries(seen)
        .map(([name, keys]) => ({ name, count: keys.size }))
        .sort((a, b) => b.count - a.count);
      return new Response(JSON.stringify({ organizations }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 履歴モード: 指定自治体の会議を時系列（古い→新しい）で返す（チャンク単位のまま。
    // 呼び出し側（lib/organizations.ts の groupMeetings）で同じ規則により束ねる）。
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id, source_type, title, content, event_date, metadata, organization")
      .eq("organization", organization)
      .eq("source_type", "会議")
      .order("event_date", { ascending: true });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    return new Response(JSON.stringify({ meetings: data ?? [] }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
