import { NextResponse } from "next/server";

// 週報ダッシュボード：週次の営業活動（支店・自治体・事業者・議員・委託企業・銀行・
// プロモーション・全体）をカテゴリー別に構造化した weekly_reports を読む。
// 既存ページ（/nippo）と同じく anonキーで Supabase PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "weekly_reports";

function creds() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

function headers(anon: string): Record<string, string> {
  return {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
    "Content-Type": "application/json",
  };
}

export async function GET(request: Request) {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  let week = searchParams.get("week");

  // week未指定なら、テーブル内で最も新しい week_start をデフォルトに使う
  if (!week) {
    const latestRes = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=week_start&order=week_start.desc&limit=1`,
      { headers: headers(c.anon), cache: "no-store" }
    );
    if (!latestRes.ok) {
      const detail = await latestRes.text().catch(() => "");
      return NextResponse.json(
        { error: `取得失敗 ${latestRes.status}`, detail: detail.slice(0, 200) },
        { status: 502 }
      );
    }
    const latest = await latestRes.json();
    week = latest?.[0]?.week_start ?? null;
  }

  if (!week) {
    return NextResponse.json({ week_start: null, rows: [], available_weeks: [] });
  }

  const [rowsRes, weeksRes] = await Promise.all([
    fetch(
      `${c.url}/rest/v1/${TABLE}?select=*&week_start=eq.${week}&order=category.asc`,
      { headers: headers(c.anon), cache: "no-store" }
    ),
    fetch(
      `${c.url}/rest/v1/${TABLE}?select=week_start&order=week_start.asc`,
      { headers: headers(c.anon), cache: "no-store" }
    ),
  ]);

  if (!rowsRes.ok) {
    const detail = await rowsRes.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${rowsRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  if (!weeksRes.ok) {
    const detail = await weeksRes.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${weeksRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await rowsRes.json();
  const weeksRaw: { week_start: string }[] = await weeksRes.json();
  const available_weeks = Array.from(new Set(weeksRaw.map((w) => w.week_start)));

  return NextResponse.json({ week_start: week, rows, available_weeks });
}

export async function PATCH(request: Request) {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: {
    id?: unknown;
    summary?: unknown;
    insight?: unknown;
    tactic?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const update: Record<string, string | null> = {};
  if ("summary" in body && typeof body.summary === "string") {
    update.summary = body.summary;
  }
  if ("insight" in body) {
    update.insight = typeof body.insight === "string" ? body.insight : null;
  }
  if ("tactic" in body) {
    update.tactic = typeof body.tactic === "string" ? body.tactic : null;
  }

  try {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        ...headers(c.anon),
        Prefer: "return=representation",
      },
      body: JSON.stringify(update),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `更新失敗 ${res.status}`, detail: detail.slice(0, 200) },
        { status: 502 }
      );
    }
    const rows = await res.json();
    return NextResponse.json({ row: rows?.[0] ?? null });
  } catch {
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
  }
}
