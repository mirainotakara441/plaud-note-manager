// 団体別攻略（/organizations）の共通データ層。
//
// 「タイムライン」（/api/organizations/timeline）と「タイムライン以外」
// （/api/organizations/profile）の両方が、同じ取得ロジック・同じ名寄せルールを
// 使えるように切り出したもの。取得元は3つ:
//   - 会議   : Edge Function org-history（memory_chunks の source_type=会議、organization 完全一致）
//   - 成果物 : memory_chunks 直叩き（source_type=成果物、organization 完全一致）
//   - 週報   : weekly_reports（organization ILIKE 部分一致）
//
// memory_chunks は RLS で anon の SELECT を許可していないため必ず serviceCreds()。
// weekly_reports / stakeholders は anon に SELECT を許可しているため anonCreds() でよい。
// Edge Function（org-history / search-memory）は anon キーを Bearer で呼ぶ。

import { restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

export type Meeting = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  organization: string | null;
};

export type DeliverableChunk = {
  id: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type WeeklyReportRow = {
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

// 会議1件（チャンクをまとめたもの）
export type MeetingDoc = {
  id: string;
  title: string;
  date: string;
  /** 全チャンクを位置順に連結した本文。課題・アクションの抽出はこちらを使う */
  content: string;
};

// 成果物1件（チャンクをまとめたもの）
export type DeliverableDoc = {
  id: string;
  title: string;
  date: string;
  /** 代表チャンク（位置が最小）の本文。タイムラインの要約はこちらを使う */
  leadContent: string;
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// 「{タイトル}｜{n}/{全n}」形式の末尾チャンク番号を取り除く
export function stripChunkSuffix(title: string): string {
  return title.replace(/｜\d+\/\d+$/, "").trim();
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

export async function fetchMeetings(
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

export async function fetchDeliverables(
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

export async function fetchWeeklyReports(
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

export async function fetchRelatedDiaries(
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

export type StakeholderRow = { category: string; name: string };

// ステークホルダー・マスタ。取得できなくても致命ではないので失敗時は空配列。
export async function fetchStakeholders(
  url: string,
  key: string
): Promise<StakeholderRow[]> {
  try {
    const res = await fetch(
      `${url}/rest/v1/stakeholders?select=category,name&limit=500`,
      { headers: restHeaders(key), cache: "no-store" }
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    return Array.isArray(rows) ? (rows as StakeholderRow[]) : [];
  } catch (error) {
    console.error("ステークホルダー・マスタ取得エラー（無視して続行）:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 名寄せ（チャンク → 1件）
// ---------------------------------------------------------------------------

function chunkPosition(metadata: Record<string, unknown> | null): number {
  const meta = isRecord(metadata) ? metadata : null;
  const posStr = meta ? asString(meta["位置"]) : null;
  const n = posStr ? Number(posStr.split("/")[0]) : 1;
  return Number.isFinite(n) ? n : 1;
}

// 会議もチャンク分割されている（1会議が複数のメモに分かれる）ため、
// タイトル（チャンク番号除去）＋日付でグルーピングし、1会議＝1件にまとめる。
// 代表チャンクは位置（n/全n）の n が最小のもの（概要・参加者が入っていることが多い）。
export function groupMeetings(meetings: Meeting[]): MeetingDoc[] {
  const withDate = meetings.filter((m) => !!m.event_date);
  const groups = new Map<string, Meeting[]>();
  for (const m of withDate) {
    const key = `${stripChunkSuffix(m.title)}__${m.event_date}`;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
  }

  const docs: MeetingDoc[] = [];
  for (const group of groups.values()) {
    const withPos = group
      .map((m) => ({ meeting: m, n: chunkPosition(m.metadata) }))
      .sort((a, b) => a.n - b.n);
    const rep = withPos[0].meeting;
    docs.push({
      id: rep.id,
      title: stripChunkSuffix(rep.title),
      date: rep.event_date as string,
      content:
        withPos.length > 1
          ? withPos.map((w) => w.meeting.content).join(" ")
          : rep.content,
    });
  }
  return docs;
}

// 成果物はチャンク分割されているため、資料名（無ければタイトルからチャンク番号を
// 除いたもの）＋日付でグルーピングし、1資料＝1件にまとめる。
export function groupDeliverables(chunks: DeliverableChunk[]): DeliverableDoc[] {
  const groups = new Map<string, DeliverableChunk[]>();
  for (const c of chunks) {
    const meta = isRecord(c.metadata) ? c.metadata : null;
    const docName = (meta && asString(meta["資料名"])) ?? stripChunkSuffix(c.title);
    // created_at はUTCタイムスタンプなので、event_dateが無い場合の代替キーは
    // JSTの日付に変換してから使う（さもないとJST 0時台〜8時台の登録が前日扱いになる）。
    const dateKey = c.event_date ?? toJstDateString(c.created_at);
    const key = `${docName}__${dateKey}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const docs: DeliverableDoc[] = [];
  for (const group of groups.values()) {
    const withPos = group
      .map((c) => ({ chunk: c, n: chunkPosition(c.metadata) }))
      .sort((a, b) => a.n - b.n);
    const rep = withPos[0].chunk;
    const meta = isRecord(rep.metadata) ? rep.metadata : null;
    const docName = (meta && asString(meta["資料名"])) ?? stripChunkSuffix(rep.title);
    docs.push({
      id: rep.id,
      title: docName,
      date: rep.event_date ?? toJstDateString(rep.created_at),
      leadContent: rep.content,
    });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// タイムライン化
// ---------------------------------------------------------------------------

export function meetingsToEntries(meetings: Meeting[]): TimelineEntry[] {
  return groupMeetings(meetings).map((d) => ({
    id: `meeting:${d.id}`,
    kind: "会議" as const,
    date: d.date,
    title: d.title,
    summary: d.content,
  }));
}

export function deliverablesToEntries(chunks: DeliverableChunk[]): TimelineEntry[] {
  return groupDeliverables(chunks).map((d) => ({
    id: `deliverable:${d.id}`,
    kind: "成果物" as const,
    date: d.date,
    title: d.title,
    summary: d.leadContent,
  }));
}

export function weeklyReportsToEntries(rows: WeeklyReportRow[]): TimelineEntry[] {
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

export function sortByDateDesc<T extends { date: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---------------------------------------------------------------------------
// 会議本文のセクション抽出
// ---------------------------------------------------------------------------
//
// PLAUD 由来の会議メモは「事実：… 示唆：… 課題：… アクション：…」という
// 定型フォーマットで登録されている（90チャンク中68件に「課題：」がある）。
// metadata 側には課題フィールドが無いため、本文からラベル単位で切り出す。
// ラベルは全角・半角コロン両方、「事実（外部環境）：」のような括弧付きもある。

const SECTION_LABELS = [
  "次のアクション",
  "決定事項",
  "アクション",
  "課題",
  "示唆",
  "事実",
  "背景",
  "論点",
  "リスク",
  "所感",
  "備考",
] as const;

export type SectionLabel = (typeof SECTION_LABELS)[number];

type Segment = { label: string; start: number; bodyStart: number };

function sectionSegments(content: string): Segment[] {
  const re = new RegExp(
    `(${SECTION_LABELS.join("|")})(?:（[^）]{0,20}）)?[：:]`,
    "g"
  );
  const segments: Segment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    segments.push({
      label: m[1],
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  return segments;
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 会議本文から指定ラベルの節（次のラベルまで）を取り出す。無ければ null。 */
export function extractSection(content: string, label: SectionLabel): string | null {
  const segments = sectionSegments(content);
  const idx = segments.findIndex((s) => s.label === label);
  if (idx < 0) return null;
  const end = idx + 1 < segments.length ? segments[idx + 1].start : content.length;
  const text = normalizeText(content.slice(segments[idx].bodyStart, end));
  return text === "" ? null : text;
}

/** 会議本文の「アクション」節（「次のアクション」表記も拾う） */
export function extractActionSection(content: string): string | null {
  return extractSection(content, "アクション") ?? extractSection(content, "次のアクション");
}
