import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 一行日記の断絶解消（本命）：
//   断絶A: Claude Projects → Notion一行日記DB への転記が「週1回まとめて手動」で滞る
//   断絶B: Notion一行日記DB → Supabase memory_chunks(source_type=日記) へ運ぶ仕組みが無い
// このAPIは、Claude Projectsで書いた日記本文を貼るだけで、
//   1) Claudeで日ごとのエントリに構造化
//   2) Notion一行日記DBへ登録（重複は日付でスキップ）
//   3) 作成したNotionページURLをsource_idにしてstore-memoryでSupabaseへ登録
// を一度にやる。app/api/monthly-report/route.ts の構造化出力・Notion REST連携の
// 作法をそのまま踏襲している。
//
// thinking 有効時のVercelタイムアウト対策（monthly-report/route.ts と同じ理由）。
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// claude-sonnet-5: 入力 $3/MTok（〜2026-08-31 は導入価格 $2）、出力 $15/MTok（同 $10）。
const MODEL = "claude-sonnet-5";

// Notion「一行日記」DB
const NOTION_DATABASE_ID = "3dda2c5f-873a-4d23-b763-abbf78d6eb54";

const TAGS = [
  "自治体",
  "事業者",
  "振り返り",
  "アイデア",
  "ツール活用",
  "家族",
  "健康",
  "その他",
] as const;
type Tag = (typeof TAGS)[number];

type DiaryEntry = {
  date: string; // YYYY-MM-DD
  title: string; // "M/D <見出し>"
  tags: Tag[];
  impression: string;
  insight: string;
  actions: string[];
  points: string[];
};

type EntryResult = {
  date: string;
  title: string;
  status: "created" | "skipped" | "error";
  notionUrl: string | null;
  reason?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DIARY_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      description:
        "貼り付けられたテキストに含まれる日ごとの一行日記エントリ。複数日ぶんが含まれる場合は漏れなくすべて抽出すること。",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "西暦YYYY-MM-DD形式のその日の日付" },
          title: {
            type: "string",
            description:
              "「M/D <見出し>」形式のタイトル。元テキストに【転】等のタグ表記があれば見出しの先頭にそのまま残す。",
          },
          tags: {
            type: "array",
            description: "次の8種類から1〜3個選ぶ",
            items: { type: "string", enum: [...TAGS] },
          },
          impression: { type: "string", description: "「印象的だったこと」の内容（1〜2文）" },
          insight: { type: "string", description: "「そうか（気づき・本質・示唆）」の内容（1〜2文）" },
          actions: {
            type: "array",
            description: "「やってみよう」の具体行動。1〜3個、1項目1文。",
            items: { type: "string" },
          },
          points: {
            type: "array",
            description: "「本日の要点3つ」。必ず3つ。",
            items: { type: "string" },
          },
        },
        required: ["date", "title", "tags", "impression", "insight", "actions", "points"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

const DIARY_SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの一行日記を構造化するアシスタントです。
入力は、吉井さんがiPhoneのClaude Projectsアプリで毎日書いている一行日記の本文です。1回のテキストに複数日ぶんがまとめて貼られることがあります。

一行日記のフォーム（固定）:
◇印象的だったこと
◇そうか（気づき・本質・示唆）
◇やってみよう（具体行動1〜3個）
◇本日の要点3つ（声に出して復唱する3つの要点）

厳守事項:
- 入力に含まれる日ごとのエントリを漏れなくすべて抽出すること。日付の見出し（例: 「7/25」「7/25(金)」「2026-07-25」等）で区切って判断する。
- 各エントリの date は西暦YYYY-MM-DD形式で決定する。月日のみの表記（例:「7/25」）は、ユーザープロンプトで渡す「今日の日付」を基準に年を判断すること（通常は同じ年。年をまたぐ場合のみ調整）。
- title は「M/D <見出し>」の形式（例: "7/20 【転】平和地区、大変に素晴らしい座談会"）。元テキストに【転】などのタグ表記があれば見出しの先頭にそのまま残すこと。無ければ、その日の内容から10〜25字程度の短い見出しを作る。
- 事実・固有名詞・数字は創作せず、必ず元のテキストに書かれた内容だけを使うこと。音声入力（PLAUD NotePin）由来の誤字脱字は文脈から自然に補正してよいが、内容や意味を変えないこと。
- impression / insight は元の「印象的だったこと」「そうか」の内容を1〜2文程度でまとめる。要約しすぎて固有名詞や数字を落とさないこと。文末は句点「。」で終えること。
- actions（やってみよう）は元テキストの具体行動を1〜3個の配列にする。1項目1文、文末に句点は付けない。
- points（本日の要点3つ）は必ず3つの配列にする。元テキストに「本日の要点」の記載があればそれを3つに割って使い、無ければ impression/insight/actions の内容から要点を3つ抽出・要約して作る。1項目1文、文末に句点は付けない。
- tags は 自治体・事業者・振り返り・アイデア・ツール活用・家族・健康・その他 の8種類から、内容に合うものを1〜3個選ぶ。
- 吉井さん本人の一人称の言葉遣い・文体をそのまま活かすこと（書き換えたり関西弁化したりしない）。
- 出力は必ず指定されたJSONスキーマに従うこと。`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildDiaryUserPrompt(text: string): string {
  return `今日の日付: ${today()}

==== 貼り付けられた一行日記本文 ====
${text}
==== ここまで ====

上記から、日ごとのエントリをすべて抽出し、指定のJSONスキーマで構造化して返してください。`;
}

function normalizeEntry(raw: unknown): DiaryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const date = typeof r.date === "string" && DATE_RE.test(r.date) ? r.date : null;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const impression = typeof r.impression === "string" ? r.impression.trim() : "";
  const insight = typeof r.insight === "string" ? r.insight.trim() : "";
  const actions = Array.isArray(r.actions)
    ? r.actions
        .filter((a): a is string => typeof a === "string" && a.trim() !== "")
        .map((a) => a.trim())
    : [];
  const points = Array.isArray(r.points)
    ? r.points
        .filter((p): p is string => typeof p === "string" && p.trim() !== "")
        .map((p) => p.trim())
    : [];
  const tags = Array.isArray(r.tags)
    ? (r.tags.filter(
        (t): t is Tag => typeof t === "string" && (TAGS as readonly string[]).includes(t)
      ) as Tag[])
    : [];

  if (!date || !title || !impression || !insight || actions.length === 0) return null;

  return {
    date,
    title,
    tags: tags.length > 0 ? tags.slice(0, 3) : ["その他"],
    impression,
    insight,
    actions,
    points,
  };
}

async function parseDiaryEntries(client: Anthropic, text: string): Promise<DiaryEntry[]> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: DIARY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: DIARY_SCHEMA } },
    messages: [{ role: "user", content: buildDiaryUserPrompt(text) }],
  });

  console.log("日記解析:", message.stop_reason, JSON.stringify(message.usage));

  if (message.stop_reason === "refusal") {
    throw new Error("refusal");
  }

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  if (!textBlock) throw new Error("no_text_output");

  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(textBlock.text) as { entries?: unknown };
  } catch (err) {
    console.error("日記解析: Claude出力のJSON解析失敗", err);
    throw new Error("invalid_json_output");
  }

  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return rawEntries
    .map((r) => normalizeEntry(r))
    .filter((e): e is DiaryEntry => e !== null);
}

// ============ Notion REST API 連携 ============
// app/api/monthly-report/route.ts の notionToken() をそのまま踏襲。

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
  } catch (err) {
    console.error("notionToken: app_config取得失敗", err);
    return null;
  }
}

function rt(content: string) {
  return { type: "text", text: { content: content.slice(0, 2000) } };
}

function rtBold(content: string) {
  return {
    type: "text",
    text: { content: content.slice(0, 2000) },
    annotations: { bold: true },
  };
}

function boldParagraph(text: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [rtBold(text)] } };
}
function paragraphBlock(text: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [rt(text || "（記載なし）")] } };
}
function bulletedBlock(text: string) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [rt(text)] },
  };
}

function buildDiaryBlocks(e: DiaryEntry): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  blocks.push(boldParagraph("印象的だったこと"));
  blocks.push(paragraphBlock(e.impression));
  blocks.push(boldParagraph("そうか"));
  blocks.push(paragraphBlock(e.insight));
  blocks.push(boldParagraph("やってみよう"));
  for (const a of e.actions) blocks.push(bulletedBlock(a));
  blocks.push(boldParagraph("本日の要点3つ"));
  if (e.points.length === 0) {
    blocks.push(paragraphBlock(""));
  } else {
    for (const p of e.points) blocks.push(bulletedBlock(p));
  }
  return blocks;
}

// 同じ日付のページが既にあればそのURLを返す（重複防止）
async function notionFindByDate(token: string, date: string): Promise<string | null> {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filter: { property: "日付", date: { equals: date } } }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notion重複確認エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const results: { url?: string; archived?: boolean }[] = Array.isArray(data?.results)
    ? data.results
    : [];
  const hit = results.find((r) => !r.archived && typeof r.url === "string");
  return hit?.url ?? null;
}

async function notionCreateDiaryPage(token: string, e: DiaryEntry): Promise<string | null> {
  const blocks = buildDiaryBlocks(e);
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Name: { title: [rt(e.title)] },
        日付: { date: { start: e.date } },
        タグ: { multi_select: e.tags.map((t) => ({ name: t })) },
        書き出し元: { select: { name: "Claudeプロジェクト" } },
      },
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

// ============ Supabase memory_chunks 登録 ============
// 既存196件の実データ形式（source_type=日記）に厳密に揃える。
// 「やってみよう：」「本日の要点3つ：」の見出し表記は、DB関数 import_diary_actions が
// 正規表現で抽出するため厳守（app/api/cron/daily-todo/route.ts の import_diary_actions 参照）。

function ensureFullStop(s: string): string {
  const t = s.trim();
  if (t === "") return t;
  return /[。！？]$/.test(t) ? t : `${t}。`;
}

function buildDiaryContent(e: DiaryEntry): string {
  const impression = ensureFullStop(e.impression);
  const insight = ensureFullStop(e.insight);
  const actionsText = e.actions.join("。");
  let content = `印象的だったこと：${impression}そうか：${insight}やってみよう：${actionsText}`;
  const pointsText = e.points.join("。");
  if (pointsText) {
    content += `。本日の要点3つ：${pointsText}`;
  }
  return content;
}

async function storeDiaryMemory(
  anon: { url: string; key: string },
  e: DiaryEntry,
  notionUrl: string
): Promise<boolean> {
  try {
    const res = await fetch(`${anon.url}/functions/v1/store-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "日記",
        source_id: notionUrl,
        title: e.title,
        content: buildDiaryContent(e),
        event_date: e.date,
        metadata: { タグ: e.tags },
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("storeDiaryMemory: store-memory失敗", res.status, text.slice(0, 300));
      return false;
    }
    const data = await res.json();
    return data?.status === "stored";
  } catch (err) {
    console.error("storeDiaryMemory: store-memory呼び出し失敗", err);
    return false;
  }
}

// ============ ハンドラ ============

export async function POST(req: NextRequest) {
  const anon = anonCreds();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anon) {
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

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/diary: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "日記本文を貼り付けてください" }, { status: 400 });
  }

  const token = await notionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Notionトークンが未設定です。NOTION_TOKEN を確認してください。" },
      { status: 500 }
    );
  }

  // 1. Claudeで日ごとのエントリに構造化
  const client = new Anthropic({ apiKey: anthropicKey });
  let entries: DiaryEntry[];
  try {
    entries = await parseDiaryEntries(client, text);
    if (entries.length === 0) throw new Error("no_entries");
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401) {
      return NextResponse.json(
        { error: "ANTHROPIC_APIキーが無効です。.env.local の ANTHROPIC_API_KEY を確認してください。" },
        { status: 500 }
      );
    }
    if ((error as Error)?.message === "no_entries") {
      return NextResponse.json(
        { error: "日記のエントリを認識できませんでした。日付が分かる形で貼り直してください。" },
        { status: 400 }
      );
    }
    console.error("日記解析エラー:", error);
    return NextResponse.json(
      { error: "AIによる日記の解析に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }

  // 2. 日付ごとに重複チェック → Notion登録 → Supabase登録
  const results: EntryResult[] = [];
  for (const e of entries) {
    let existingUrl: string | null;
    try {
      existingUrl = await notionFindByDate(token, e.date);
    } catch (error) {
      console.error("Notion重複確認エラー:", error);
      results.push({
        date: e.date,
        title: e.title,
        status: "error",
        notionUrl: null,
        reason: "Notionの重複確認に失敗しました",
      });
      continue;
    }

    if (existingUrl) {
      results.push({ date: e.date, title: e.title, status: "skipped", notionUrl: existingUrl });
      continue;
    }

    let notionUrl: string | null;
    try {
      notionUrl = await notionCreateDiaryPage(token, e);
    } catch (error) {
      console.error("Notion登録エラー:", error);
      results.push({
        date: e.date,
        title: e.title,
        status: "error",
        notionUrl: null,
        reason: "Notionへの登録に失敗しました",
      });
      continue;
    }
    if (!notionUrl) {
      results.push({
        date: e.date,
        title: e.title,
        status: "error",
        notionUrl: null,
        reason: "Notionページの作成結果が不正です",
      });
      continue;
    }

    const stored = await storeDiaryMemory(anon, e, notionUrl);
    results.push({
      date: e.date,
      title: e.title,
      status: "created",
      notionUrl,
      reason: stored ? undefined : "Notion登録は完了しましたが、記憶(Supabase)への登録に失敗しました",
    });
  }

  const created = results.filter((r) => r.status === "created").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  return NextResponse.json({ created, skipped, errors, results });
}
