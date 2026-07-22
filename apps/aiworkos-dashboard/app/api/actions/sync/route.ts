import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// 一行日記(Supabase memory_chunks)の「やってみよう」を daily_actions へ取り込む。
// 抽出・重複防止・INSERT は Postgres 関数 import_diary_actions(lookback_days) が一括で行う
// （Notionトークン不要。既に取り込み済みの日記=source_id はスキップするので何度押しても安全）。
// RPC呼び出しは書き込みを伴うため service role キーで行う。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  }
  const body = await req.json().catch(() => ({}));
  const lookback = Number.isFinite(body?.lookback_days) ? body.lookback_days : 30;

  const res = await fetch(`${c.url}/rest/v1/rpc/import_diary_actions`, {
    method: "POST",
    headers: restHeaders(c.key),
    body: JSON.stringify({ lookback_days: lookback }),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `取込失敗 ${res.status}: ${t}` }, { status: 502 });
  }
  const added = await res.json(); // 関数は int を返す
  return NextResponse.json({ added: typeof added === "number" ? added : 0, lookback });
}
