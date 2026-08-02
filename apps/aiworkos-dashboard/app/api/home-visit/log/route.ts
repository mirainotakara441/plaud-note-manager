import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { homeVisitAuthorized } from "@/lib/homeVisitAuth";

// 訪問1回分の記録・修正・削除。
// met は3値で持つ： null＝これからの予定 / true＝会えた / false＝会えなかった。
// 予定として入れた行に後から met を入れると、そのまま実績になる（行を作り直さない）。

export const dynamic = "force-dynamic";

const TABLE = "home_visit_logs";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Body = {
  id?: number | string;
  member_id?: number | string;
  visit_date?: string;
  met?: boolean | null;
  topics?: string;
  next_action?: string;
};

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function unauthorized() {
  return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
}

function noServiceKey() {
  return NextResponse.json(
    { error: "サーバー設定エラー: SUPABASE_SERVICE_ROLE_KEY が未設定です" },
    { status: 500 }
  );
}

export async function POST(req: NextRequest) {
  if (!(await homeVisitAuthorized(req))) return unauthorized();
  const c = serviceCreds();
  if (!c) return noServiceKey();

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが読めませんでした" }, { status: 400 });
  }

  const id = toInt(body.id);
  const memberId = toInt(body.member_id);
  if (!id && !memberId) {
    return NextResponse.json({ error: "誰への訪問かが分かりませんでした" }, { status: 400 });
  }

  const visitDate = body.visit_date;
  if (!visitDate || !DAY_RE.test(visitDate)) {
    return NextResponse.json({ error: "日付を入れてください" }, { status: 400 });
  }

  const row = {
    visit_date: visitDate,
    met: body.met === true ? true : body.met === false ? false : null,
    topics: text(body.topics),
    next_action: text(body.next_action),
  };

  const url = id ? `${c.url}/rest/v1/${TABLE}?id=eq.${id}` : `${c.url}/rest/v1/${TABLE}`;

  const res = await fetch(url, {
    method: id ? "PATCH" : "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(
      id ? { ...row, updated_at: new Date().toISOString() } : { ...row, member_id: memberId }
    ),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("home-visit log 保存失敗:", res.status, detail);
    return NextResponse.json(
      { error: `記録に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;
  if (id && !saved) {
    return NextResponse.json({ error: "対象の記録が見つかりませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: saved?.id ?? id, item: saved });
}

export async function DELETE(req: NextRequest) {
  if (!(await homeVisitAuthorized(req))) return unauthorized();
  const c = serviceCreds();
  if (!c) return noServiceKey();

  const id = toInt(new URL(req.url).searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "DELETE",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `削除に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  if (!(Array.isArray(rows) ? rows[0] : rows)) {
    return NextResponse.json({ error: "対象の記録が見つかりませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
