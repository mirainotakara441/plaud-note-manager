import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// 壁打ち（熟成ループ）。対象の登録内容を土台に Claude が深掘り質問 → 吉井さんが回答 →
// 内容を熟成 → 成果物として記憶層へ保存し直す。会話は refine_sessions / refine_messages に残す。

export const maxDuration = 60;

const MODEL = "claude-sonnet-5";

type Msg = { role: "user" | "assistant"; content: string };

type MemoResult = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
};

type Meeting = {
  title: string;
  content: string;
  event_date: string | null;
};

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
対象（自治体・議員・事業者）についてこれまでに登録された成果物・会議履歴・メモを土台に、吉井さんと「壁打ち」をして内容を熟成させます。

深掘りのルール（厳守）:
- 質問は「判断軸の発見」と「次のアクション」につながる前向きな問いにすること。
- 表面的な質問（資料を読めば分かること、はい/いいえで終わること）はしない。
- 1回に投げる質問は2〜3問まで。多すぎると答えられない。
- 資料に無い数字・人名・経緯を憶測で創作しない。不明なことは質問で埋める。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 過度なポジティブや励ましは不要。簡潔・直接的に。

進め方:
- まず土台（登録内容）を読み、まだ言語化されていない前提・急所・判断軸を探す。
- 吉井さんの回答を受けたら、それを踏まえて論点・打ち手を更新し、さらに深掘りする。
- 十分に熟成したと判断したら、その旨を伝え「熟成して登録」を促す。`;

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "熟成した内容の資料名（簡潔に）" },
    content: {
      type: "string",
      description:
        "壁打ちで熟成した内容の本文。論点・打ち手・次アクション・判断軸を構造的にまとめる。会話で新たに判明した事実を必ず反映する。",
    },
  },
  required: ["title", "content"],
  additionalProperties: false,
};

function restUrl(supabaseUrl: string, table: string) {
  return `${supabaseUrl}/rest/v1/${table}`;
}

function restHeaders(anonKey: string, extra?: Record<string, string>) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// 対象の登録内容（成果物・会議・メモ）を集めて壁打ちの土台にする。
async function fetchContext(
  supabaseUrl: string,
  anonKey: string,
  organization: string
): Promise<string> {
  const parts: string[] = [];

  // 成果物（提案のベース）
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `${organization} 提案 論点 打ち手`,
        source_type: "成果物",
        organization,
        match_count: 20,
      }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const rows: MemoResult[] = Array.isArray(data?.results) ? data.results : [];
      if (rows.length > 0) {
        parts.push(
          `==== 登録済みの成果物 ====\n` +
            rows.map((r) => `- ${r.title}: ${r.content}`).join("\n")
        );
      }
    }
  } catch {
    // 土台が一部欠けても壁打ちは続行できる
  }

  // 会議履歴（自治体など、会議がある対象のみ）
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/org-history`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ organization }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const rows: Meeting[] = Array.isArray(data?.meetings) ? data.meetings : [];
      if (rows.length > 0) {
        parts.push(
          `==== 会議履歴 ====\n` +
            rows.map((m) => `- ${m.event_date ?? ""} ${m.title}: ${m.content}`).join("\n")
        );
      }
    }
  } catch {
    // 会議が無い対象（議員・事業者など）もあるため失敗は許容
  }

  // 関連メモ（日記・学び）
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: organization, match_count: 6 }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const rows: MemoResult[] = Array.isArray(data?.results) ? data.results : [];
      const memos = rows.filter((r) => r.source_type !== "成果物");
      if (memos.length > 0) {
        parts.push(
          `==== 関連メモ（日記・学び） ====\n` +
            memos.map((r) => `- [${r.source_type}] ${r.title}: ${r.content}`).join("\n")
        );
      }
    }
  } catch {
    // 補強用
  }

  return parts.length > 0 ? parts.join("\n\n") : "（この対象の登録内容はまだありません）";
}

async function loadMessages(
  supabaseUrl: string,
  anonKey: string,
  sessionId: string
): Promise<Msg[]> {
  const res = await fetch(
    `${restUrl(supabaseUrl, "refine_messages")}?select=role,content&session_id=eq.${sessionId}&order=created_at.asc`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? (rows as Msg[]) : [];
}

async function saveMessage(
  supabaseUrl: string,
  anonKey: string,
  sessionId: string,
  role: Msg["role"],
  content: string
): Promise<void> {
  await fetch(restUrl(supabaseUrl, "refine_messages"), {
    method: "POST",
    headers: restHeaders(anonKey),
    body: JSON.stringify({ session_id: sessionId, role, content }),
    cache: "no-store",
  });
  await fetch(`${restUrl(supabaseUrl, "refine_sessions")}?id=eq.${sessionId}`, {
    method: "PATCH",
    headers: restHeaders(anonKey),
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
    cache: "no-store",
  });
}

async function askClaude(
  client: Anthropic,
  context: string,
  history: Msg[],
  organization: string,
  theme?: string | null
): Promise<string> {
  // テーマ指定があればそれを軸に深掘りし、無ければAIが土台から論点を選ぶ。
  const themeInstruction = theme
    ? `吉井さんが深掘りしたいテーマは次のとおりです。このテーマを軸に、資料に反映できる粒度まで具体化してください。
【テーマ】${theme}`
    : `テーマは指定されていません。土台を読み、まだ言語化されていない前提・急所・判断軸のうち、最も重要なものを自分で選んで深掘りしてください。`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `対象: ${organization}

以下が、この対象についてこれまでに登録された内容（壁打ちの土台）です。
${context}

${themeInstruction}

この土台をもとに壁打ちを始めてください。深掘り質問を2〜3問投げてください。`,
    },
  ];
  // 2ターン目以降は履歴をそのまま積む（先頭の土台メッセージは常に残す）
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages,
  });

  const textBlock = res.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  return textBlock?.text ?? "（応答を生成できませんでした）";
}

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  if (sessionId) {
    const messages = await loadMessages(supabaseUrl, anonKey, sessionId);
    return NextResponse.json({ messages });
  }

  const res = await fetch(
    `${restUrl(supabaseUrl, "refine_sessions")}?select=id,organization,category,title,updated_at&order=updated_at.desc&limit=20`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  const sessions = res.ok ? await res.json() : [];
  return NextResponse.json({ sessions: Array.isArray(sessions) ? sessions : [] });
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  if (!anthropicKey || anthropicKey.trim() === "" || anthropicKey === "sk-ant-xxxxx") {
    return NextResponse.json(
      { error: "ANTHROPIC_APIキーが未設定です" },
      { status: 500 }
    );
  }

  let body: {
    action?: unknown;
    sessionId?: unknown;
    organization?: unknown;
    category?: unknown;
    theme?: unknown;
    message?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const action = body.action;
  const client = new Anthropic({ apiKey: anthropicKey });

  try {
    // ── 開始: セッションを作り、土台を読んで最初の深掘り質問を出す
    if (action === "start") {
      const organization =
        typeof body.organization === "string" ? body.organization.trim() : "";
      const category =
        typeof body.category === "string" ? body.category : "自治体";
      const theme =
        typeof body.theme === "string" && body.theme.trim()
          ? body.theme.trim()
          : null;
      if (!organization) {
        return NextResponse.json({ error: "対象を入力してください" }, { status: 400 });
      }

      const created = await fetch(restUrl(supabaseUrl, "refine_sessions"), {
        method: "POST",
        headers: restHeaders(anonKey, { Prefer: "return=representation" }),
        body: JSON.stringify({ organization, category, theme }),
        cache: "no-store",
      });
      if (!created.ok) {
        return NextResponse.json({ error: "セッション作成に失敗しました" }, { status: 502 });
      }
      const rows = await created.json();
      const session = Array.isArray(rows) ? rows[0] : rows;

      const context = await fetchContext(supabaseUrl, anonKey, organization);
      const reply = await askClaude(client, context, [], organization, theme);
      await saveMessage(supabaseUrl, anonKey, session.id, "assistant", reply);

      return NextResponse.json({
        sessionId: session.id,
        organization,
        category,
        messages: [{ role: "assistant", content: reply }],
      });
    }

    // ── 返信: 回答を保存し、履歴＋土台で次の深掘りを返す
    if (action === "reply") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!sessionId || !message) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }

      const sres = await fetch(
        `${restUrl(supabaseUrl, "refine_sessions")}?select=organization,theme&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const organization = srows?.[0]?.organization;
      const theme = srows?.[0]?.theme ?? null;
      if (!organization) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      await saveMessage(supabaseUrl, anonKey, sessionId, "user", message);
      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const context = await fetchContext(supabaseUrl, anonKey, organization);
      const reply = await askClaude(client, context, history, organization, theme);
      await saveMessage(supabaseUrl, anonKey, sessionId, "assistant", reply);

      return NextResponse.json({ messages: await loadMessages(supabaseUrl, anonKey, sessionId) });
    }

    // ── 熟成して登録: 会話を統合し、成果物として記憶層へ保存する（熟成ループを閉じる）
    if (action === "save") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const sres = await fetch(
        `${restUrl(supabaseUrl, "refine_sessions")}?select=organization,category&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const organization = srows?.[0]?.organization;
      const category = srows?.[0]?.category ?? "自治体";
      if (!organization) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      if (history.length === 0) {
        return NextResponse.json({ error: "壁打ちの内容がありません" }, { status: 400 });
      }
      const context = await fetchContext(supabaseUrl, anonKey, organization);

      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");

      const synth = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        output_config: { format: { type: "json_schema", schema: SYNTHESIS_SCHEMA } },
        messages: [
          {
            role: "user",
            content: `対象: ${organization}

==== 既存の土台 ====
${context}

==== 壁打ちの会話 ====
${transcript}

この壁打ちで熟成した内容を、今後の提案の土台として再利用できる形にまとめてください。
会話で新たに判明した事実・判断軸・次アクションを必ず反映し、指定のJSONスキーマで返してください。`,
          },
        ],
      });

      const tb = synth.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      if (!tb) {
        return NextResponse.json({ error: "熟成に失敗しました" }, { status: 502 });
      }
      const parsed = JSON.parse(tb.text) as { title: string; content: string };

      const today = new Date().toISOString().slice(0, 10);
      const stored = await fetch(`${supabaseUrl}/functions/v1/store-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "成果物",
          source_id: `refine:${sessionId}`,
          organization,
          title: `${parsed.title}｜壁打ち熟成｜${today}`,
          content: parsed.content,
          event_date: today,
          metadata: {
            種別: "メモ",
            カテゴリ: category,
            資料名: parsed.title,
            出所: "壁打ち",
            セッション: sessionId,
          },
        }),
        cache: "no-store",
      });
      if (!stored.ok) {
        return NextResponse.json({ error: "登録に失敗しました" }, { status: 502 });
      }

      await fetch(`${restUrl(supabaseUrl, "refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(anonKey),
        body: JSON.stringify({ title: parsed.title }),
        cache: "no-store",
      });

      return NextResponse.json({ saved: true, title: parsed.title });
    }

    return NextResponse.json({ error: "不正なアクションです" }, { status: 400 });
  } catch (error) {
    console.error("壁打ちエラー:", error);
    return NextResponse.json(
      { error: "処理に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
