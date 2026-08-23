import { NextRequest, NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

// Claude利用時間の週ごとの推移。
//
// ホームの作戦盤には「今週の合計」しか出ておらず、しかもそこだけタップできなかった。
// 数字が増えたのか減ったのかは前の週と並べないと分からないので、週ごとに並べた
// 画面（/claude-usage）へ渡すためのAPIをここに置く。
//
// 元データ `claude_usage_daily` は ~/.local/bin/claude-usage-rollup.js を
// launchd が1時間ごとに回して書いている（月曜起点・15分以内の間隔を継続作業として合算）。
// この仕組みは黙って止まることがあり、そのとき画面上は「0h」と「本当に使っていない」が
// 同じ見え方になる。区別できるよう last_data_date を必ず返し、画面側で古さを言う。

export const dynamic = "force-dynamic";

const TABLE = "claude_usage_daily";

/** 週の切り替え幅。ここに無い値が来たら既定に落とす。 */
const WEEK_CHOICES = [4, 8, 12, 26] as const;
const DEFAULT_WEEKS = 8;

type DayRow = { work_date: string; hours: number; note: string | null };

type WeekRow = {
  week_start: string; // 月曜 YYYY-MM-DD
  week_end: string; // 日曜 YYYY-MM-DD
  hours: number;
  days_logged: number; // 記録のある日数（0hの日は含めない）
  avg_per_logged_day: number;
  peak_hours: number;
  peak_date: string | null;
  is_current_week: boolean;
  /**
   * 計測が始まる前の週か。
   *
   * 集計は2026-07-20から。それ以前の週を「0h」と並べると「その週は使わなかった」
   * に見えるが、実際は測っていないだけ。使っていない週と測っていない週は別物なので、
   * 画面で言い分けられるように印を持たせる。
   */
  before_measurement: boolean;
};

/**
 * JST日付から、その週の月曜を返す。
 *
 * app/api/home-stats/route.ts の jstMondayOf と同じ「日曜は前週扱い」。
 * 作戦盤のカードと同じ週で切らないと、合計が画面ごとに食い違う。
 */
function jstMondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay(); // 0=日
  date.setUTCDate(date.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 日ごとの行を、月曜起点の週へまとめる。記録が1日も無い週も欠番にせず0で並べる。 */
function rollUp(
  days: DayRow[],
  firstMonday: string,
  weeks: number,
  thisMonday: string,
  firstDataDate: string | null
): WeekRow[] {
  const byWeek = new Map<string, DayRow[]>();
  for (const d of days) {
    const key = jstMondayOf(d.work_date);
    const list = byWeek.get(key);
    if (list) list.push(d);
    else byWeek.set(key, [d]);
  }

  const out: WeekRow[] = [];
  for (let i = 0; i < weeks; i += 1) {
    const week_start = addDays(firstMonday, i * 7);
    const rows = byWeek.get(week_start) ?? [];
    const hours = rows.reduce((s, r) => s + r.hours, 0);
    // 0hの日を「記録あり」に数えると平均が実態より低く出る。記録＝実際に触った日。
    const logged = rows.filter((r) => r.hours > 0);
    const peak = logged.reduce<DayRow | null>(
      (best, r) => (best === null || r.hours > best.hours ? r : best),
      null
    );
    out.push({
      week_start,
      week_end: addDays(week_start, 6),
      hours: round1(hours),
      days_logged: logged.length,
      avg_per_logged_day: logged.length > 0 ? round1(hours / logged.length) : 0,
      peak_hours: peak ? round1(peak.hours) : 0,
      peak_date: peak?.work_date ?? null,
      is_current_week: week_start === thisMonday,
      before_measurement:
        firstDataDate !== null && rows.length === 0 && addDays(week_start, 6) < firstDataDate,
    });
  }
  // 新しい週を上に。画面は「今週」から読み始める。
  return out.reverse();
}

export async function GET(req: NextRequest) {
  const c = anonCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  const asked = Number(req.nextUrl.searchParams.get("weeks"));
  const weeks: number = (WEEK_CHOICES as readonly number[]).includes(asked) ? asked : DEFAULT_WEEKS;

  const today = toJstDateString(new Date().toISOString());
  const thisMonday = jstMondayOf(today);
  const firstMonday = addDays(thisMonday, -(weeks - 1) * 7);

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=work_date,hours,note&work_date=gte.${firstMonday}` +
      `&order=work_date.asc&limit=400`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("claude_usage_daily取得エラー:", res.status, detail.slice(0, 300));
    // ★空配列を返して「まだ記録がありません」に見せない。
    //   取得失敗と本当に0件は、画面での意味がまるで違う。
    return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
  }

  const raw: { work_date: string; hours: number | string; note: string | null }[] = await res.json();
  // ★丸めるのは表示の直前だけ。日ごとを丸めてから足すと誤差が積もり、
  //   同じ週の合計がホームのカード（生値の合計）と食い違う（29.5h と 29.6h）。
  const days: DayRow[] = raw.map((r) => ({
    work_date: r.work_date,
    hours: Number(r.hours),
    note: r.note,
  }));

  // 元データが止まっていないかを画面で言うための材料。範囲で絞ると
  // 「範囲外にしかデータが無い」ときに最終日を見失うので、ここだけ別に取る。
  let last_data_date: string | null = null;
  const lastRes = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=work_date&order=work_date.desc&limit=1`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (lastRes.ok) {
    const rows: { work_date: string }[] = await lastRes.json();
    last_data_date = rows[0]?.work_date ?? null;
  } else {
    console.error("claude_usage_daily最終日の取得エラー:", lastRes.status);
  }

  let first_data_date: string | null = null;
  const firstRes = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=work_date&order=work_date.asc&limit=1`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (firstRes.ok) {
    const rows: { work_date: string }[] = await firstRes.json();
    first_data_date = rows[0]?.work_date ?? null;
  } else {
    console.error("claude_usage_daily開始日の取得エラー:", firstRes.status);
  }

  const weekRows = rollUp(days, firstMonday, weeks, thisMonday, first_data_date);
  const total = round1(days.reduce((s, d) => s + d.hours, 0));

  return NextResponse.json({
    today,
    weeks: weekRows,
    // 日別は直近28日ぶんだけ返す。全期間を渡しても画面では読み切れない。
    // 桁を揃えるのはここ（合計の計算が終わったあと）。
    days: days
      .filter((d) => d.work_date >= addDays(today, -27))
      .reverse()
      .map((d) => ({ ...d, hours: round1(d.hours) })),
    total,
    range_weeks: weeks,
    week_choices: WEEK_CHOICES,
    last_data_date,
    first_data_date,
  });
}
