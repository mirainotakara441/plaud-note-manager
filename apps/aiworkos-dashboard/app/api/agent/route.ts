import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

type Meeting = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  organization: string | null;
};

type MemoResult = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
};

type Proposal = {
  summary: string;
  issues: string[];
  actions: { title: string; detail: string }[];
  materialOutline: string[];
};

// claude-sonnet-5: 入力 $3/MTok（〜2026-08-31 は導入価格 $2）、出力 $15/MTok（同 $10）。
// system＋tools は毎回同一なので cache_control を付けて prefix キャッシュ対象にする
// （レンダリング順は tools → system → messages。最後の system ブロックに breakpoint を
// 置くと tools と system がまとめてキャッシュされる）。キャッシュ読取は約0.1倍・書込は約1.25倍。
const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
自治体（地方公共団体）への営業・提案戦略を立案します。

厳守事項:
- 必ず与えられた「会議履歴」と「関連メモ」に書かれた事実のみに基づいて分析すること。
- 資料に無い数字・人名・経緯・約束事などを憶測で創作してはならない。情報が不足している場合は、その旨を前提として扱う。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 出力は必ず指定されたツール（build_proposal）で構造化して返すこと。`;

const PROPOSAL_TOOL: Anthropic.Tool = {
  name: "build_proposal",
  description:
    "自治体への営業・提案戦略を構造化して返す。全ての内容は与えられた会議履歴・メモの事実に基づくこと。",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "これまでの経緯を時系列で3〜5文でまとめた要約",
      },
      issues: {
        type: "array",
        description: "現状の論点・ボトルネックを2〜4個",
        items: { type: "string" },
      },
      actions: {
        type: "array",
        description: "次の打ち手を3〜5個。それぞれ具体的なアクション",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "打ち手の見出し（簡潔に）" },
            detail: { type: "string", description: "具体的な内容・進め方" },
          },
          required: ["title", "detail"],
          additionalProperties: false,
        },
      },
      materialOutline: {
        type: "array",
        description: "提案資料の見出し骨子を4〜6個",
        items: { type: "string" },
      },
    },
    required: ["summary", "issues", "actions", "materialOutline"],
    additionalProperties: false,
  },
};

async function fetchOrgHistory(
  supabaseUrl: string,
  anonKey: string,
  organization: string
): Promise<Meeting[]> {
  const res = await fetch(`${supabaseUrl}/functions/v1/org-history`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ organization }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("org-history エラー:", res.status, text);
    throw new Error("会議履歴の取得に失敗しました");
  }
  const data = await res.json();
  return Array.isArray(data?.meetings) ? (data.meetings as Meeting[]) : [];
}

async function fetchRelatedMemos(
  supabaseUrl: string,
  anonKey: string,
  organization: string
): Promise<MemoResult[]> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: organization, match_count: 8 }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? (data.results as MemoResult[]) : [];
  } catch {
    // 補強用なので失敗しても致命的ではない
    return [];
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "日付不明";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function buildUserPrompt(
  organization: string,
  meetings: Meeting[],
  memos: MemoResult[]
): string {
  const meetingsText =
    meetings.length > 0
      ? meetings
          .map(
            (m, i) =>
              `【会議${i + 1}】${formatDate(m.event_date)} ${m.title}\n${m.content}`
          )
          .join("\n\n")
      : "（会議履歴なし）";

  const memosText =
    memos.length > 0
      ? memos
          .map(
            (m) =>
              `- [${m.source_type}] ${formatDate(m.event_date)} ${m.title}: ${m.content}`
          )
          .join("\n")
      : "（関連メモなし）";

  return `対象自治体: ${organization}

以下は、この自治体に関するこれまでの会議履歴（時系列・古い順）です。
==== 会議履歴 ====
${meetingsText}

以下は、日記・学びから抽出した関連メモ（補強用）です。
==== 関連メモ ====
${memosText}

上記の事実だけをもとに、${organization}への営業・提案戦略を build_proposal ツールで構造化して返してください。`;
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  if (!anthropicKey || anthropicKey.trim() === "" || anthropicKey === "sk-ant-xxxxx") {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。",
      },
      { status: 500 }
    );
  }

  let body: { organization?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストの形式が不正です" },
      { status: 400 }
    );
  }

  const organization =
    typeof body.organization === "string" ? body.organization.trim() : "";
  if (!organization) {
    return NextResponse.json(
      { error: "自治体を選択してください" },
      { status: 400 }
    );
  }

  // a. 会議履歴（時系列）
  let meetings: Meeting[];
  try {
    meetings = await fetchOrgHistory(supabaseUrl, anonKey, organization);
  } catch {
    return NextResponse.json(
      { error: "会議履歴の取得に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }

  // b. 関連メモ（補強・失敗しても続行）
  const memos = await fetchRelatedMemos(supabaseUrl, anonKey, organization);

  // c. Claude で提案生成（tool use で構造化出力）
  const client = new Anthropic({ apiKey: anthropicKey });

  let proposal: Proposal;
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      // 最後の system ブロックの cache_control が tools＋system をまとめてキャッシュする
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [PROPOSAL_TOOL],
      tool_choice: { type: "tool", name: "build_proposal" },
      messages: [
        {
          role: "user",
          content: buildUserPrompt(organization, meetings, memos),
        },
      ],
    });

    // cache_read_input_tokens が繰り返し呼び出しで 0 のままなら prefix が小さすぎてキャッシュ未発火
    console.log("提案生成 usage:", JSON.stringify(message.usage));

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (!toolUse) {
      throw new Error("no_tool_use");
    }

    const input = toolUse.input as Partial<Proposal>;
    proposal = {
      summary: typeof input.summary === "string" ? input.summary : "",
      issues: Array.isArray(input.issues)
        ? input.issues.filter((s): s is string => typeof s === "string")
        : [],
      actions: Array.isArray(input.actions)
        ? input.actions
            .filter(
              (a): a is { title: string; detail: string } =>
                !!a &&
                typeof a === "object" &&
                typeof (a as { title?: unknown }).title === "string" &&
                typeof (a as { detail?: unknown }).detail === "string"
            )
            .map((a) => ({ title: a.title, detail: a.detail }))
        : [],
      materialOutline: Array.isArray(input.materialOutline)
        ? input.materialOutline.filter((s): s is string => typeof s === "string")
        : [],
    };

    if (!proposal.summary && proposal.actions.length === 0) {
      throw new Error("empty_proposal");
    }
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401) {
      return NextResponse.json(
        {
          error:
            "ANTHROPIC_APIキーが無効です。.env.local の ANTHROPIC_API_KEY を確認してください。",
        },
        { status: 500 }
      );
    }
    console.error("提案生成エラー:", error);
    return NextResponse.json(
      { error: "AIによる提案生成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }

  return NextResponse.json({ organization, meetings, proposal });
}
