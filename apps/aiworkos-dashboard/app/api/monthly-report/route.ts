import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 月報ドラフト自動生成：暦月を選ぶと、その月の週報（weekly_reports）を集計した
// KPIと、AIが書いた「今月を一言で」「団体別ハイライト」「来月への引き継ぎ」を
// 含むドラフトを生成し、monthly_reports（Supabase）とNotionへ登録する。
//
// app/api/agent/route.ts のパターンを踏襲:
//   - claude-sonnet-5 + thinking:adaptive + output_config(json_schema) で構造化出力
//   - systemプロンプトを cache_control でプレフィックスキャッシュ
//   - signature による差分検知（元データ不変ならClaudeを呼ばずキャッシュ返却）
//   - edited フラグ（手直し版があれば再生成の土台にする）
//
// thinking 有効時のVercelタイムアウト対策（agent/route.ts と同じ理由）。
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TABLE = "monthly_reports";
const WEEKLY_TABLE = "weekly_reports";

// claude-sonnet-5: 入力 $3/MTok（〜2026-08-31 は導入価格 $2）、出力 $15/MTok（同 $10）。
const MODEL = "claude-sonnet-5";

// Notion「🧠 AIワークOS」ページ配下に月報ページを作成する
const NOTION_PARENT_PAGE_ID = "3969363cfff88125988ff09a8cb32016";

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

type WeekKpi = {
  week_start: string;
  contacts: number;
  orgs: number;
  tacticsTotal: number;
  tacticsDone: number;
};

type MonthKpi = {
  weeks: WeekKpi[];
  totalContacts: number;
  totalOrgs: number;
  tacticsTotal: number;
  tacticsDone: number;
  completionRate: number; // 0〜1
};

type Highlight = { organization: string; summary: string };

type Draft = {
  oneLiner: string;
  highlights: Highlight[];
  handover: string[];
};

// monthly_reports の1行（正規化済み・camelCase）
type MonthlyReport = {
  month: string;
  kpi: MonthKpi | null;
  oneLiner: string;
  highlights: Highlight[];
  handover: string[];
  signature: string | null;
  notionUrl: string | null;
  model: string | null;
  edited: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type DbRow = {
  month: string;
  kpi: MonthKpi | null;
  one_liner: string | null;
  highlights: Highlight[] | null;
  handover: string[] | null;
  signature: string | null;
  notion_url: string | null;
  model: string | null;
  edited: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

function toMonthlyReport(row: DbRow): MonthlyReport {
  return {
    month: row.month,
    kpi: row.kpi ?? null,
    oneLiner: row.one_liner ?? "",
    highlights: Array.isArray(row.highlights) ? row.highlights : [],
    handover: Array.isArray(row.handover) ? row.handover : [],
    signature: row.signature ?? null,
    notionUrl: row.notion_url ?? null,
    model: row.model ?? null,
    edited: row.edited === true,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseMonth(month: string): { year: number; monthNum: number; start: string; end: string } {
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr);
  const monthNum = Number(mStr);
  const lastDay = new Date(year, monthNum, 0).getDate();
  const start = `${month}-01`;
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { year, monthNum, start, end };
}

async function fetchWeeklyReportsForMonth(
  c: { url: string; key: string },
  month: string
): Promise<WeeklyReportRow[]> {
  const { start, end } = parseMonth(month);
  const res = await fetch(
    `${c.url}/rest/v1/${WEEKLY_TABLE}?select=id,week_start,category,organization,summary,insight,tactic,created_at&week_start=gte.${start}&week_start=lte.${end}&order=week_start.asc,category.asc`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`週報取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as WeeklyReportRow[];
}

// tactic付きの週報行に対応する daily_actions（source='weekly_report'）の done状態を
// weekly_reports.id -> done の Map で返す（weekly-report/route.ts と同じ考え方）。
async function fetchTacticDoneMap(
  c: { url: string; key: string },
  rows: WeeklyReportRow[]
): Promise<Map<string, boolean>> {
  const ids = rows.filter((r) => r.tactic).map((r) => r.id);
  if (ids.length === 0) return new Map();
  const idList = ids.map((id) => encodeURIComponent(id)).join(",");
  const res = await fetch(
    `${c.url}/rest/v1/daily_actions?select=source_id,done&source=eq.weekly_report&source_id=in.(${idList})`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) return new Map();
  const actions: { source_id: string; done: boolean }[] = await res.json();
  const map = new Map<string, boolean>();
  for (const a of actions) map.set(a.source_id, a.done);
  return map;
}

// KPIを機械集計する（AIには渡すだけで、集計自体はここで行う。AIに数字を作らせない）。
function computeKpi(rows: WeeklyReportRow[], doneMap: Map<string, boolean>): MonthKpi {
  const byWeek = new Map<string, WeeklyReportRow[]>();
  for (const r of rows) {
    const arr = byWeek.get(r.week_start) ?? [];
    arr.push(r);
    byWeek.set(r.week_start, arr);
  }

  const weeks: WeekKpi[] = Array.from(byWeek.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week_start, weekRows]) => {
      const contacts = weekRows.filter((r) => r.category !== "全体").length;
      const orgs = new Set(weekRows.filter((r) => r.organization).map((r) => r.organization as string)).size;
      const withTactic = weekRows.filter((r) => r.tactic);
      const tacticsTotal = withTactic.length;
      const tacticsDone = withTactic.filter((r) => doneMap.get(r.id) === true).length;
      return { week_start, contacts, orgs, tacticsTotal, tacticsDone };
    });

  const totalContacts = weeks.reduce((s, w) => s + w.contacts, 0);
  const totalOrgs = new Set(rows.filter((r) => r.organization).map((r) => r.organization as string)).size;
  const tacticsTotal = weeks.reduce((s, w) => s + w.tacticsTotal, 0);
  const tacticsDone = weeks.reduce((s, w) => s + w.tacticsDone, 0);
  const completionRate = tacticsTotal > 0 ? tacticsDone / tacticsTotal : 0;

  return { weeks, totalContacts, totalOrgs, tacticsTotal, tacticsDone, completionRate };
}

// weekly_reports の件数・最新更新・文字数合計による決定的署名（agent/route.ts の
// computeSignature と同じ考え方）。いずれかが変われば（＝週報の追記・修正）
// キャッシュが無効化され、月報が再生成される。
function computeSignature(rows: WeeklyReportRow[]): string {
  const latest = rows.reduce(
    (max, r) => (r.created_at && (!max || r.created_at > max) ? r.created_at : max),
    ""
  );
  const totalChars = rows.reduce(
    (s, r) => s + (r.summary?.length ?? 0) + (r.insight?.length ?? 0) + (r.tactic?.length ?? 0),
    0
  );
  return `${rows.length}:${latest}:${totalChars}`;
}

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
週報（週次の営業活動記録）をもとに、月報ドラフトを作成します。

厳守事項:
- 必ず与えられた「週報」に書かれた事実のみに基づいて執筆すること。憶測で数字・団体名・経緯を創作してはならない。
- KPI（接点数・団体数・宿題消化率など）の数値は、与えられた「KPI集計結果」の数値だけを使うこと。自分で計算し直したり、週報本文から別の数値を導き出したりしてはならない。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 出力は必ず指定された JSON スキーマに従って構造化して返すこと。highlights・handover は必ず中身を埋め、空配列で返してはならない。`;

const MONTHLY_SCHEMA = {
  type: "object",
  properties: {
    oneLiner: {
      type: "string",
      description: "今月を一言で表す1〜2文。週報全体を通じた総括。",
    },
    highlights: {
      type: "array",
      description:
        "動きが大きかった団体を選んで3〜6件。各団体の今月の動き・進捗を簡潔にまとめる。空配列にしないこと。",
      items: {
        type: "object",
        properties: {
          organization: { type: "string", description: "団体名" },
          summary: { type: "string", description: "今月のその団体の動き・進捗の要約" },
        },
        required: ["organization", "summary"],
        additionalProperties: false,
      },
    },
    handover: {
      type: "array",
      description:
        "来月への引き継ぎ事項を優先順位順で3〜5件。次アクション（tactic）や未対応の宿題を主な材料にする。空配列にしないこと。",
      items: { type: "string" },
    },
  },
  required: ["oneLiner", "highlights", "handover"],
  additionalProperties: false,
};

function formatWeeklyRowsForPrompt(rows: WeeklyReportRow[]): string {
  const byWeek = new Map<string, WeeklyReportRow[]>();
  for (const r of rows) {
    const arr = byWeek.get(r.week_start) ?? [];
    arr.push(r);
    byWeek.set(r.week_start, arr);
  }
  const weeks = Array.from(byWeek.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (weeks.length === 0) return "（この月の週報は登録されていません）";

  return weeks
    .map(([week, weekRows]) => {
      const lines = weekRows.map((r) => {
        const parts = [`[${r.category}]`];
        if (r.organization) parts.push(r.organization);
        parts.push(`事実: ${r.summary}`);
        if (r.insight) parts.push(`示唆: ${r.insight}`);
        if (r.tactic) parts.push(`次アクション: ${r.tactic}`);
        return `- ${parts.join(" / ")}`;
      });
      return `【${week}週】\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function formatEdited(d: Draft): string {
  const lines: string[] = [];
  if (d.oneLiner) lines.push(`【今月を一言で】${d.oneLiner}`);
  if (d.highlights.length)
    lines.push(
      `【団体別ハイライト】\n${d.highlights.map((h) => `- ${h.organization}: ${h.summary}`).join("\n")}`
    );
  if (d.handover.length)
    lines.push(`【来月への引き継ぎ】\n${d.handover.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  return lines.join("\n\n");
}

function buildUserPrompt(
  month: string,
  rows: WeeklyReportRow[],
  kpi: MonthKpi,
  editedDraft: Draft | null
): string {
  const editedText = editedDraft
    ? `
========================================
以下は、前回の月報ドラフトを【吉井さん自身が手直しした版】です。AIの間違いを訂正したか、
吉井さんの考えを反映したものであり、最も信頼できる情報です。
- ここに書かれた内容は原則そのまま引き継ぐこと。特に訂正された事実・数字・固有名詞は絶対に元に戻さないこと。
- 今月の週報に新しい動きがあった場合のみ、その部分を更新・追記する。
- 吉井さんが削除した項目を復活させないこと。
==== 吉井さんが手直しした前回の月報 ====
${formatEdited(editedDraft)}
========================================
`
    : "";

  return `対象月: ${month}
${editedText}
==== KPI集計結果（この数値だけを使うこと。自分で計算し直さないこと）====
月合計: 接点数 ${kpi.totalContacts}件 / 対象団体数 ${kpi.totalOrgs}団体 / 次アクション ${kpi.tacticsTotal}件中 ${kpi.tacticsDone}件対応済み（消化率 ${Math.round(kpi.completionRate * 100)}%）
週別内訳:
${kpi.weeks.map((w) => `- ${w.week_start}週: 接点${w.contacts}件・団体${w.orgs}・次アクション${w.tacticsDone}/${w.tacticsTotal}件対応`).join("\n")}

==== 今月の週報（週別・カテゴリー別）====
${formatWeeklyRowsForPrompt(rows)}

上記の事実だけをもとに、${month}の月報ドラフトを指定の JSON スキーマで構造化して返してください。
- oneLiner: 今月を一言で（1〜2文）
- highlights: 動きが大きかった団体を3〜6件選び、それぞれの今月の動きを要約
- handover: 来月への引き継ぎを優先順位順で3〜5件（次アクションや未対応の宿題を材料にする）
いずれのフィールドも空配列のまま返してはならない。`;
}

function isComplete(d: Draft): boolean {
  return !!d.oneLiner && d.highlights.length > 0 && d.handover.length > 0;
}

async function generateDraft(
  client: Anthropic,
  month: string,
  rows: WeeklyReportRow[],
  kpi: MonthKpi,
  editedDraft: Draft | null
): Promise<Draft> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: MONTHLY_SCHEMA } },
    messages: [{ role: "user", content: buildUserPrompt(month, rows, kpi, editedDraft) }],
  });

  console.log("月報生成:", message.stop_reason, JSON.stringify(message.usage));

  if (message.stop_reason === "refusal") {
    throw new Error("refusal");
  }

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  if (!textBlock) throw new Error("no_text_output");

  let input: Partial<Draft>;
  try {
    input = JSON.parse(textBlock.text) as Partial<Draft>;
  } catch {
    throw new Error("invalid_json_output");
  }

  return {
    oneLiner: typeof input.oneLiner === "string" ? input.oneLiner : "",
    highlights: Array.isArray(input.highlights)
      ? input.highlights
          .filter(
            (h): h is Highlight =>
              !!h &&
              typeof h === "object" &&
              typeof (h as { organization?: unknown }).organization === "string" &&
              typeof (h as { summary?: unknown }).summary === "string"
          )
          .map((h) => ({ organization: h.organization, summary: h.summary }))
      : [],
    handover: Array.isArray(input.handover)
      ? input.handover.filter((s): s is string => typeof s === "string")
      : [],
  };
}

// ============ Notion REST API 連携 ============
// Notion MCPツールはこのエージェント実行環境専用でNext.js側からは使えないため、
// Notion公式REST APIを直接叩く（status/route.ts のパターンを踏襲）。

// NOTION_TOKEN（Vercel環境変数）が未設定でも、健康ダッシュボード連携
// （health-notion-sync）で動作確認済みの app_config.notion_health_sync_token を
// フォールバックとして使う。新しい秘密情報を追加せずに済ませるため。
async function notionToken(): Promise<string | null> {
  const envToken = process.env.NOTION_TOKEN;
  if (envToken && envToken.trim() !== "" && envToken !== "ntn_xxxxx") return envToken;

  const c = serviceCreds();
  if (!c) return null;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/app_config?select=value&key=eq.notion_health_sync_token`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) return null;
    const rows: { value: string }[] = await res.json();
    const token = rows[0]?.value;
    return token && token.trim() !== "" ? token : null;
  } catch {
    return null;
  }
}

function extractNotionPageId(url: string): string | null {
  const m = url.match(/([0-9a-f]{32})(?:[?#]|$)/i);
  if (!m) return null;
  const hex = m[1];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rt(content: string): { type: "text"; text: { content: string } } {
  return { type: "text", text: { content: content.slice(0, 2000) } };
}

function heading2(text: string) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [rt(text)] } };
}
function heading3(text: string) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: [rt(text)] } };
}
function paragraph(text: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [rt(text || "（記載なし）")] } };
}
function bulleted(text: string) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [rt(text)] },
  };
}
function numbered(text: string) {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: { rich_text: [rt(text)] },
  };
}

function buildNotionBlocks(month: string, kpi: MonthKpi, draft: Draft): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  blocks.push(heading2("KPI"));
  blocks.push(
    bulleted(
      `月合計: 接点数 ${kpi.totalContacts}件 / 対象団体数 ${kpi.totalOrgs}団体 / 次アクション消化率 ${Math.round(
        kpi.completionRate * 100
      )}%（${kpi.tacticsDone}/${kpi.tacticsTotal}件）`
    )
  );
  for (const w of kpi.weeks) {
    blocks.push(
      bulleted(
        `${w.week_start}週: 接点${w.contacts}件・団体${w.orgs}・次アクション${w.tacticsDone}/${w.tacticsTotal}件対応`
      )
    );
  }

  blocks.push(heading2("今月を一言で"));
  blocks.push(paragraph(draft.oneLiner));

  blocks.push(heading2("団体別ハイライト"));
  if (draft.highlights.length === 0) {
    blocks.push(paragraph("（ハイライトなし）"));
  } else {
    for (const h of draft.highlights) {
      blocks.push(heading3(h.organization));
      blocks.push(paragraph(h.summary));
    }
  }

  blocks.push(heading2("来月への引き継ぎ"));
  if (draft.handover.length === 0) {
    blocks.push(paragraph("（引き継ぎ事項なし）"));
  } else {
    for (const item of draft.handover) blocks.push(numbered(item));
  }

  return blocks;
}

function monthTitle(month: string): string {
  const { year, monthNum } = parseMonth(month);
  return `${year}年${monthNum}月 月報`;
}

async function notionPageExists(token: string, pageId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.archived !== true;
  } catch {
    return false;
  }
}

async function notionCreatePage(
  token: string,
  month: string,
  kpi: MonthKpi,
  draft: Draft
): Promise<string | null> {
  const blocks = buildNotionBlocks(month, kpi, draft);
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: NOTION_PARENT_PAGE_ID },
      properties: { title: { title: [rt(monthTitle(month))] } },
      children: blocks.slice(0, 100),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notionページ作成失敗 ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return typeof data?.url === "string" ? data.url : null;
}

async function notionDeleteAllChildren(token: string, pageId: string): Promise<void> {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return;
  const data = await res.json();
  const children: { id: string }[] = Array.isArray(data?.results) ? data.results : [];
  for (const child of children) {
    await fetch(`https://api.notion.com/v1/blocks/${child.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
}

async function notionUpdatePage(
  token: string,
  pageId: string,
  month: string,
  kpi: MonthKpi,
  draft: Draft
): Promise<string> {
  // タイトルは基本不変だが念のため同期しておく
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: { title: { title: [rt(monthTitle(month))] } } }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});

  await notionDeleteAllChildren(token, pageId);

  const blocks = buildNotionBlocks(month, kpi, draft);
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ children: blocks.slice(0, 100) }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notionページ更新失敗 ${res.status}: ${text.slice(0, 300)}`);
  }
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

// Notion登録は失敗しても致命的にはしない（結果は notionUrl なしで返す）。
async function syncNotion(
  month: string,
  kpi: MonthKpi,
  draft: Draft,
  existingUrl: string | null
): Promise<{ url: string | null; skipped?: string }> {
  const token = await notionToken();
  if (!token) {
    return { url: existingUrl, skipped: "Notionトークンが未設定のためNotion登録をスキップしました" };
  }

  try {
    const existingPageId = existingUrl ? extractNotionPageId(existingUrl) : null;
    if (existingPageId && (await notionPageExists(token, existingPageId))) {
      const url = await notionUpdatePage(token, existingPageId, month, kpi, draft);
      return { url };
    }
    const url = await notionCreatePage(token, month, kpi, draft);
    return { url };
  } catch (error) {
    console.error("Notion登録エラー（致命的ではないため続行）:", error);
    return { url: existingUrl, skipped: "Notion登録に失敗しました（ログ参照）" };
  }
}

// ============ Supabase 読み書き ============

async function fetchReportRow(
  c: { url: string; key: string },
  month: string
): Promise<DbRow | null> {
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=*&month=eq.${encodeURIComponent(month)}`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) return null;
  const rows: DbRow[] = await res.json();
  return rows[0] ?? null;
}

async function upsertReportRow(
  c: { url: string; key: string },
  row: {
    month: string;
    kpi: MonthKpi;
    one_liner: string;
    highlights: Highlight[];
    handover: string[];
    signature: string;
    notion_url: string | null;
    model: string;
    edited: boolean;
  }
): Promise<DbRow | null> {
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?on_conflict=month`, {
    method: "POST",
    headers: {
      ...restHeaders(c.key),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("monthly_reports upsert失敗:", res.status, text.slice(0, 300));
    return null;
  }
  const rows: DbRow[] = await res.json();
  return rows[0] ?? null;
}

// ============ ハンドラ ============

export async function GET(req: NextRequest) {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month")?.trim() ?? "";
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "monthはYYYY-MM形式で指定してください" }, { status: 400 });
  }

  try {
    const [row, monthsRes] = await Promise.all([
      fetchReportRow(c, month),
      fetch(`${c.url}/rest/v1/${TABLE}?select=month&order=month.desc`, {
        headers: restHeaders(c.key),
        cache: "no-store",
      }),
    ]);
    const availableMonths: string[] = monthsRes.ok
      ? (await monthsRes.json()).map((r: { month: string }) => r.month)
      : [];

    return NextResponse.json({
      report: row ? toMonthlyReport(row) : null,
      available_months: availableMonths,
    });
  } catch (error) {
    console.error("月報取得エラー:", error);
    return NextResponse.json({ error: "月報の取得に失敗しました" }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });

  let body: {
    month?: unknown;
    oneLiner?: unknown;
    highlights?: unknown;
    handover?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "monthはYYYY-MM形式で指定してください" }, { status: 400 });
  }

  const update: Record<string, unknown> = { edited: true, updated_at: new Date().toISOString() };
  if (typeof body.oneLiner === "string") update.one_liner = body.oneLiner;
  if (Array.isArray(body.highlights)) update.highlights = body.highlights;
  if (Array.isArray(body.handover)) update.handover = body.handover;

  try {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?month=eq.${encodeURIComponent(month)}`, {
      method: "PATCH",
      headers: { ...restHeaders(c.key), Prefer: "return=representation" },
      body: JSON.stringify(update),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `更新失敗 ${res.status}`, detail: text.slice(0, 200) },
        { status: 502 }
      );
    }
    const rows: DbRow[] = await res.json();
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "対象の月報が見つかりません" }, { status: 404 });

    // Notion側も可能なら同期更新（失敗しても致命的にしない）
    let notionUrl = row.notion_url ?? null;
    if (row.notion_url && row.kpi) {
      const draft: Draft = {
        oneLiner: row.one_liner ?? "",
        highlights: Array.isArray(row.highlights) ? row.highlights : [],
        handover: Array.isArray(row.handover) ? row.handover : [],
      };
      const synced = await syncNotion(month, row.kpi, draft, row.notion_url);
      notionUrl = synced.url;
      if (notionUrl && notionUrl !== row.notion_url) {
        await fetch(`${c.url}/rest/v1/${TABLE}?month=eq.${encodeURIComponent(month)}`, {
          method: "PATCH",
          headers: restHeaders(c.key),
          body: JSON.stringify({ notion_url: notionUrl }),
          cache: "no-store",
        }).catch(() => {});
      }
    }

    return NextResponse.json({ saved: true, report: toMonthlyReport({ ...row, notion_url: notionUrl }) });
  } catch {
    return NextResponse.json({ error: "手直しの保存に失敗しました" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const anon = anonCreds();
  const service = serviceCreds();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }
  if (!anthropicKey || anthropicKey.trim() === "" || anthropicKey === "sk-ant-xxxxx") {
    return NextResponse.json(
      { error: "ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。" },
      { status: 500 }
    );
  }

  let body: { month?: unknown; force?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "monthはYYYY-MM形式で指定してください" }, { status: 400 });
  }
  const force = body.force === true;

  // 1. 対象月の週報取得 + KPI機械集計
  let rows: WeeklyReportRow[];
  let kpi: MonthKpi;
  try {
    rows = await fetchWeeklyReportsForMonth(anon, month);
    const doneMap = await fetchTacticDoneMap(anon, rows);
    kpi = computeKpi(rows, doneMap);
  } catch (error) {
    console.error("週報取得エラー:", error);
    return NextResponse.json({ error: "週報の取得に失敗しました" }, { status: 502 });
  }

  // 2. signature計算 + 既存キャッシュ確認
  const signature = computeSignature(rows);
  const existing = await fetchReportRow(anon, month);
  const existingReport = existing ? toMonthlyReport(existing) : null;

  if (!force && existingReport && existingReport.signature === signature) {
    return NextResponse.json({
      month,
      kpi,
      oneLiner: existingReport.oneLiner,
      highlights: existingReport.highlights,
      handover: existingReport.handover,
      cached: true,
      edited: existingReport.edited,
      notionUrl: existingReport.notionUrl,
    });
  }

  // 手直しされた版があれば再生成の土台にする
  const editedDraft: Draft | null = existingReport?.edited
    ? {
        oneLiner: existingReport.oneLiner,
        highlights: existingReport.highlights,
        handover: existingReport.handover,
      }
    : null;

  // 3. Claudeで生成
  const client = new Anthropic({ apiKey: anthropicKey });
  let draft: Draft;
  try {
    draft = await generateDraft(client, month, rows, kpi, editedDraft);
    if (!isComplete(draft)) throw new Error("empty_draft");
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401) {
      return NextResponse.json(
        { error: "ANTHROPIC_APIキーが無効です。.env.local の ANTHROPIC_API_KEY を確認してください。" },
        { status: 500 }
      );
    }
    console.error("月報生成エラー:", error);
    return NextResponse.json(
      { error: "AIによる月報生成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }

  // 4. Notion登録（作成 or 更新。失敗しても致命的にしない）
  const notionResult = await syncNotion(month, kpi, draft, existingReport?.notionUrl ?? null);
  if (notionResult.skipped) {
    console.log("Notion登録スキップ:", notionResult.skipped);
  }

  // 5. Supabaseへ保存（editedは手直し版を土台にした場合のみ維持）
  const saved = await upsertReportRow(service, {
    month,
    kpi,
    one_liner: draft.oneLiner,
    highlights: draft.highlights,
    handover: draft.handover,
    signature,
    notion_url: notionResult.url,
    model: MODEL,
    edited: !!editedDraft,
  });
  if (!saved) {
    console.error("monthly_reportsへの保存に失敗しましたが、生成結果は返却します");
  }

  return NextResponse.json({
    month,
    kpi,
    oneLiner: draft.oneLiner,
    highlights: draft.highlights,
    handover: draft.handover,
    cached: false,
    edited: !!editedDraft,
    notionUrl: notionResult.url,
    notionSkippedReason: notionResult.skipped ?? null,
  });
}
