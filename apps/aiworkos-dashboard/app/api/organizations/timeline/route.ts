import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 団体別タイムライン：会議（org-history）・成果物（memory_chunks 直叩き）・
// 週報（weekly_reports、organization ILIKE 部分一致）を統合し、日付降順の
// タイムラインとして返す。日記は search-memory の意味検索で「関連しそうな日記」
// として別枠を返す（失敗しても他セクションに影響しないよう握りつぶす）。
//
// memory_chunks は RLS で anon の SELECT を許可していないため、必ず
// serviceCreds() を使う。weekly_reports は anon に SELECT を許可しているため
// anonCreds() でよい。Edge Function（org-history / search-memory）は
// これまで通り anon キーを Bearer トークンとして呼ぶ。

export const dynamic = "force-dynamic";

type Meeting = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  organization: string | null;
};

type DeliverableChunk = {
  id: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type WeeklyReportRow = {
  id: string;
  week_start: string;
  category: string;
  organization: string | null;
  summary: string;
  insight: string | null;
  tactic: string | null;
  created_at: string;
};

export type DiaryResult = {
  id: string;
  source_type: string;
  source_id: string;
  organization: string | null;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
};

export type TimelineEntry = {
  id: string;
  kind: "会議" | "成果物" | "週報";
  date: string;
  title: string;
  summary: string;
  url?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// 「{タイトル}｜{n}/{全n}」形式の末尾チャンク番号を取り除く
function stripChunkSuffix(title: string): string {
  return title.replace(/｜\d+\/\d+$/, "").trim();
}

async function fetchMeetings(
  url: string,
  key: string,
  org: string
): Promise<Meeting[]> {
  const res = await fetch(`${url}/functions/v1/org-history`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ organization: org }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`org-history エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const data: unknown = await res.json();
  if (!isRecord(data) || !Array.isArray(data.meetings)) return [];
  return data.meetings as Meeting[];
}

async function fetchDeliverables(
  url: string,
  key: string,
  org: string
): Promise<DeliverableChunk[]> {
  const orgParam = encodeURIComponent(org);
  const sourceParam = encodeURIComponent("成果物");
  const res = await fetch(
    `${url}/rest/v1/memory_chunks?select=id,title,content,event_date,metadata,created_at&source_type=eq.${sourceParam}&organization=eq.${orgParam}&order=event_date.desc.nullslast,created_at.desc`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`成果物取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as DeliverableChunk[];
}

async function fetchWeeklyReports(
  url: string,
  key: string,
  org: string
): Promise<WeeklyReportRow[]> {
  // ILIKE 部分一致。encodeURIComponent は "*" をエンコードしないため、
  // PostgREST の ilike.*pattern* ワイルドカード構文をそのまま使える。
  const pattern = encodeURIComponent(`*${org}*`);
  const res = await fetch(
    `${url}/rest/v1/weekly_reports?select=id,week_start,category,organization,summary,insight,tactic,created_at&organization=ilike.${pattern}&order=week_start.desc`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`週報取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as WeeklyReportRow[];
}

async function fetchRelatedDiaries(
  url: string,
  key: string,
  org: string
): Promise<DiaryResult[]> {
  try {
    const res = await fetch(`${url}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: org, source_type: "日記", match_count: 5 }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!isRecord(data) || !Array.isArray(data.results)) return [];
    return data.results as DiaryResult[];
  } catch (error) {
    console.error("関連日記の意味検索エラー（無視して続行）:", error);
    return [];
  }
}

function meetingsToEntries(meetings: Meeting[]): TimelineEntry[] {
  return meetings
    .filter((m) => !!m.event_date)
    .map((m) => ({
      id: `meeting:${m.id}`,
      kind: "会議" as const,
      date: m.event_date as string,
      title: m.title,
      summary: m.content,
    }));
}

// 成果物はチャンク分割されているため、資料名（無ければタイトルからチャンク番号を
// 除いたもの）＋日付でグルーピングし、タイムライン上は1資料＝1件にまとめる。
// 代表チャンクは位置（n/全n）の n が最小のものを使う。
function deliverablesToEntries(chunks: DeliverableChunk[]): TimelineEntry[] {
  const groups = new Map<string, DeliverableChunk[]>();
  for (const c of chunks) {
    const meta = isRecord(c.metadata) ? c.metadata : null;
    const docName = (meta && asString(meta["資料名"])) ?? stripChunkSuffix(c.title);
    const dateKey = c.event_date ?? c.created_at.slice(0, 10);
    const key = `${docName}__${dateKey}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const entries: TimelineEntry[] = [];
  for (const group of groups.values()) {
    const withPos = group.map((c) => {
      const meta = isRecord(c.metadata) ? c.metadata : null;
      const posStr = meta ? asString(meta["位置"]) : null;
      const n = posStr ? Number(posStr.split("/")[0]) : 1;
      return { chunk: c, n: Number.isFinite(n) ? n : 1 };
    });
    withPos.sort((a, b) => a.n - b.n);
    const rep = withPos[0].chunk;
    const meta = isRecord(rep.metadata) ? rep.metadata : null;
    const docName = (meta && asString(meta["資料名"])) ?? stripChunkSuffix(rep.title);
    const date = rep.event_date ?? rep.created_at.slice(0, 10);
    entries.push({
      id: `deliverable:${rep.id}`,
      kind: "成果物",
      date,
      title: docName,
      summary: rep.content,
    });
  }
  return entries;
}

function weeklyReportsToEntries(rows: WeeklyReportRow[]): TimelineEntry[] {
  return rows.map((r) => ({
    id: `weekly:${r.id}`,
    kind: "週報" as const,
    date: r.week_start,
    title: `${r.category}週報（${r.week_start}週）`,
    summary: [r.summary, r.insight, r.tactic]
      .filter((s): s is string => !!s && s.trim() !== "")
      .join(" / "),
  }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const org = searchParams.get("org")?.trim();
  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }

  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [meetings, deliverables, weeklyReports] = await Promise.all([
      fetchMeetings(anon.url, anon.key, org),
      fetchDeliverables(service.url, service.key, org),
      fetchWeeklyReports(anon.url, anon.key, org),
    ]);

    const timeline = [
      ...meetingsToEntries(meetings),
      ...deliverablesToEntries(deliverables),
      ...weeklyReportsToEntries(weeklyReports),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // 意味検索は失敗しても他が壊れないよう独立して呼ぶ
    const relatedDiaries = await fetchRelatedDiaries(anon.url, anon.key, org);

    return NextResponse.json({ organization: org, timeline, relatedDiaries });
  } catch (error) {
    console.error("団体別タイムライン取得エラー:", error);
    return NextResponse.json(
      { error: "団体別タイムラインの取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}
