import { NextRequest, NextResponse } from "next/server";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { correctTranscription, summarizeCorrections } from "@/lib/transcriptionDictionary";
import { toJstDateString } from "@/lib/date";

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
// モデルの指定は lib/llm.ts の DEFAULT_MODEL に集約している（env AIWORKOS_MODEL で差し替え可）。

// Notion「一行日記」DB。
// env優先・現行のハードコード値をフォールバックに統一（/api/status が使う
// NOTION_DB_DIARY と同じ環境変数名を共有する）。env未設定でも従来どおり動く。
const NOTION_DATABASE_ID =
  process.env.NOTION_DB_DIARY?.trim() || "3dda2c5f-873a-4d23-b763-abbf78d6eb54";

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
  return toJstDateString(new Date().toISOString());
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

async function parseDiaryEntries(text: string): Promise<DiaryEntry[]> {
  // 拒否・打ち切り・空応答の判定と、stop_reason/usage のログは structured() 側で行う。
  const parsed = await structured<{ entries?: unknown }>({
    system: DIARY_SYSTEM_PROMPT,
    prompt: buildDiaryUserPrompt(text),
    schema: DIARY_SCHEMA,
    maxTokens: 8000,
    label: "日記解析",
  });

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

// 記憶(Supabase memory_chunks)に同じ日付の日記が既にあるか。
// memory_chunks は RLS で anon の SELECT が通らないため、
// /api/diary/status と同じく serviceCreds() で確認する。
async function diaryMemoryExists(
  svc: { url: string; key: string },
  date: string
): Promise<boolean> {
  const res = await fetch(
    `${svc.url}/rest/v1/memory_chunks?select=id&source_type=eq.${encodeURIComponent(
      "日記"
    )}&event_date=eq.${date}&limit=1`,
    { headers: restHeaders(svc.key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`memory_chunks確認失敗 ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

// ============ ハンドラ ============

export async function POST(req: NextRequest) {
  const anon = anonCreds();

  if (!anon) {
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

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/diary: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  if (!rawText) {
    return NextResponse.json({ error: "日記本文を貼り付けてください" }, { status: 400 });
  }

  // ★音声入力の誤変換を、貼り付け本文が入ってきたこの1か所で直す。
  // ここで直しておけば、Claudeに渡す前・Notionに書く前・Supabaseに書く前の
  // すべてに効く（下流で二重に通さないこと）。
  // 辞書が取れなければ素通しで、取り込み自体は止めない。
  const corrected = await correctTranscription(rawText);
  const text = corrected.text;

  const token = await notionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Notionトークンが未設定です。NOTION_TOKEN を確認してください。" },
      { status: 500 }
    );
  }

  // 1. Claudeで日ごとのエントリに構造化
  let entries: DiaryEntry[];
  try {
    entries = await parseDiaryEntries(text);
    if (entries.length === 0) throw new Error("no_entries");
  } catch (error) {
    if ((error as Error)?.message === "no_entries") {
      return NextResponse.json(
        { error: "日記のエントリを認識できませんでした。日付が分かる形で貼り直してください。" },
        { status: 400 }
      );
    }
    console.error("日記解析エラー:", error);
    return NextResponse.json(
      {
        error: llmErrorMessage(error, "AIによる日記の解析に失敗しました。日記本文はそのまま残っています。"),
      },
      { status: llmErrorStatus(error) }
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
      // Notionに既存でも、無条件にskipすると「Notionは完了・記憶(Supabase)は失敗」の日を
      // 貼り直したときに記憶へ永久に入らない。記憶側の存在まで確認し、無ければ補完登録する。
      const svc = serviceCreds();
      if (!svc) {
        results.push({ date: e.date, title: e.title, status: "skipped", notionUrl: existingUrl });
        continue;
      }
      let inMemory: boolean;
      try {
        inMemory = await diaryMemoryExists(svc, e.date);
      } catch (error) {
        console.error("記憶側の存在確認エラー:", error);
        results.push({
          date: e.date,
          title: e.title,
          status: "skipped",
          notionUrl: existingUrl,
          reason: "記憶(Supabase)側の登録有無を確認できませんでした",
        });
        continue;
      }
      if (inMemory) {
        results.push({ date: e.date, title: e.title, status: "skipped", notionUrl: existingUrl });
        continue;
      }
      const backfilled = await storeDiaryMemory(anon, e, existingUrl);
      results.push({
        date: e.date,
        title: e.title,
        status: backfilled ? "skipped" : "error",
        notionUrl: existingUrl,
        reason: backfilled
          ? "Notionは既登録。記憶(Supabase)に無かったため追加登録しました"
          : "Notionは既登録ですが、記憶(Supabase)への登録に失敗しました",
      });
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
      // Notion登録が済んでいても、記憶層(memory_chunks)への保存が失敗していれば
      // createdとしては数えない（黙って成功扱いにすると断絶Bが再発するため）。
      status: stored ? "created" : "error",
      notionUrl,
      reason: stored ? undefined : "Notion登録は完了しましたが、記憶(Supabase)への登録に失敗しました",
    });
  }

  const created = results.filter((r) => r.status === "created").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  // 何を書き換えたかは必ず返す。黙って直すと「自分が書いたものと違う」となるため。
  return NextResponse.json({
    created,
    skipped,
    errors,
    results,
    corrections: corrected.replacements,
    correctionTotal: corrected.total,
    correctionMessage: summarizeCorrections(corrected.replacements, corrected.total),
  });
}
