import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 「戦略ToDo」= Notion「ToDo DB」からミラーしたジャンル別（社内／自治体／議員／
// 事業者／委託会社）の月次営業ToDo。テーブルは strategic_todos。
//
// daily_actions（日記由来・日付ベース）とは由来もデータ形も違うため、テーブルは
// 分けたまま「日々のToDo」ページ（app/actions/page.tsx）のUIレイヤーで束ねる。
//
// 読み取りは anonキー（RLSで anon にSELECTのみ許可）、書き込みは service role キー。
// 既存の app/api/actions/route.ts と同じ作法。

export const dynamic = "force-dynamic";

const TABLE = "strategic_todos";

// Notion側のセレクト値と一致させる。これ以外の値は受け付けない。
const STATUSES = ["未着手", "進行中", "完了"] as const;
type Status = (typeof STATUSES)[number];

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

const GENRES = ["社内", "自治体", "議員", "事業者", "委託会社"] as const;
type Genre = (typeof GENRES)[number];

function isGenre(v: unknown): v is Genre {
  return typeof v === "string" && (GENRES as readonly string[]).includes(v);
}

function headers(key: string, prefer?: string): Record<string, string> {
  return restHeaders(key, prefer ? { Prefer: prefer } : undefined);
}

const SELECT =
  "id,notion_page_id,task_name,genre,status,target_month,notes,created_at,updated_at";

// 一覧取得（ジャンル順→登録順）。並べ替え・グルーピングは画面側で行う。
export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=${SELECT}&order=genre.asc,created_at.asc`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
  }
  const items = await res.json();
  return NextResponse.json({ items });
}

// 新規追加（手動登録行。Notion非連携のため notion_page_id は null 固定）。
export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);

  const task_name: string = (body?.task_name ?? "").trim();
  if (!task_name) {
    return NextResponse.json({ error: "task_nameが空です" }, { status: 400 });
  }

  const genre: unknown = body?.genre;
  if (!isGenre(genre)) {
    return NextResponse.json(
      { error: `genreが不正です（${GENRES.join("/")}のいずれか）` },
      { status: 400 }
    );
  }

  const target_month: unknown = body?.target_month;
  const target_month_value =
    typeof target_month === "string" ? target_month.trim() || null : null;

  const notes: unknown = body?.notes;
  const notes_value = typeof notes === "string" ? notes.trim() || null : null;

  const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: headers(c.key, "return=representation"),
    body: JSON.stringify({
      notion_page_id: null,
      task_name,
      genre,
      status: "未着手",
      target_month: target_month_value,
      notes: notes_value,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `追加失敗 ${res.status}: ${t}` }, { status: 502 });
  }
  const rows = await res.json();
  return NextResponse.json({ item: rows[0] });
}

// ステータス更新。単体 { id, status/task_name/notes/genre } または一括 { ids: string[], status }。
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);

  // 一括更新
  if (Array.isArray(body?.ids)) {
    const status: unknown = body?.status;
    if (!isStatus(status)) {
      return NextResponse.json(
        { error: `statusが不正です（${STATUSES.join("/")}のいずれか）` },
        { status: 400 }
      );
    }
    const patch = { status, updated_at: new Date().toISOString() };

    const ids: string[] = body.ids.filter(
      (x: unknown): x is string => typeof x === "string" && x.length > 0
    );
    if (ids.length === 0) {
      return NextResponse.json({ error: "idsが必要です" }, { status: 400 });
    }
    const idList = ids.map((id) => encodeURIComponent(id)).join(",");
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=in.(${idList})`, {
      method: "PATCH",
      headers: headers(c.key, "return=representation"),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const t = await res.text();
      return NextResponse.json(
        { error: `一括更新失敗 ${res.status}: ${t}` },
        { status: 502 }
      );
    }
    const rows = await res.json();
    return NextResponse.json({ ok: true, count: Array.isArray(rows) ? rows.length : 0 });
  }

  // 単体更新（status/task_name/notes/genre のうち指定されたものだけを反映）
  const id: unknown = body?.id;
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let hasField = false;

  if (body?.status !== undefined) {
    const status: unknown = body.status;
    if (!isStatus(status)) {
      return NextResponse.json(
        { error: `statusが不正です（${STATUSES.join("/")}のいずれか）` },
        { status: 400 }
      );
    }
    patch.status = status;
    hasField = true;
  }

  if (body?.task_name !== undefined) {
    const task_name = typeof body.task_name === "string" ? body.task_name.trim() : "";
    if (!task_name) {
      return NextResponse.json({ error: "task_nameが空です" }, { status: 400 });
    }
    patch.task_name = task_name;
    hasField = true;
  }

  if (body?.genre !== undefined) {
    const genre: unknown = body.genre;
    if (!isGenre(genre)) {
      return NextResponse.json(
        { error: `genreが不正です（${GENRES.join("/")}のいずれか）` },
        { status: 400 }
      );
    }
    patch.genre = genre;
    hasField = true;
  }

  if (body?.notes !== undefined) {
    if (typeof body.notes === "string") {
      const notes = body.notes.trim();
      patch.notes = notes ? notes : null;
      hasField = true;
    }
  }

  if (!hasField) {
    return NextResponse.json({ error: "更新項目がありません" }, { status: 400 });
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
