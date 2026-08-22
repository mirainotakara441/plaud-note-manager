import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import {
  correctTranscription,
  correctTranscriptionMany,
  summarizeCorrections,
} from "@/lib/transcriptionDictionary";
import { isLlmConfigured, isAuthError, AUTH_ERROR_MESSAGE, structured } from "@/lib/llm";

// 週報ダッシュボード：週次の営業活動（支店・自治体・事業者・議員・委託会社・銀行・
// プロモーション・全体）をカテゴリー別に構造化した weekly_reports を読む。
// 読み取りは anonキー、書き込み（PATCH・POST）は service role キーで叩く
// （2026-07-25 レビュー対応）。
//
// POST は「週報テキストを貼るだけで登録」の窓口。従来は週報登録スキル（チャット）
// 経由でしか登録できなかったが、ダッシュボードからも同じ結果になるよう、
// スキルの Step 1（カテゴリー読み替え・ユニットの分解・全体の限定）をそのまま
// システムプロンプトへ移植した。分類基準を変えるときは両方直すこと。
//
// 週報は1週間の活動の集約点で、積み上がって月報・年報になり、その都度レビューの
// 土台になる。そのため登録・編集のたびに memory_chunks(source_type=週報) へも運び、
// 検索や提案エージェントから「あの団体、前どうやったか」を引けるようにする。
//
// thinking 有効時のVercelタイムアウト対策（app/api/diary/route.ts と同じ理由）。
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TABLE = "weekly_reports";

const CATEGORIES = [
  "全体",
  "支店",
  "自治体",
  "事業者",
  "議員",
  "委託会社",
  "銀行",
  "プロモーション",
] as const;
type Category = (typeof CATEGORIES)[number];

type WeeklyReportRow = {
  id: string;
  tactic: string | null;
  [key: string]: unknown;
};

type RowWithActionDone = WeeklyReportRow & { action_done: boolean | null };

function headers(key: string): Record<string, string> {
  return restHeaders(key);
}

// ============ 記憶層（memory_chunks）への連携 ============
//
// 週報1行＝1チャンク。organization を持たせるので、団体名での絞り込みがそのまま効く。
// source_id は週報行のUUIDに紐づけるため、同じ行を編集し直しても増殖しない
// （purge → store の順で入れ替える。app/api/retrospective/route.ts と同じ作法）。

type MemoryRow = {
  id: string;
  week_start: string;
  category: string;
  organization: string | null;
  summary: string | null;
  insight: string | null;
  tactic: string | null;
};

function memoryPrefix(id: string): string {
  return `weekly_report:${id}`;
}

/** 週報1行を、検索で意味が通る1本のテキストにする。 */
function rowToMemoryText(r: MemoryRow): string {
  const head = `【${r.week_start}週／${r.category}${r.organization ? `／${r.organization}` : ""}】`;
  const parts = [head];
  if (r.summary) parts.push(`■動き\n${r.summary}`);
  if (r.insight) parts.push(`■反応・示唆\n${r.insight}`);
  if (r.tactic) parts.push(`■次アクション\n${r.tactic}`);
  return parts.join("\n\n");
}

/**
 * 週報1行を記憶層へ入れ直す。
 * 記憶層への保存が失敗しても週報の登録自体は成功扱いにする（本体はweekly_reports側で、
 * 記憶層は検索用の写しのため）。ただし黙って落とさず、失敗件数を呼び出し元へ返す。
 */
async function storeRowMemory(
  anon: { url: string; key: string },
  r: MemoryRow
): Promise<boolean> {
  const prefix = memoryPrefix(r.id);
  try {
    await fetch(`${anon.url}/functions/v1/purge-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id_prefix: prefix }),
      cache: "no-store",
    });

    const res = await fetch(`${anon.url}/functions/v1/store-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "週報",
        source_id: `${prefix}:1`,
        organization: r.organization,
        title: `${r.week_start}週｜${r.category}${r.organization ? `｜${r.organization}` : ""}`,
        content: rowToMemoryText(r),
        event_date: r.week_start,
        metadata: {
          種別: "週報",
          カテゴリ: r.category,
          週: r.week_start,
          ...(r.organization ? { 団体: r.organization } : {}),
        },
      }),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === "stored";
  } catch (err) {
    console.error("週報の記憶層保存に失敗:", err);
    return false;
  }
}

/** 週報行を記憶層から消す（行を削除・入れ替えたとき用）。 */
async function purgeRowMemory(
  anon: { url: string; key: string },
  ids: string[]
): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      fetch(`${anon.url}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: memoryPrefix(id) }),
        cache: "no-store",
      }).catch((err) => console.error("週報の記憶層削除に失敗:", err))
    )
  );
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
  } catch (err) {
    console.error("PATCH /api/weekly-report: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  // ★音声入力の誤変換を、貼り付け・手直しされた本文が入ってきたこの1か所で直す。
  // 3フィールドまとめて1回の辞書取得で処理する。辞書が取れなければ素通し。
  const rawSummary = "summary" in body && typeof body.summary === "string" ? body.summary : null;
  const rawInsight = "insight" in body && typeof body.insight === "string" ? body.insight : null;
  const rawTactic = "tactic" in body && typeof body.tactic === "string" ? body.tactic : null;
  const corrected = await correctTranscriptionMany([
    rawSummary ?? "",
    rawInsight ?? "",
    rawTactic ?? "",
  ]);
  const [fixedSummary, fixedInsight, fixedTactic] = corrected.texts;

  const update: Record<string, string | null> = {};
  if ("summary" in body) {
    update.summary = rawSummary !== null ? fixedSummary : null;
  }
  if ("insight" in body) {
    update.insight = rawInsight !== null ? fixedInsight : null;
  }
  if ("tactic" in body) {
    update.tactic = rawTactic !== null ? fixedTactic : null;
  }

  try {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
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
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: "更新対象の週報が見つかりません" },
        { status: 404 }
      );
    }
    // 手直しした内容を記憶層へも反映する（写しが古いままだと、検索で拾った文が
    // 画面の文と食い違う）。失敗しても保存自体は成功として返す。
    const anon = anonCreds();
    if (anon) await storeRowMemory(anon, rows[0] as MemoryRow);

    return NextResponse.json({
      row: rows[0],
      corrections: corrected.replacements,
      correctionTotal: corrected.total,
      correctionMessage: summarizeCorrections(corrected.replacements, corrected.total),
    });
  } catch (err) {
    console.error("PATCH /api/weekly-report: 通信エラー", err);
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
  }
}

// ============ POST: 週報テキストを貼るだけで登録 ============

type ParsedRow = {
  category: string;
  organization: string;
  summary: string;
  insight: string;
  tactic: string;
};

const WEEKLY_REPORT_SCHEMA = {
  type: "object",
  properties: {
    week_start: {
      type: "string",
      description:
        "その週の月曜日（YYYY-MM-DD）。本文中の日付群のうち最も早い平日が属する週の月曜とする。",
    },
    rows: {
      type: "array",
      description: "週報を8分類に分解した行の配列。漏れなくすべて抽出すること。",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [...CATEGORIES],
            description: "8分類のいずれか。",
          },
          organization: {
            type: "string",
            description:
              "対象の団体・支店・案件名。全体カテゴリーの行は空文字にする。",
          },
          summary: {
            type: "string",
            description: "いつ・誰と・何があったかの事実。",
          },
          insight: {
            type: "string",
            description: "反応・温度感・示唆。書かれていなければ空文字。",
          },
          tactic: {
            type: "string",
            description: "次のアクション・宿題・次回訪問予定。書かれていなければ空文字。",
          },
        },
        required: ["category", "organization", "summary", "insight", "tactic"],
        additionalProperties: false,
      },
    },
  },
  required: ["week_start", "rows"],
  additionalProperties: false,
};

const WEEKLY_REPORT_SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの週報を、8分類に構造化するアシスタントです。

見出しの読み替え（見出し表記は毎回微妙に揺れる。以下の対応で8分類に落とし込むこと）:
- 【全体】→ 全体行に入れるのは事業部・部全体の話のみ（部月報会・合宿・課金検討・OS部連携等）。同じ【全体】ブロック内でも支店・プロモーションに関する記述は該当カテゴリーへ分離する。特定の自治体名の話が【全体】に埋め込まれていても、既に【自治体】側に同じ団体の行があるなら重複させず、無ければ自治体の行として独立させる。
- 【支店】またはユニット名に支店が出てくるもの → 支店（organizationは支店名）
- 【自治体】→ 自治体
- 【ユニット】セクション（例:「熊本市ユニット」「豊島区・新宿区ユニット」「横浜市・相模原ユニット」）→ 中に出てくる自治体名ごとに自治体カテゴリーの行として分解する（ユニット名自体は行にしない）
- 国政関連の記述（議員連盟等）→ 議員
- 【議員】→ 議員（個人名が無く「◯◯市議員（ロビー活動）」「◯◯勉強会」のような案件単位の場合も、その名称をそのままorganizationにしてよい。無理に個人名を作らない）
- 【事業者】→ 事業者
- 【委託会社】→ 委託会社（「委託企業」ではなく必ず「委託会社」と表記する）
- 【銀行】→ 銀行
- 【プロモーション】→ プロモーション（全体に含めない。独立カテゴリー）
- 上記どれにも当てはまらない見出しは、最も近いカテゴリーに寄せる（無理に「その他」を作らない。8分類のいずれかに必ず収める）

団体の重複統合:
- 同じ週報内で同じ団体が【自治体】と【ユニット】など「同じカテゴリーに属するはずの複数セクション」にまたがって出てくる場合は、1つの行にまとめる（summaryを連結）。重複登録しないこと。
- 一方、同じ団体が【自治体】と【議員】の両方に出てくる場合は、現場交渉と議員ロビー活動という別チャネルの話なので、カテゴリーごとに別行のままでよい（無理に統合しない）。

summary / insight / tactic への振り分け:
- summary: いつ・誰と・何があったかの事実
- insight: 反応・温度感・示唆（「係長の反応は低い」等）。書かれていなければ空文字
- tactic: ★印の宿題、次回訪問予定、次のアクション。書かれていなければ空文字
- 粒度は簡潔に。原文の体裁を保ったまま無理に整形しすぎない

week_start の決定:
- 本文中に複数の日付（M/D形式）が出てくる。それらが月〜土に収まっているか確認し、含まれる最も早い平日の週の月曜をweek_startとする。
- 月日のみの表記は、ユーザープロンプトで渡す「今日の日付」を基準に年を判断すること（通常は同じ年。年をまたぐ場合のみ調整）。

厳守事項:
- 事実・固有名詞・数字は創作せず、必ず元のテキストに書かれた内容だけを使うこと。音声入力（PLAUD NotePin）由来の誤字脱字は文脈から自然に補正してよいが、内容や意味を変えないこと。
- 「なし」とだけ書かれたカテゴリーは行を作らない。
- 出力は必ず指定されたJSONスキーマに従うこと。`;

function todayJst(): string {
  const jstMs = Date.now() + 9 * 3600 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

function buildWeeklyReportUserPrompt(text: string): string {
  return `今日の日付: ${todayJst()}

==== 貼り付けられた週報本文 ====
${text}
==== ここまで ====

上記を8分類に分解し、指定のJSONスキーマで構造化して返してください。`;
}

/** YYYY-MM-DD が実在する月曜日かどうか（UTC基準で曜日判定。週の切替キーはlocal日付を使わないため）。 */
function isMondayDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCDay() === 1;
}

function normalizeRow(raw: unknown): ParsedRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const category = typeof r.category === "string" ? r.category : "";
  if (!(CATEGORIES as readonly string[]).includes(category)) return null;
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) return null;
  return {
    category,
    organization: typeof r.organization === "string" ? r.organization.trim() : "",
    summary,
    insight: typeof r.insight === "string" ? r.insight.trim() : "",
    tactic: typeof r.tactic === "string" ? r.tactic.trim() : "",
  };
}

async function parseWeeklyReport(
  text: string
): Promise<{ week_start: string; rows: ParsedRow[] }> {
  const parsed = await structured<{ week_start?: unknown; rows?: unknown }>({
    system: WEEKLY_REPORT_SYSTEM_PROMPT,
    prompt: buildWeeklyReportUserPrompt(text),
    schema: WEEKLY_REPORT_SCHEMA,
    maxTokens: 8000,
    label: "週報解析",
  });

  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows = rawRows
    .map((r) => normalizeRow(r))
    .filter((r): r is ParsedRow => r !== null);

  const weekStart = typeof parsed.week_start === "string" ? parsed.week_start : "";
  return { week_start: weekStart, rows };
}

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }
  if (!isLlmConfigured()) {
    return NextResponse.json(
      { error: "ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。" },
      { status: 500 }
    );
  }

  let body: { text?: unknown; week_start?: unknown; replace?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/weekly-report: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  if (!rawText) {
    return NextResponse.json({ error: "週報本文を貼り付けてください" }, { status: 400 });
  }
  const weekOverride =
    typeof body.week_start === "string" && isMondayDateString(body.week_start)
      ? body.week_start
      : null;
  const replace = body.replace === true;

  // ★音声入力の誤変換を、貼り付け本文が入ってきたこの1か所で直す（app/api/diary/route.ts と同じ理由）。
  const corrected = await correctTranscription(rawText);
  const text = corrected.text;

  let parsed: { week_start: string; rows: ParsedRow[] };
  try {
    parsed = await parseWeeklyReport(text);
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: AUTH_ERROR_MESSAGE }, { status: 500 });
    }
    console.error("週報解析エラー:", error);
    return NextResponse.json(
      { error: "AIによる週報の解析に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }

  const weekStart = weekOverride ?? parsed.week_start;
  if (!isMondayDateString(weekStart)) {
    return NextResponse.json(
      {
        error:
          "週の判定に失敗しました（月曜日の日付にできませんでした）。対象週を指定して登録し直してください。",
        detectedWeekStart: parsed.week_start || null,
      },
      { status: 422 }
    );
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json(
      { error: "週報の内容を認識できませんでした。見出し（【自治体】等）が分かる形で貼り直してください。" },
      { status: 400 }
    );
  }

  // 既に同じ週が登録済みなら、replace指定が無い限り上書きしない（無断の二重登録を防ぐ）。
  const existingRes = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id&week_start=eq.${weekStart}`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!existingRes.ok) {
    const detail = await existingRes.text().catch(() => "");
    return NextResponse.json(
      { error: `既存確認に失敗しました ${existingRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const existingRows: { id: string }[] = await existingRes.json();
  if (existingRows.length > 0 && !replace) {
    return NextResponse.json(
      {
        error: `${weekStart} 週は既に${existingRows.length}件登録済みです。上書きする場合は再度「上書きして登録」を選んでください。`,
        needsConfirmation: true,
        week_start: weekStart,
        existingCount: existingRows.length,
      },
      { status: 409 }
    );
  }
  if (existingRows.length > 0 && replace) {
    const delRes = await fetch(`${c.url}/rest/v1/${TABLE}?week_start=eq.${weekStart}`, {
      method: "DELETE",
      headers: headers(c.key),
      cache: "no-store",
    });
    if (!delRes.ok) {
      const detail = await delRes.text().catch(() => "");
      return NextResponse.json(
        { error: `既存データの削除に失敗しました ${delRes.status}`, detail: detail.slice(0, 200) },
        { status: 502 }
      );
    }
  }

  const values = parsed.rows.map((r) => ({
    week_start: weekStart,
    category: r.category,
    organization: r.organization || null,
    summary: r.summary,
    insight: r.insight || null,
    tactic: r.tactic || null,
  }));

  const insertRes = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: { ...headers(c.key), Prefer: "return=representation" },
    body: JSON.stringify(values),
    cache: "no-store",
  });
  if (!insertRes.ok) {
    const detail = await insertRes.text().catch(() => "");
    return NextResponse.json(
      { error: `登録に失敗しました ${insertRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const inserted: MemoryRow[] = await insertRes.json();

  const categoryCounts: Record<string, number> = {};
  for (const row of inserted) {
    categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + 1;
  }

  // 記憶層へ運ぶ。上書き登録なら、消えた古い行の写しも先に片付ける。
  let memoryStored = 0;
  const anon = anonCreds();
  if (anon) {
    if (existingRows.length > 0 && replace) {
      await purgeRowMemory(anon, existingRows.map((r) => r.id));
    }
    const results = await Promise.all(inserted.map((r) => storeRowMemory(anon, r)));
    memoryStored = results.filter(Boolean).length;
  }

  return NextResponse.json({
    week_start: weekStart,
    total: inserted.length,
    categories: categoryCounts,
    replaced: existingRows.length > 0 && replace,
    memoryStored,
    correctionMessage: summarizeCorrections(corrected.replacements, corrected.total),
  });
}
