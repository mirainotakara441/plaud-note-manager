import { NextResponse } from "next/server";

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/org-history`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("org-history 一覧エラー:", res.status, text);
      return NextResponse.json(
        { error: "自治体一覧の取得でエラーが発生しました。" },
        { status: 502 }
      );
    }

    const data = await res.json();
    const organizations = Array.isArray(data?.organizations)
      ? data.organizations
      : [];
    return NextResponse.json({ organizations });
  } catch (error) {
    console.error("自治体一覧プロキシエラー:", error);
    return NextResponse.json(
      { error: "自治体一覧サービスに接続できませんでした" },
      { status: 502 }
    );
  }
}
