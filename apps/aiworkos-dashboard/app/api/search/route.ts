import { NextRequest, NextResponse } from "next/server";

// memory_chunks.source_type の CHECK制約と一致させること。
// ここに無い値が来ると source_type がpayloadに載らず、フィルタが「黙って無視」される
// （エラーにならないので、UIでは絞り込んだつもりなのに全件から検索されてしまう）。
// 2026-07-30まで ["日記","会議","学び"] しか無く、検索UIが出していた`成果物`(246件)と
// `学会`(10件) の絞り込みが効いていなかった。
const VALID_SOURCE_TYPES = ["日記", "会議", "学び", "成果物", "学会", "PDF", "その他"];

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  let body: {
    query?: unknown;
    source_type?: unknown;
    match_count?: unknown;
    person?: unknown;
    theme?: unknown;
  };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/search: リクエストJSON解析失敗", err);
    return NextResponse.json(
      { error: "リクエストの形式が不正です" },
      { status: 400 }
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { error: "検索キーワードを入力してください" },
      { status: 400 }
    );
  }

  const payload: Record<string, unknown> = { query };

  if (
    typeof body.source_type === "string" &&
    VALID_SOURCE_TYPES.includes(body.source_type)
  ) {
    payload.source_type = body.source_type;
  }

  const matchCount = Number(body.match_count);
  if (Number.isInteger(matchCount) && matchCount >= 1 && matchCount <= 50) {
    payload.match_count = matchCount;
  }

  if (typeof body.person === "string" && body.person.trim()) {
    payload.person = body.person.trim();
  }

  if (typeof body.theme === "string" && body.theme.trim()) {
    payload.theme = body.theme.trim();
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
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
      console.error("search-memory エラー:", res.status, text);
      return NextResponse.json(
        { error: "検索サービスでエラーが発生しました。しばらくしてから再度お試しください。" },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("検索プロキシエラー:", error);
    return NextResponse.json(
      { error: "検索サービスに接続できませんでした" },
      { status: 502 }
    );
  }
}
