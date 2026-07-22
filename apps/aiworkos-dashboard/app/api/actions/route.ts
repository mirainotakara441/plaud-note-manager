import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 「日々のToDo」= 一行日記の やってみよう(action) / 本日のポイント(point) を
// 日付ごとに積み上げるテーブル daily_actions のCRUD。
// 読み取りは anonキー、書き込みは service role キーで Supabase PostgREST を叩く
// （2026-07-25 レビュー対応：anonの書き込みポリシーは順次廃止するため）。

export const dynamic = "force-dynamic";

function headers(key: string, prefer?: string): Record<string, string> {
  return restHeaders(key, prefer ? { Prefer: prefer } : undefined);
}

const TABLE = "daily_actions";

// 一覧取得（新しい日付順 → 種別 → 並び順）
export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=*&order=entry_date.desc,kind.asc,position.asc,created_at.asc`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
  }
  const items = await res.json();
  return NextResponse.json({ items });
}

// 手動でToDoを1件追加
export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);
  const entry_date: string | undefined = body?.entry_date;
  const kind: string | undefined = body?.kind;
  const content: string = (body?.content ?? "").trim();
  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(entry_date)) {
    return NextResponse.json({ error: "日付が不正です" }, { status: 400 });
  }
  if (kind !== "action" && kind !== "point") {
    return NextResponse.json({ error: "種別が不正です" }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ error: "内容が空です" }, { status: 400 });
  }
  const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: headers(c.key, "return=representation"),
    body: JSON.stringify({ entry_date, kind, content, source: "manual" }),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `追加失敗 ${res.status}: ${t}` }, { status: 502 });
  }
  const rows = await res.json();
  return NextResponse.json({ item: rows[0] });
}

// チェック(done)の切替、または内容の編集（1件）。
// { ids: string[], done: boolean } が来た場合は複数件の一括更新。
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);

  // 一括更新: { ids: string[], done: boolean }
  if (Array.isArray(body?.ids)) {
    const ids: string[] = body.ids.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
    if (ids.length === 0) return NextResponse.json({ error: "idsが必要です" }, { status: 400 });
    if (typeof body.done !== "boolean") {
      return NextResponse.json({ error: "doneが必要です" }, { status: 400 });
    }

    const patch: Record<string, unknown> = {
      done: body.done,
      done_at: body.done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const idList = ids.map((id) => encodeURIComponent(id)).join(",");
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=in.(${idList})`, {
      method: "PATCH",
      headers: headers(c.key, "return=representation"),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const t = await res.text();
      return NextResponse.json({ error: `一括更新失敗 ${res.status}: ${t}` }, { status: 502 });
    }
    const rows = await res.json();
    return NextResponse.json({ ok: true, count: Array.isArray(rows) ? rows.length : 0 });
  }

  // 単体更新: { id, done?, content? }
  const id: string | undefined = body?.id;
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.done === "boolean") {
    patch.done = body.done;
    patch.done_at = body.done ? new Date().toISOString() : null;
  }
  if (typeof body.content === "string") {
    const content = body.content.trim();
    if (!content) return NextResponse.json({ error: "内容が空です" }, { status: 400 });
    patch.content = content;
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(c.key, "return=representation"),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `更新失敗 ${res.status}: ${t}` }, { status: 502 });
  }
  const rows = await res.json();
  return NextResponse.json({ item: rows[0] ?? null });
}

// 1件削除
export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(c.key),
  });
  if (!res.ok) {
    return NextResponse.json({ error: `削除失敗 ${res.status}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
