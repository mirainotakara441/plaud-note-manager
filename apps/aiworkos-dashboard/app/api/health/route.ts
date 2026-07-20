import { NextRequest, NextResponse } from "next/server";

// 健康ダッシュボード（/health）用プロキシ。
// health_metrics は authenticated ロール限定のRLSのため、フロントから直接は読めない。
// 既存の org-history / search-memory と同じパターンで、Supabase Edge Function
// (health-dashboard-data) を anon キーで叩き、Function内部の service role が
// health_range_summary(RPC) 経由で health_metrics を集計する。

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const payload: Record<string, string> = {};
  if (from && DAY_RE.test(from)) payload.from = from;
  if (to && DAY_RE.test(to)) payload.to = to;

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/health-dashboard-data`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("health-dashboard-data エラー:", res.status, text);
      return NextResponse.json(
        { error: "健康データの取得でエラーが発生しました。" },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("健康データプロキシエラー:", error);
    return NextResponse.json(
      { error: "健康データサービスに接続できませんでした" },
      { status: 502 }
    );
  }
}
