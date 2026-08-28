import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 上長への月次報告の議事メモ（monthly_briefings）。
//
// 月報ドラフト（monthly_reports）と同じ月キーで並ぶが、テーブルは分けている。
// 片方はAIが週報から組む生成物、こちらは人が報告して何を言われたかの記録で、
// 作り直す頻度も寿命も違うため（詳しくはテーブルのコメント）。
//
// 記憶層への流し込み:
//   保存のたびに store-memory Edge Function 経由で
//   memory_chunks(source_type='月次報告') へ upsert する。
//   提案や壁打ちのときに「前に統括部長にこう言われた」を引けるようにするため。
//
//   2026-08-28まではここだけ PostgREST を直に叩いており、書き込み口が2つに
//   割れていた。そのため (1)埋め込みが作られず (2)Memory 2.0 の同一性4列も
//   埋まらなかった。store-memory に寄せて両方とも解消する。
//   source_id に `monthly_briefing:` を付けるのは、裸のUUIDだと同一性の
//   分類規則のどれにも当たらないため。実データ0件の今しか変えられない。

export const dynamic = "force-dynamic";

const TABLE = "monthly_briefings";
const MEMORY_SOURCE = "月次報告";

/**
 * 記憶層での source_id。裸のUUIDにしない。
 * 同一性の分類（supabase/functions/_shared/identity.mjs）はこの接頭辞で
 * ingest_scheme='monthly' を決める。接頭辞が無いと未知の書式として弾かれる。
 */
function memorySourceId(id: string): string {
  return `monthly_briefing:${id}`;
}

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TITLE = 120;
const MAX_AUDIENCE = 60;
const MAX_BODY = 8000;

const SELECT =
  "select=id,month,reported_on,audience,title,summary,feedback,decisions,homework,note,created_at,updated_at";

type Body = {
  id?: unknown;
  month?: unknown;
  reported_on?: unknown;
  audience?: unknown;
  title?: unknown;
  summary?: unknown;
  feedback?: unknown;
  decisions?: unknown;
  homework?: unknown;
  note?: unknown;
};

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function validate(b: Body): { error: string } | { fields: Record<string, unknown> } {
  const month = b.month;
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    return { error: "対象月の指定が不正です（YYYY-MM）" };
  }
  const audience = text(b.audience, MAX_AUDIENCE);
  if (!audience) return { error: "報告先を入れてください" };
  const title = text(b.title, MAX_TITLE);
  if (!title) return { error: "見出しを入れてください" };

  let reported_on: string | null = null;
  if (typeof b.reported_on === "string" && b.reported_on.trim() !== "") {
    if (!DAY_RE.test(b.reported_on)) return { error: "実施日の形式が不正です" };
    // 報告した日が対象月からずれること自体はある（8月度を9/2に報告する等）ので月一致は求めない
    reported_on = b.reported_on;
  }

  return {
    fields: {
      month,
      reported_on,
      audience,
      title,
      summary: text(b.summary, MAX_BODY),
      feedback: text(b.feedback, MAX_BODY),
      decisions: text(b.decisions, MAX_BODY),
      homework: text(b.homework, MAX_BODY),
      note: text(b.note, MAX_BODY),
    },
  };
}

/** 記憶層に流す1件ぶんの本文を組む。空の欄は見出しごと落とす。 */
function memoryContent(f: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (label: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) parts.push(`【${label}】\n${v.trim()}`);
  };
  push("報告した内容", f.summary);
  push("言われたこと・反応", f.feedback);
  push("決まったこと", f.decisions);
  push("宿題・次アクション", f.homework);
  push("メモ", f.note);
  return parts.join("\n\n");
}

/**
 * memory_chunks へ入れ直す。
 * 同じ議事メモを何度直しても行が増えないよう、source_id を鍵にした upsert に任せる。
 * 失敗しても本体の保存は成功として返す（記憶層は後追いで直せるが、
 * 議事メモそのものを取りこぼすと打ち直しになるため）。
 */
async function syncMemory(id: string, f: Record<string, unknown>): Promise<boolean> {
  const content = memoryContent(f);
  if (!content) return true; // 本文が無いなら記憶に入れる意味がない
  const anon = anonCreds();
  if (!anon) return false;
  try {
    const res = await fetch(`${anon.url}/functions/v1/store-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: MEMORY_SOURCE,
        source_id: memorySourceId(id),
        organization: f.audience,
        title: `${f.month} ${f.audience}への月次報告：${f.title}`,
        content,
        event_date: f.reported_on ?? null,
        metadata: { month: f.month, audience: f.audience, via: "monthly-report-page" },
      }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 一覧。?month=YYYY-MM でその月だけ。省略時は新しい順に全部。 */
export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const month = req.nextUrl.searchParams.get("month");
  const params = [SELECT, "order=reported_on.desc.nullslast,created_at.desc", "limit=500"];
  if (month && MONTH_RE.test(month)) params.push(`month=eq.${month}`);

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.join("&")}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("月次報告メモの取得に失敗:", res.status, t.slice(0, 200));
    return NextResponse.json({ error: "月次報告メモの取得に失敗しました" }, { status: 502 });
  }
  return NextResponse.json({ items: await res.json() });
}

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const v = validate(body ?? {});
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(v.fields),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: `登録に失敗 ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const rows = await res.json();
  const item = Array.isArray(rows) ? rows[0] : rows;
  const memorySaved = await syncMemory(item.id, v.fields);
  return NextResponse.json({ ok: true, item, memorySaved });
}

export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const id = body?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "idの指定が不正です" }, { status: 400 });
  }
  const v = validate(body ?? {});
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify({ ...v.fields, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: `更新に失敗 ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });
  }
  const memorySaved = await syncMemory(id, v.fields);
  return NextResponse.json({ ok: true, item: rows[0], memorySaved });
}

export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "idの指定が不正です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "DELETE",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: `削除に失敗 ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });
  }
  // 記憶層にも残さない（消したはずの報告が壁打ちで出てくるのを防ぐ）。
  // 削除も書き込みと同じ経路（purge-memory）に寄せる。
  const anon = anonCreds();
  if (anon) {
    await fetch(`${anon.url}/functions/v1/purge-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id_prefix: memorySourceId(id) }),
      cache: "no-store",
    }).catch(() => null);
  }
  return NextResponse.json({ ok: true });
}
