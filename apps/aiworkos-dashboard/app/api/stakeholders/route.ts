import { NextRequest, NextResponse } from "next/server";

// ステークホルダー・マスタ。カテゴリー→具体名の2段階選択に使う。
// 新しい名前が使われたら POST で追加され、次回から選択肢に出る（マスタが育つ）。

export const CATEGORIES = [
  "自治体",
  "事業者",
  "銀行",
  "議員",
  "委託会社",
  "その他",
] as const;

type Row = { category: string; name: string };

function rest(supabaseUrl: string) {
  return `${supabaseUrl}/rest/v1/stakeholders`;
}

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  try {
    const res = await fetch(
      `${rest(supabaseUrl)}?select=category,name&order=name.asc&limit=500`,
      {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return NextResponse.json({ byCategory: {} });
    const rows: Row[] = await res.json();

    const byCategory: Record<string, string[]> = {};
    for (const c of CATEGORIES) byCategory[c] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!byCategory[r.category]) byCategory[r.category] = [];
      byCategory[r.category].push(r.name);
    }
    return NextResponse.json({ byCategory });
  } catch {
    return NextResponse.json({ byCategory: {} });
  }
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  let body: { category?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const category = typeof body.category === "string" ? body.category : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!(CATEGORIES as readonly string[]).includes(category) || !name) {
    return NextResponse.json({ error: "カテゴリーと名前が必要です" }, { status: 400 });
  }

  try {
    // 既にあれば無視（重複登録しない）
    const res = await fetch(rest(supabaseUrl), {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify({ category, name }),
      cache: "no-store",
    });
    if (!res.ok && res.status !== 409) {
      return NextResponse.json({ error: "追加に失敗しました" }, { status: 502 });
    }
    return NextResponse.json({ added: true, category, name });
  } catch {
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
  }
}
