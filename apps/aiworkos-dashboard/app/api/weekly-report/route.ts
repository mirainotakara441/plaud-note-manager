import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 週報ダッシュボード：週次の営業活動（支店・自治体・事業者・議員・委託企業・銀行・
// プロモーション・全体）をカテゴリー別に構造化した weekly_reports を読む。
// 読み取りは anonキー、書き込み（PATCH）は service role キーで叩く
// （2026-07-25 レビュー対応）。

export const dynamic = "force-dynamic";

const TABLE = "weekly_reports";

type WeeklyReportRow = {
  id: string;
  tactic: string | null;
  [key: string]: unknown;
};

type RowWithActionDone = WeeklyReportRow & { action_done: boolean | null };

function headers(key: string): Record<string, string> {
  return restHeaders(key);
}

export async function GET(request: Request) {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  let week = searchParams.get("week");

  // week未指定なら、テーブル内で最も新しい week_start をデフォルトに使う
  if (!week) {
    const latestRes = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=week_start&order=week_start.desc&limit=1`,
      { headers: headers(c.key), cache: "no-store" }
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
      { headers: headers(c.key), cache: "no-store" }
    ),
    fetch(
      `${c.url}/rest/v1/${TABLE}?select=week_start&order=week_start.asc`,
      { headers: headers(c.key), cache: "no-store" }
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

  const rows: WeeklyReportRow[] = await rowsRes.json();
  const weeksRaw: { week_start: string }[] = await weeksRes.json();
  const available_weeks = Array.from(new Set(weeksRaw.map((w) => w.week_start)));

  const actionDoneById = await fetchActionDoneMap(c, rows);
  const rowsWithActionDone: RowWithActionDone[] = rows.map((r) => ({
    ...r,
    action_done: r.tactic ? actionDoneById.get(r.id) ?? null : null,
  }));

  return NextResponse.json({ week_start: week, rows: rowsWithActionDone, available_weeks });
}

// tactic付きの週報行に対応する daily_actions（source='weekly_report'）の done状態を
// まとめて1回のリクエストで取得し、weekly_reports.id -> done のMapを返す。
// daily_actions はanonにSELECT権限がある（daily_actions anon read ポリシー、2026-07-22追加）。
async function fetchActionDoneMap(
  c: { url: string; key: string },
  rows: WeeklyReportRow[]
): Promise<Map<string, boolean>> {
  const ids = rows.filter((r) => r.tactic).map((r) => r.id);
  if (ids.length === 0) return new Map();

  const idList = ids.map((id) => encodeURIComponent(id)).join(",");
  const res = await fetch(
    `${c.url}/rest/v1/daily_actions?select=source_id,done&source=eq.weekly_report&source_id=in.(${idList})`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) return new Map();

  const actions: { source_id: string; done: boolean }[] = await res.json();
  const map = new Map<string, boolean>();
  for (const a of actions) {
    map.set(a.source_id, a.done);
  }
  return map;
}

export async function PATCH(request: Request) {
  const c = serviceCreds();
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
        ...headers(c.key),
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
