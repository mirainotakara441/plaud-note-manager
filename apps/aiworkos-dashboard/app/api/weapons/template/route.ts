import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 提案書（資料集）のひな形（節構成）を編集するAPI。
// テーブル weapon_proposal_sections を丸ごと入れ替える方式にする
// （並べ替え・追加・削除・書き方の指示の編集を、個別のposition管理なしで一括保存できるようにするため）。

export const dynamic = "force-dynamic";

const TABLE = "weapon_proposal_sections";

function headers(key: string, prefer?: string): Record<string, string> {
  return restHeaders(key, prefer ? { Prefer: prefer } : undefined);
}

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id,section,guidance&order=position.asc`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
  }
  const sections = await res.json();
  return NextResponse.json({ sections });
}

// ひな形を丸ごと入れ替える。body: { sections: [{ section, guidance }, ...] }（この順序で保存）
export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);
  const rawSections = Array.isArray(body?.sections) ? body.sections : null;
  if (!rawSections) {
    return NextResponse.json({ error: "sectionsが不正です" }, { status: 400 });
  }

  const sections = rawSections
    .map((s: { section?: unknown; guidance?: unknown }) => ({
      section: typeof s?.section === "string" ? s.section.trim() : "",
      guidance:
        typeof s?.guidance === "string" && s.guidance.trim() ? s.guidance.trim() : null,
    }))
    .filter((s: { section: string }) => s.section !== "");

  if (sections.length === 0) {
    return NextResponse.json({ error: "節を1つ以上入力してください" }, { status: 400 });
  }

  // 全削除してから、渡された順序で position を振り直して入れ直す（position は常に0以上）。
  const delRes = await fetch(`${c.url}/rest/v1/${TABLE}?position=gte.0`, {
    method: "DELETE",
    headers: headers(c.key),
  });
  if (!delRes.ok) {
    return NextResponse.json({ error: `更新失敗（削除） ${delRes.status}` }, { status: 502 });
  }

  const rows = sections.map(
    (s: { section: string; guidance: string | null }, i: number) => ({
      position: i,
      section: s.section,
      guidance: s.guidance,
    })
  );
  const insRes = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: headers(c.key, "return=representation"),
    body: JSON.stringify(rows),
  });
  if (!insRes.ok) {
    const t = await insRes.text();
    return NextResponse.json({ error: `更新失敗（保存） ${insRes.status}: ${t}` }, { status: 502 });
  }
  const saved = await insRes.json();
  return NextResponse.json({ sections: saved });
}
