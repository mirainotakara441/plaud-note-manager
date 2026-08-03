// 検知器からSupabaseを読むための最小のヘルパー。
//
// 検知器は読むだけで、絶対に書かない。参謀は「気づいたことを言う」役であって、
// 勝手に直す役ではない（何を直すかは吉井さんが決める）。
//
// health_metrics などRLSが authenticated 限定のテーブルも読むため、
// 呼び出し側は service role の資格情報を渡す。ブラウザには出さない。

import { restHeaders } from "@/lib/supabase";
import type { Ctx } from "./types";

/** PostgREST から行を取る。失敗は例外にして、呼び出し元（検知器）ごとに握り潰す。 */
export async function getRows<T>(ctx: Ctx, pathAndQuery: string): Promise<T[]> {
  const res = await fetch(`${ctx.creds.url}/rest/v1/${pathAndQuery}`, {
    headers: restHeaders(ctx.creds.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const table = pathAndQuery.split("?")[0];
    throw new Error(`${table} の取得に失敗 (${res.status}) ${detail.slice(0, 120)}`);
  }
  return (await res.json()) as T[];
}

/** RPC（集計関数）を呼ぶ。health_range_summary のような読み取り専用の関数だけに使う。 */
export async function callRpc<T>(
  ctx: Ctx,
  fn: string,
  args: Record<string, unknown>
): Promise<T[]> {
  const res = await fetch(`${ctx.creds.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: restHeaders(ctx.creds.key),
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${fn} の呼び出しに失敗 (${res.status}) ${detail.slice(0, 120)}`);
  }
  return (await res.json()) as T[];
}
