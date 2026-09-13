// AIワークOS 健康ダッシュボード: 日付範囲(from/to)を受け取り、
// health_range_summary(RPC)経由で health_metrics を日次サマリーの配列に整形して返す。
// health_daily_summary と同じソース優先順位ロジックを範囲版に拡張したもの（health_range_summary）を呼ぶだけ。
//
// health_metrics のRLSは authenticated ロール限定のため、フロントからの直接クエリはできない。
// 既存の org-history / search-memory と同じパターンで、ここは service role で読み、
// Next.js側 (/api/health) が anonキーでこの Function を叩く。
// 読み取り専用。ingest-health / health-notion-sync / health_metrics / health_daily_summary は変更しない。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400; // 誤って巨大範囲を投げられても暴走しないよう上限を設ける

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysUTC(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  try {
    const body = await req.json().catch(() => ({}));

    const to = typeof body.to === "string" && DAY_RE.test(body.to) ? body.to : todayUTC();
    const requestedFrom =
      typeof body.from === "string" && DAY_RE.test(body.from) ? body.from : addDaysUTC(to, -89);

    // from > to の取り違え対策と範囲上限のクランプ
    let from = requestedFrom > to ? to : requestedFrom;
    const earliestAllowed = addDaysUTC(to, -MAX_RANGE_DAYS);
    if (from < earliestAllowed) from = earliestAllowed;

    const { data, error } = await supabase.rpc("health_range_summary", {
      from_day: from,
      to_day: to,
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ from, to, days: data ?? [] }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
