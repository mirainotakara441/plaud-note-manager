import { NextResponse } from "next/server";
import { anonCreds, restHeaders, type Creds } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

// ホーム画面「今日の作戦盤」用の集計API。
// daily_actions（当日分のToDo進捗）、weekly_reports（今週の接点・宿題消化）、
// claude_usage_daily（今週のClaude利用時間）を
// 読み取り専用（anonキーのみ）でまとめて返す。書き込みは一切しない。

export const dynamic = "force-dynamic";

type TodoStats = { total: number; remaining: number };

type WeekStats = {
  week_start: string | null;
  contacts: number;
  homework_total: number;
  homework_done: number;
};

type HomeStatsResponse = {
  today: string;
  todo: TodoStats;
  week: WeekStats;
  claude_hours: number;
  error?: string;
};

function headers(key: string): Record<string, string> {
  return restHeaders(key);
}

// 今週（JST基準）の月曜日をYYYY-MM-DD形式で返す。
// app/weekly-report/page.tsx の toMonday() と同じ「日曜は前週扱い」ロジックを踏襲するが、
// こちらはサーバー側でJST日付から算出するため、UTCメソッドで計算しローカルTZの影響を避ける。
function jstMondayOf(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay(); // 0=日, 1=月, ...
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

async function fetchTodoStats(c: Creds, today: string): Promise<TodoStats> {
  const res = await fetch(
    `${c.url}/rest/v1/daily_actions?select=id,done&entry_date=eq.${today}`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`daily_actions取得失敗 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const items: { id: string; done: boolean }[] = await res.json();
  const total = items.length;
  const remaining = items.filter((i) => !i.done).length;
  return { total, remaining };
}

async function fetchWeekStats(c: Creds): Promise<WeekStats> {
  const latestRes = await fetch(
    `${c.url}/rest/v1/weekly_reports?select=week_start&order=week_start.desc&limit=1`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!latestRes.ok) {
    const detail = await latestRes.text().catch(() => "");
    throw new Error(`weekly_reports取得失敗 ${latestRes.status}: ${detail.slice(0, 200)}`);
  }
  const latest = await latestRes.json();
  const week_start: string | null = latest?.[0]?.week_start ?? null;

  if (!week_start) {
    return { week_start: null, contacts: 0, homework_total: 0, homework_done: 0 };
  }

  const rowsRes = await fetch(
    `${c.url}/rest/v1/weekly_reports?select=id,category,organization,tactic&week_start=eq.${week_start}`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!rowsRes.ok) {
    const detail = await rowsRes.text().catch(() => "");
    throw new Error(`weekly_reports行取得失敗 ${rowsRes.status}: ${detail.slice(0, 200)}`);
  }
  const rows: { id: string; category: string; organization: string | null; tactic: string | null }[] =
    await rowsRes.json();

  const contacts = rows.filter((r) => r.category !== "全体").length;
  const withTactic = rows.filter((r) => r.tactic);
  const homework_total = withTactic.length;

  let homework_done = 0;
  if (withTactic.length > 0) {
    const idList = withTactic.map((r) => encodeURIComponent(r.id)).join(",");
    const doneRes = await fetch(
      `${c.url}/rest/v1/daily_actions?select=source_id,done&source=eq.weekly_report&source_id=in.(${idList})`,
      { headers: headers(c.key), cache: "no-store" }
    );
    if (!doneRes.ok) {
      const detail = await doneRes.text().catch(() => "");
      throw new Error(`daily_actions(宿題)取得失敗 ${doneRes.status}: ${detail.slice(0, 200)}`);
    }
    const doneRows: { source_id: string; done: boolean }[] = await doneRes.json();
    const doneMap = new Map(doneRows.map((d) => [d.source_id, d.done]));
    homework_done = withTactic.filter((r) => doneMap.get(r.id) === true).length;
  }

  return { week_start, contacts, homework_total, homework_done };
}

async function fetchClaudeHours(c: Creds, weekMonday: string): Promise<number> {
  const res = await fetch(
    `${c.url}/rest/v1/claude_usage_daily?select=hours&work_date=gte.${weekMonday}`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`claude_usage_daily取得失敗 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const rows: { hours: number | string }[] = await res.json();
  const total = rows.reduce((sum, r) => sum + Number(r.hours), 0);
  return Math.round(total * 10) / 10;
}

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const today = toJstDateString(new Date().toISOString());
  const weekMonday = jstMondayOf(today);

  const [todoSettled, weekSettled, claudeHoursSettled] = await Promise.allSettled([
    fetchTodoStats(c, today),
    fetchWeekStats(c),
    fetchClaudeHours(c, weekMonday),
  ]);

  let todo: TodoStats = { total: 0, remaining: 0 };
  let week: WeekStats = { week_start: null, contacts: 0, homework_total: 0, homework_done: 0 };
  let claude_hours = 0;
  const errors: string[] = [];

  if (todoSettled.status === "fulfilled") {
    todo = todoSettled.value;
  } else {
    console.error("GET /api/home-stats: todo取得エラー", todoSettled.reason);
    errors.push(
      todoSettled.reason instanceof Error ? todoSettled.reason.message : "ToDo取得に失敗しました"
    );
  }

  if (weekSettled.status === "fulfilled") {
    week = weekSettled.value;
  } else {
    console.error("GET /api/home-stats: week取得エラー", weekSettled.reason);
    errors.push(
      weekSettled.reason instanceof Error ? weekSettled.reason.message : "週報取得に失敗しました"
    );
  }

  if (claudeHoursSettled.status === "fulfilled") {
    claude_hours = claudeHoursSettled.value;
  } else {
    console.error("GET /api/home-stats: claude_usage_daily取得エラー", claudeHoursSettled.reason);
    errors.push(
      claudeHoursSettled.reason instanceof Error
        ? claudeHoursSettled.reason.message
        : "Claude利用時間取得に失敗しました"
    );
  }

  const body: HomeStatsResponse = { today, todo, week, claude_hours };
  if (errors.length > 0) body.error = errors.join(" / ");

  return NextResponse.json(body);
}
