import { NextRequest, NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

// 週報の登録状況（直近N週分）を返す読み取り専用API。
// /weekly-report ページの上部に、一行日記（/api/diary/status）と同じ済/未の帯を出すため。
// weekly_reports は anon に SELECT ポリシーがある（GET /api/weekly-report も anon で読んでいる）。

export const dynamic = "force-dynamic";

type StatusEntry = {
  week_start: string;
  registered: boolean;
  count: number;
  isCurrentWeek: boolean;
};

const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 26;

/** YYYY-MM-DD に週数を加減算する（UTC基準。週の切替キーはlocal日付に依存させない）。 */
function addWeeks(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta * 7);
  return dt.toISOString().slice(0, 10);
}

/** その日付が属する週の月曜日を返す（UTC基準）。 */
function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0=日, 1=月
  dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return dt.toISOString().slice(0, 10);
}

function weeksBetween(later: string, earlier: string): number {
  const l = new Date(`${later}T00:00:00Z`).getTime();
  const e = new Date(`${earlier}T00:00:00Z`).getTime();
  return Math.round((l - e) / (7 * 24 * 60 * 60 * 1000));
}

function parseWeeks(req: NextRequest): number {
  const raw = Number(req.nextUrl.searchParams.get("weeks"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WEEKS;
  return Math.min(Math.floor(raw), MAX_WEEKS);
}

export async function GET(req: NextRequest) {
  const c = anonCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  const weeks = parseWeeks(req);
  const currentWeek = mondayOf(toJstDateString(new Date().toISOString()));
  const weekList: string[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) weekList.push(addWeeks(currentWeek, -i));

  try {
    const res = await fetch(
      `${c.url}/rest/v1/weekly_reports?select=week_start&order=week_start.desc`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`weekly_reports取得失敗 ${res.status}: ${detail.slice(0, 200)}`);
    }
    const rows: { week_start: string }[] = await res.json();

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.week_start, (counts.get(r.week_start) ?? 0) + 1);
    const latestWeek = rows[0]?.week_start ?? null;

    const entries: StatusEntry[] = weekList.map((w) => ({
      week_start: w,
      registered: counts.has(w),
      count: counts.get(w) ?? 0,
      isCurrentWeek: w === currentWeek,
    }));

    return NextResponse.json({
      currentWeek,
      weeks,
      entries,
      latestWeek,
      staleWeeks: latestWeek ? weeksBetween(currentWeek, latestWeek) : null,
    });
  } catch (error) {
    console.error("GET /api/weekly-report/status:", error);
    return NextResponse.json({ error: "登録状況の取得に失敗しました" }, { status: 502 });
  }
}
