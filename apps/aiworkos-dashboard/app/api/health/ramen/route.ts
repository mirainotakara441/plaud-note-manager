import { NextRequest, NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// /health からラーメンの記録を「読むだけ」のためのAPI。
//
// ramen_logs は /ramen 側で完成している別系統の仕組みなので、ここからは絶対に書かない。
// そのため:
//   - GET しか export しない（POST/PUT/PATCH/DELETE は存在しないので405になる）
//   - service role キーではなく anon キーを使う（ramen_logs は anon にSELECTだけ許可。
//     書き込みポリシーが無いので、キーの取り違えがあっても書き込みようが無い）
//
// 返すのは「その日ラーメンを食べたか」を出すのに必要な最小限の列だけ。

export const dynamic = "force-dynamic";

const TABLE = "ramen_logs";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const params = [
    "select=eaten_on,shop,menu,score",
    // is_ramen=false の行（ラーメン以外の外食メモ）は健康との対比には混ぜない
    "is_ramen=is.true",
    "order=eaten_on.asc",
    "limit=2000",
  ];
  if (from && DAY_RE.test(from)) params.push(`eaten_on=gte.${from}`);
  if (to && DAY_RE.test(to)) params.push(`eaten_on=lte.${to}`);

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.join("&")}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("ラーメン記録の取得に失敗:", res.status, t.slice(0, 200));
    // ラーメンは補助表示なので、取れなくても /health 本体は出したい
    return NextResponse.json({ logs: [] });
  }
  const rows: { eaten_on: string; shop: string | null; menu: string | null; score: number | null }[] =
    await res.json();

  return NextResponse.json({ logs: Array.isArray(rows) ? rows : [] });
}
