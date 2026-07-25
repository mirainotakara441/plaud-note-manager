import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anonCreds, serviceCreds } from "@/lib/supabase";

// スライド壁打ち。/refine（対象との関係の熟成）のスライド版。
// お題（伝えたいこと）を軸に、目的・聞き手・ゴールをAIが深掘り → スライド構成案 → 簡易ビジュアル →
// 成果物として記憶層へ保存する。会話は slide_refine_sessions / slide_refine_messages に残す。

export const maxDuration = 60;

const MODEL = "claude-sonnet-5";

type Msg = { role: "user" | "assistant"; content: string };
type Slide = { title: string; bullets: string[] };
type Visual = { diagramType: string; description: string; svg: string };

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
これから作る1本のスライド資料について、吉井さんと「壁打ち」をして構成の土台を熟成させます。

深掘りの軸（この3つを必ず埋める）:
- 目的: このスライドが存在する理由。読んだ相手に何が変わってほしいのか。
- 聞き手: 誰が読むのか。相手は何を既に知っていて、何を気にしていて、その場でどこまで決められる立場か。
- ゴール: このスライドが引き起こすべき、具体的な決定・行動は何か。

深掘りのルール（厳守）:
- 質問は「判断軸の発見」と「次のアクション」につながる前向きな問いにすること。
- 表面的な質問（資料を読めば分かること、はい/いいえで終わること）はしない。
- 1回に投げる質問は2〜3問まで。多すぎると答えられない。
- 事実・数字・人名を憶測で創作しない。不明なことは質問で埋める。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 過度なポジティブや励ましは不要。簡潔・直接的に。

出力の形式（厳守）:
- 質問は必ず「**Q1. 問いの見出し**」という行で始めること（Q2, Q3 も同様）。見出し行は ** で囲み、1行で完結させる。
- 見出しの次の行から、その問いの補足説明を書く。
- 画面はこの形式を頼りに問いを切り出し、1問ごとに入力欄を並べる。形式が崩れると吉井さんが答えにくくなる。
- 聞き方を変えて問い直す場合は「**Q3（言い換え）. …**」のようにラベルに括弧書きを添える。

進め方:
- まずお題を読み、目的・聞き手・ゴールのうちまだ言語化されていないものを探す。
- 吉井さんの回答を受けたら、それを踏まえて更に深掘りするか、次の急所に移る。
- 3つの軸が十分に埋まったと判断したら、その旨を伝え「もう構成案を作る」を促す。`;

const OUTLINE_SCHEMA = {
  type: "object",
  properties: {
    slides: {
      type: "array",
      description:
        "スライド構成案。1要素が1枚。表紙は不要で、中身のスライドだけ。5〜10枚程度。",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "スライドの見出し" },
          bullets: {
            type: "array",
            description: "そのスライドに載せる要点。3〜5個。",
            items: { type: "string" },
          },
        },
        required: ["title", "bullets"],
        additionalProperties: false,
      },
    },
  },
  required: ["slides"],
  additionalProperties: false,
};

// AI生成SVGはクライアントでそのまま描画するため、生成時点である程度縛る。
// ここでの縛りは信頼の担保ではなく品質のため。実際の安全対策はクライアント側のサニタイズで行う。
const VISUALS_SCHEMA = {
  type: "object",
  properties: {
    visuals: {
      type: "array",
      description: "slides と同じ順・同じ枚数のビジュアル案。",
      items: {
        type: "object",
        properties: {
          diagramType: {
            type: "string",
            description: "図の種類（例: フロー図、比較表、ピラミッド、円グラフ風、単純な強調テキスト等）",
          },
          description: { type: "string", description: "この図が何を表しているかの短い説明" },
          svg: {
            type: "string",
            description:
              "単一の自己完結した <svg ...>...</svg> 文字列。viewBox=\"0 0 700 400\" 程度。" +
              "rect/circle/line/path/polygon/text/g などの基本図形のみを使い、色・テキストはインラインで指定すること。" +
              "<script> タグ、on から始まるイベント属性、<foreignObject>、外部参照の href/xlink:href、<image> タグは絶対に使わないこと。",
          },
        },
        required: ["diagramType", "description", "svg"],
        additionalProperties: false,
      },
    },
  },
  required: ["visuals"],
  additionalProperties: false,
};

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "このスライド資料の名称（簡潔に）" },
    content: {
      type: "string",
      description:
        "壁打ちで熟成したスライドの内容。目的・聞き手・ゴール、確定した構成、各スライドの要点、ビジュアルの狙いを構造的にまとめる。会話で新たに判明した事実を必ず反映する。",
    },
  },
  required: ["title", "content"],
  additionalProperties: false,
};

// 埋め込みモデル gte-small は 512token 上限で、超過分は黙って切り捨てられる。
// /refine と同じ理由でチャンク化する（詳細はそちらのコメント参照）。
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 60;

function windowChunks(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= size) return [body];
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += size - overlap) {
    chunks.push(body.slice(i, i + size));
  }
  return chunks;
}

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

async function loadMessages(
  supabaseUrl: string,
  anonKey: string,
  sessionId: string
): Promise<Msg[]> {
  const res = await fetch(
    `${restUrl(supabaseUrl, "slide_refine_messages")}?select=role,content&session_id=eq.${sessionId}&order=created_at.asc`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? (rows as Msg[]) : [];
}

// 書き込み（slide_refine_messages / slide_refine_sessions）なので service role キーを使う。
async function saveMessage(
  supabaseUrl: string,
  serviceKey: string,
  sessionId: string,
  role: Msg["role"],
  content: string
): Promise<void> {
  await fetch(restUrl(supabaseUrl, "slide_refine_messages"), {
    method: "POST",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ session_id: sessionId, role, content }),
    cache: "no-store",
  });
  await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${sessionId}`, {
    method: "PATCH",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
    cache: "no-store",
  });
}

async function askClaude(
  client: Anthropic,
  theme: string,
  history: Msg[],
  organization?: string | null,
  category?: string | null
): Promise<string> {
  const linkInstruction =
    organization && organization.trim()
      ? `このスライドは特定の対象に紐付いています。対象: ${organization}（${category ?? "その他"}）。聞き手を深掘りする際はこの対象を踏まえてください。`
      : `特定の対象には紐付いていません。聞き手は汎用の想定で構いません。`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `【お題】このスライドで伝えたいこと
${theme}

${linkInstruction}

このお題をもとに壁打ちを始めてください。目的・聞き手・ゴールのうち、まだ言語化されていないものを深掘りする質問を2〜3問投げてください。`,
    },
  ];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages,
  });

  const textBlock = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return textBlock?.text ?? "（応答を生成できませんでした）";
}

export async function GET(req: NextRequest) {
  const anon = anonCreds();
  if (!anon) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  const supabaseUrl = anon.url;
  const anonKey = anon.key;
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  if (sessionId) {
    const messages = await loadMessages(supabaseUrl, anonKey, sessionId);
    const sres = await fetch(
      `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=slides,visuals&id=eq.${sessionId}`,
      { headers: restHeaders(anonKey), cache: "no-store" }
    );
    const srows = sres.ok ? await sres.json() : [];
    const slides = Array.isArray(srows?.[0]?.slides) ? srows[0].slides : [];
    const visuals = Array.isArray(srows?.[0]?.visuals) ? srows[0].visuals : [];
    return NextResponse.json({ messages, slides, visuals });
  }

  const res = await fetch(
    `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=id,theme,organization,category,title,updated_at&order=updated_at.desc&limit=20`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  const sessions = res.ok ? await res.json() : [];
  return NextResponse.json({ sessions: Array.isArray(sessions) ? sessions : [] });
}

export async function POST(req: NextRequest) {
  const anon = anonCreds();
  const service = serviceCreds();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anon || !service) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  const supabaseUrl = anon.url;
  const anonKey = anon.key;
  const serviceKey = service.key;
  if (!anthropicKey || anthropicKey.trim() === "" || anthropicKey === "sk-ant-xxxxx") {
    return NextResponse.json({ error: "ANTHROPIC_APIキーが未設定です" }, { status: 500 });
  }

  let body: {
    action?: unknown;
    sessionId?: unknown;
    theme?: unknown;
    organization?: unknown;
    category?: unknown;
    message?: unknown;
    slides?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const action = body.action;
  const client = new Anthropic({ apiKey: anthropicKey });

  try {
    // ── 開始: セッションを作り、お題を読んで最初の深掘り質問を出す
    if (action === "start") {
      const theme = typeof body.theme === "string" ? body.theme.trim() : "";
      const organization =
        typeof body.organization === "string" && body.organization.trim()
          ? body.organization.trim()
          : null;
      const category =
        typeof body.category === "string" && body.category.trim() ? body.category.trim() : null;
      if (!theme) {
        return NextResponse.json({ error: "お題を入力してください" }, { status: 400 });
      }

      const created = await fetch(restUrl(supabaseUrl, "slide_refine_sessions"), {
        method: "POST",
        headers: restHeaders(serviceKey, { Prefer: "return=representation" }),
        body: JSON.stringify({ theme, organization, category }),
        cache: "no-store",
      });
      if (!created.ok) {
        return NextResponse.json({ error: "セッション作成に失敗しました" }, { status: 502 });
      }
      const rows = await created.json();
      const session = Array.isArray(rows) ? rows[0] : rows;

      const reply = await askClaude(client, theme, [], organization, category);
      await saveMessage(supabaseUrl, serviceKey, session.id, "assistant", reply);

      return NextResponse.json({
        sessionId: session.id,
        messages: [{ role: "assistant", content: reply }],
      });
    }

    // ── 返信: 回答を保存し、履歴＋お題で次の深掘りを返す
    if (action === "reply") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!sessionId || !message) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }

      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,category&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const organization = srows?.[0]?.organization ?? null;
      const category = srows?.[0]?.category ?? null;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      await saveMessage(supabaseUrl, serviceKey, sessionId, "user", message);
      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const reply = await askClaude(client, theme, history, organization, category);
      await saveMessage(supabaseUrl, serviceKey, sessionId, "assistant", reply);

      return NextResponse.json({ messages: await loadMessages(supabaseUrl, anonKey, sessionId) });
    }

    // ── 構成案: 面談の全会話からスライド構成案を作る
    if (action === "outline") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,category&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const organization = srows?.[0]?.organization ?? null;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");

      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        output_config: { format: { type: "json_schema", schema: OUTLINE_SCHEMA } },
        messages: [
          {
            role: "user",
            content: `【お題】${theme}
${organization ? `【紐付く対象】${organization}` : ""}

==== 壁打ちの会話 ====
${transcript || "（まだ会話はありません。お題のみからスライド構成案を作ってください）"}

この壁打ちの内容をもとに、スライド構成案を作ってください。指定のJSONスキーマで返してください。`,
          },
        ],
      });
      const tb = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (!tb) {
        return NextResponse.json({ error: "構成案の生成に失敗しました" }, { status: 502 });
      }
      const parsed = JSON.parse(tb.text) as { slides: Slide[] };

      await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ slides: parsed.slides }),
        cache: "no-store",
      });

      return NextResponse.json({ slides: parsed.slides });
    }

    // ── 図式化: (編集済みの可能性がある)構成案から、スライドごとの簡易ビジュアルを作る
    if (action === "visualize") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const slides = Array.isArray(body.slides) ? (body.slides as Slide[]) : null;
      if (!sessionId || !slides || slides.length === 0) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }

      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      const slidesText = slides
        .map((s, i) => `${i + 1}. ${s.title}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`)
        .join("\n\n");

      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        output_config: { format: { type: "json_schema", schema: VISUALS_SCHEMA } },
        messages: [
          {
            role: "user",
            content: `【お題】${theme}

==== スライド構成案 ====
${slidesText}

各スライドの内容を一目で伝える簡易ビジュアルを、構成案と同じ順・同じ枚数だけ作ってください。
文字だけのスライドでも、関係性・構造・強弱が伝わる図にしてください。指定のJSONスキーマで返してください。`,
          },
        ],
      });
      const tb = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (!tb) {
        return NextResponse.json({ error: "図式化に失敗しました" }, { status: 502 });
      }
      const parsed = JSON.parse(tb.text) as { visuals: Visual[] };

      await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ slides, visuals: parsed.visuals }),
        cache: "no-store",
      });

      return NextResponse.json({ visuals: parsed.visuals });
    }

    // ── 確定して登録: スライド一式を統合し、成果物として記憶層へ保存する
    if (action === "save") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,category,slides,visuals&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const row = srows?.[0];
      const theme = row?.theme;
      const organization: string | null = row?.organization ?? null;
      const category: string = row?.category ?? "その他";
      const slides: Slide[] = Array.isArray(row?.slides) ? row.slides : [];
      const visuals: Visual[] = Array.isArray(row?.visuals) ? row.visuals : [];
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      if (slides.length === 0) {
        return NextResponse.json({ error: "スライド構成案がまだありません" }, { status: 400 });
      }

      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");
      const slidesText = slides
        .map((s, i) => `${i + 1}. ${s.title}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`)
        .join("\n\n");
      const visualsText = visuals
        .map((v, i) => `${i + 1}. [${v.diagramType}] ${v.description}`)
        .join("\n");

      const synth = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        output_config: { format: { type: "json_schema", schema: SYNTHESIS_SCHEMA } },
        messages: [
          {
            role: "user",
            content: `【お題】${theme}
${organization ? `【紐付く対象】${organization}（${category}）` : ""}

==== 壁打ちの会話 ====
${transcript || "（会話なし）"}

==== 確定したスライド構成案 ====
${slidesText}

==== ビジュアルの狙い ====
${visualsText || "（なし）"}

このスライド壁打ちで熟成した内容を、今後の別提案でも土台として再利用できる形にまとめてください。
目的・聞き手・ゴール、確定した構成、ビジュアルの狙いを必ず反映し、指定のJSONスキーマで返してください。`,
          },
        ],
      });
      const tb = synth.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (!tb) {
        return NextResponse.json({ error: "登録に失敗しました" }, { status: 502 });
      }
      const parsed = JSON.parse(tb.text) as { title: string; content: string };

      const today = new Date().toISOString().slice(0, 10);
      const chunks = windowChunks(parsed.content);
      if (chunks.length === 0) {
        return NextResponse.json({ error: "熟成した内容が空でした" }, { status: 502 });
      }

      // 同じセッションで再度「確定して登録」すると内容が変わりチャンク数がずれるので、
      // 古いチャンクを先に一掃してから積み直す（/refine の save と同じ理由）。
      await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `slide-refine:${sessionId}` }),
        cache: "no-store",
      });

      const results = await Promise.all(
        chunks.map((chunk, i) =>
          fetch(`${supabaseUrl}/functions/v1/store-memory`, {
            method: "POST",
            headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              source_type: "成果物",
              source_id: `slide-refine:${sessionId}:${i + 1}`,
              organization: organization ?? undefined,
              title: `${parsed.title}｜スライド壁打ち｜${today}｜${i + 1}/${chunks.length}`,
              content: chunk,
              event_date: today,
              metadata: {
                種別: "スライド",
                カテゴリ: category,
                資料名: parsed.title,
                出所: "スライド壁打ち",
                セッション: sessionId,
                位置: `${i + 1}/${chunks.length}`,
              },
            }),
            cache: "no-store",
          })
        )
      );
      if (results.some((r) => !r.ok)) {
        return NextResponse.json({ error: "登録に失敗しました" }, { status: 502 });
      }

      await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ title: parsed.title }),
        cache: "no-store",
      });

      return NextResponse.json({ saved: true, title: parsed.title, chunks: chunks.length });
    }

    return NextResponse.json({ error: "不正なアクションです" }, { status: 400 });
  } catch (error) {
    console.error("スライド壁打ちエラー:", error);
    return NextResponse.json(
      { error: "処理に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
