import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 講座アーカイブ。受講した生成AI講座の録画URL・パスコード・学びを溜める。
//
// 元は GitHub Pages の単体ページ（lecture-archive）で、データは各端末の
// localStorage にしか無かった。Macで登録した講座がiPhoneで見えず、ブラウザの
// データを消せば全部消える状態だったため、他ページと同じくSupabaseを正にした。
//
// 読み取りは anon、書き込みは service role（weekly_reports と同じ方針）。

export const dynamic = "force-dynamic";

const TABLE = "lecture_archives";
const PLATFORMS = ["youtube", "zoom", "vimeo", "other"];

type Body = {
  id?: unknown;
  instructor?: unknown;
  title?: unknown;
  lecture_date?: unknown;
  platform?: unknown;
  url?: unknown;
  passcode?: unknown;
  material_url?: unknown;
  audio_url?: unknown;
  note?: unknown;
  insight?: unknown;
};

/** 実在する日付か（正規表現だけだと 2026-02-30 が通る）。 */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 入力を保存できる形に整える。不正があればエラー文字列を返す。 */
function buildRow(body: Body): { row: Record<string, unknown> } | { error: string } {
  const instructor = str(body.instructor);
  const title = str(body.title);
  if (!instructor) return { error: "講師名を入力してください" };
  if (!title) return { error: "講座名を入力してください" };

  const platform = str(body.platform) || "other";
  if (!PLATFORMS.includes(platform)) {
    return { error: `種別は次から選んでください: ${PLATFORMS.join(" / ")}` };
  }

  const lectureDate = str(body.lecture_date);
  if (lectureDate && !isValidDate(lectureDate)) {
    return { error: "講義日が正しくありません（YYYY-MM-DD）" };
  }

  return {
    row: {
      instructor,
      title,
      lecture_date: lectureDate || null,
      platform,
      url: str(body.url) || null,
      passcode: str(body.passcode) || null,
      material_url: str(body.material_url) || null,
      audio_url: str(body.audio_url) || null,
      note: str(body.note) || null,
      insight: str(body.insight) || null,
    },
  };
}

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=*&order=lecture_date.desc.nullslast,created_at.desc`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows = await res.json();
  return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: Body;
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/lectures: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const built = buildRow(body);
  if ("error" in built) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: { ...restHeaders(c.key), Prefer: "return=representation" },
    body: JSON.stringify(built.row),
    cache: "no-store",
  });
  if (res.status === 409) {
    return NextResponse.json(
      { error: "同じ講師・同じ講座名が既に登録されています" },
      { status: 409 }
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `登録失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "登録結果を取得できませんでした" }, { status: 502 });
  }
  return NextResponse.json({ row: rows[0] });
}

export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: Body;
  try {
    body = await req.json();
  } catch (err) {
    console.error("PATCH /api/lectures: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const id = str(body.id);
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const built = buildRow(body);
  if ("error" in built) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { ...restHeaders(c.key), Prefer: "return=representation" },
      body: JSON.stringify({ ...built.row, updated_at: new Date().toISOString() }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `更新失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "更新対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ row: rows[0] });
}

export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const id = str(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { ...restHeaders(c.key), Prefer: "return=representation" },
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `削除失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "削除対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
