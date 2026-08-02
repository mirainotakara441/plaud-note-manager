import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { homeVisitAuthorized } from "@/lib/homeVisitAuth";

// 家庭訪問のメンバー1人の追加・修正・削除。
// 初期の81名は名簿から入れてあるので、ここは「転入した人を足す」
// 「役職が変わった」「転出したので外す」を後から手で直すための口。

export const dynamic = "force-dynamic";

const TABLE = "home_visit_members";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Body = {
  id?: number | string;
  name?: string;
  division?: string;
  district?: string;
  block?: string;
  role?: string;
  birth_date?: string | null;
  age_manual?: number | string | null;
  address?: string;
  note?: string;
  active?: boolean;
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

  const name = text(body.name);
  if (!name) return NextResponse.json({ error: "氏名は必須です" }, { status: 400 });

  const age = toInt(body.age_manual);
  const birth = text(body.birth_date);

  const row = {
    name,
    division: text(body.division) ?? "壮年部",
    district: text(body.district),
    block: text(body.block),
    role: text(body.role),
    // 生年月日が入っていれば年齢は都度計算するので、手入力の年齢は捨てる
    birth_date: birth && DAY_RE.test(birth) ? birth : null,
    age_manual: birth && DAY_RE.test(birth) ? null : age != null && age >= 0 && age < 130 ? age : null,
    address: text(body.address),
    note: text(body.note),
    active: body.active !== false,
  };

  const id = toInt(body.id);
  const url = id ? `${c.url}/rest/v1/${TABLE}?id=eq.${id}` : `${c.url}/rest/v1/${TABLE}`;

  // 新規は名簿の末尾に置く。並びは既存の最大値+1（sort_orderは表示順にしか使わない）。
  let sortOrder: number | undefined;
  if (!id) {
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=sort_order&order=sort_order.desc&limit=1`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    const rows = res.ok ? await res.json().catch(() => []) : [];
    sortOrder = (Array.isArray(rows) && rows[0]?.sort_order ? rows[0].sort_order : 0) + 1;
  }

  const res = await fetch(url, {
    method: id ? "PATCH" : "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(
      id ? { ...row, updated_at: new Date().toISOString() } : { ...row, sort_order: sortOrder }
    ),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("home-visit member 保存失敗:", res.status, detail);
    return NextResponse.json(
      { error: `保存に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;
  if (id && !saved) {
    return NextResponse.json({ error: "対象のメンバーが見つかりませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: saved?.id ?? id, item: saved });
}

// メンバーを名簿から消す。訪問履歴は外部キーの ON DELETE CASCADE で一緒に消えるので、
// 履歴を残したいだけの人（転出・長期不在）は active=false（休止）で外すこと。
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
    return NextResponse.json({ error: "対象のメンバーが見つかりませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
