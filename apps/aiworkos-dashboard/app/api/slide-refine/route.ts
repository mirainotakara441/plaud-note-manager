import { NextRequest, NextResponse } from "next/server";
// Anthropic は Anthropic.MessageParam（多ターンの会話の型）でのみ使う。
// 実際の呼び出しは lib/llm.ts のヘルパー経由。
import Anthropic from "@anthropic-ai/sdk";
import { isLlmConfigured, structured, text as llmText, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import { findTemplate, sectionNames, type SlideTemplate } from "@/lib/slideTemplates";
import { toJstDateString } from "@/lib/date";

// スライド壁打ち。/refine（対象との関係の熟成）のスライド版。
// お題（伝えたいこと）を軸に、目的・聞き手・ゴールをAIが深掘り → スライド構成案 → 簡易ビジュアル →
// 成果物として記憶層へ保存する。会話は slide_refine_sessions / slide_refine_messages に残す。

export const maxDuration = 60;

type Msg = { role: "user" | "assistant"; content: string };
// sectionは選んだテンプレート(lib/slideTemplates.ts)のセクション名のいずれか。
// テンプレートごとに名称が変わるためstringにしている（厳密なenum制約はschema側で都度組み立てる）。
type Slide = { section: string; title: string; bullets: string[] };
type VisualCandidate = { diagramType: string; description: string };
type Visual = { diagramType: string; description: string; svg: string };

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
これから作る1本のスライド資料について、吉井さんと「壁打ち」をして構成の土台を熟成させます。

深掘りの軸:
- 目的: このスライドが存在する理由。多くの場合、吉井さんが壁打ち開始時にカテゴリー選択済みなので既知の前提として扱う。指定された目的だけでは具体的な行動に移せないほど曖昧な場合（例:「新規開拓・提案」とだけあり具体性が無い場合）に限り、目的も深掘りする。
- 聞き手: 誰が読むのか。相手は何を既に知っていて、何を気にしていて、その場でどこまで決められる立場か。
- ゴール: このスライドが引き起こすべき、具体的な決定・行動は何か。

基本方針として、目的はすでに大枠が与えられているため、質問は聞き手・ゴールを中心に組み立てること。

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

進め方（重要: 2〜3往復での収束を目安にする）:
- 目的はあらかじめ与えられていることが多いので、以前より少ない往復で済むはずである。聞き手・ゴールのうちまだ言語化されていないものを探し、2〜3往復のやり取りで十分な状態まで持っていくことを目指す。
- 吉井さんの回答を受けたら、それを踏まえて更に深掘りするか、次の急所に移る。
- 聞き手・ゴールが十分に固まったと判断したら、質問を続ける代わりに、その旨を伝えた上で「続けてもいいし、このまま構成案に進んでもいい」という趣旨を明示すること。例:「十分に固まってきました。さらに深掘りしたい点があれば続けて構いませんし、このまま「もう構成案を作る」に進んでも大丈夫です。」自然な言い回しでよいが、続行・前進のどちらも対等な選択肢として伝え、どちらかを強制しないこと。`;

// 構成案・図解・作り直し・熟成まとめ用の軽量ペルソナ指示。
// SYSTEM_PROMPT（面談用）は「**Q1. 見出し**」形式での出力を強く指示しており、
// これをJSON schema制約の生成呼び出しにまで使い回すと、モデルがそのQ1形式の文章を
// スライド本文として生成してしまう事故が起きる（実際に regenerate-slide で発生・確認済み）。
// そのため面談以外のJSON生成呼び出しはすべてこちらを使う。
const PERSONA_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
スライド資料の内容を検討・作成する場面です。

ルール:
- 事実・数字・人名を憶測で創作しない。不明な点は一般的な想定で補うか、内容として無理に断定しない。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 過度なポジティブや励ましは不要。簡潔・直接的に。
- 出力は指定されたJSON schemaで要求されている内容そのものにすること。「**Q1.**」のような見出し記法や、面談・質問形式の文章を混ぜないこと。
- 聞き手が自治体・議員・議員連盟など公的な立場の場合、特定企業の売り込みや対象への批判と受け取られる断定的な推奨表現（「〜すべき」「〜が必須」等）は避け、事実・環境変化の共有にとどめること。`;

// SVG・スライド本文を生成させる際の事実グラウンディング指示。
// render-visuals で「本文(bullets)を渡さずにSVGを描かせていたため、モデルが日付・用語を
// 独自に埋めて事実誤りが混入する」という不具合が実際に発生した（2026-07-27 使用テストで検出）。
// 本文を必ず渡した上で、この指示を添えることで防ぐ。
const NO_FABRICATION_INSTRUCTION =
  "文言・数値・年月・固有名詞は、対応するスライド本文（title/bullets）に書かれている内容だけを使うこと。" +
  "本文に無い事実・数値・年月・注釈を新たに作らない。期間や日付の計算（「残りn年」等）を自分で行わない。" +
  "用語は本文の表記に一字一句正確に合わせ、言い換えない（例:「定額小為替」を「郵便小為替」等に変えない）。";

// SVGを生成させる呼び出し（render-visuals/regenerate-slide/fix-slide）は、モデルが「今日」を
// 知らないまま期間計算をして誤る事故が実際に起きた（例:「残り約5年」の誤り。正しくは約3年）。
// 呼び出し時点の日付をプロンプトに明示することで、期間の言及がある場合に基準日を与える。
function todayContext(): string {
  const today = toJstDateString(new Date().toISOString());
  return `【今日の日付】${today}。期間・残り年数などに言及する場合は、本文に明記された年月とこの日付から計算した場合に限り許可する。それ以外の期間・残り年数を憶測で書かないこと。`;
}

// 壁打ちの会話から抽出した「デッキ全体で守るべき制約」（トーン・用語・避けるべき論点）を
// 下流の各生成呼び出しに配る。無ければ空文字を返し、プロンプトには何も追加しない。
function constraintsBlock(constraints?: string | null): string {
  const c = constraints?.trim();
  return c ? `\n==== 守るべき制約（壁打ちの会話から抽出） ====\n${c}\n` : "";
}

// 構成案schemaをテンプレート（lib/slideTemplates.ts）とスライド枚数指定から組み立てる。
// 注: Anthropicの構造化出力は array の minItems/maxItems に 0/1 以外を指定できないため、
// 枚数の強制はできない。schemaのdescriptionとプロンプト本文の指示で守らせる。
function buildOutlineSchema(template: SlideTemplate, slideCount?: number | null) {
  const names = sectionNames(template);
  const order = names.join("→");
  const sectionDescription = template.sections
    .map((s) => `${s.name}=${s.guidance}（${s.countHint}）。`)
    .join("");
  const slidesDescription = slideCount
    ? `スライド構成案。1要素が1枚。表紙は不要で、中身のスライドだけ。必ずちょうど${slideCount}枚（厳守）。${order}の順で並んでいること。`
    : `スライド構成案。1要素が1枚。表紙は不要で、中身のスライドだけ。5〜10枚程度。${order}の順で並んでいること。`;

  return {
    type: "object",
    properties: {
      slides: {
        type: "array",
        description: slidesDescription,
        items: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: names,
              description: `このスライドが構成上どこに位置するか。${sectionDescription}`,
            },
            title: { type: "string", description: "スライドの見出し" },
            bullets: {
              type: "array",
              description: "そのスライドに載せる要点。3〜5個。",
              items: { type: "string" },
            },
          },
          required: ["section", "title", "bullets"],
          additionalProperties: false,
        },
      },
      constraints: {
        type: "array",
        description:
          "この壁打ちの会話全体から抽出した、スライド全体を通して守るべき制約。" +
          "トーン・言い回しの制約（例:断定的な推奨表現を避ける）、用語の指定・表記統一、" +
          "触れてはいけない・避けるべき論点など。会話に明示的な言及が無ければ空配列でよい。" +
          "この後の図解生成・作り直し・登録の各工程に渡されるので、簡潔な一文ずつにすること。",
        items: { type: "string" },
      },
    },
    required: ["slides", "constraints"],
    additionalProperties: false,
  };
}

// SVG生成時の安全上の制約（Step A/Bでは使わず、Step C=render-visuals でのみ使う説明文）。
const SVG_SAFETY_INSTRUCTION =
  "単一の自己完結した <svg ...>...</svg> 文字列。viewBox=\"0 0 700 400\" 程度。" +
  "rect/circle/line/path/polygon/text/g などの基本図形のみを使い、色・テキストはインラインで指定すること。" +
  "<script> タグ、on から始まるイベント属性、<foreignObject>、外部参照の href/xlink:href、<image> タグは絶対に使わないこと。" +
  NO_FABRICATION_INSTRUCTION;

// Step A: 図解パターンの候補提案（SVGはまだ作らない・軽量な呼び出し）。
const VISUAL_CANDIDATES_SCHEMA = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      description: "slidesと同じ順・同じ枚数。各要素がそのスライドの図解候補2〜3個。",
      items: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                diagramType: { type: "string" },
                description: { type: "string" },
              },
              required: ["diagramType", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["candidates"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
};

// Step C: 選ばれた図解パターンだけをSVGとして描画する（狭いスコープの生成）。
const RENDER_VISUALS_SCHEMA = {
  type: "object",
  properties: {
    visuals: {
      type: "array",
      description: "choices と同じ順・同じ枚数の完成ビジュアル。",
      items: {
        type: "object",
        properties: {
          diagramType: { type: "string", description: "choicesで指定されたdiagramTypeをそのまま踏襲する" },
          description: { type: "string", description: "choicesで指定されたdescriptionをそのまま踏襲する" },
          svg: { type: "string", description: SVG_SAFETY_INSTRUCTION },
        },
        required: ["diagramType", "description", "svg"],
        additionalProperties: false,
      },
    },
  },
  required: ["visuals"],
  additionalProperties: false,
};

// 1枚だけの作り直し: 内容(section/title/bullets)とビジュアル(diagramType/description/svg)を
// まとめて1回で作り直す。段階を分けると操作が重くなるため、1ボタン1呼び出しにする。
// sectionのenumはそのセッションで選ばれたテンプレートのセクション名に合わせて組み立てる
// （regenerate-slide/fix-slideの両方で使う）。
function buildRegenerateSlideSchema(template: SlideTemplate) {
  return {
    type: "object",
    properties: {
      slide: {
        type: "object",
        properties: {
          section: { type: "string", enum: sectionNames(template) },
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["section", "title", "bullets"],
        additionalProperties: false,
      },
      visual: {
        type: "object",
        properties: {
          diagramType: { type: "string" },
          description: { type: "string" },
          svg: { type: "string", description: SVG_SAFETY_INSTRUCTION },
        },
        required: ["diagramType", "description", "svg"],
        additionalProperties: false,
      },
    },
    required: ["slide", "visual"],
    additionalProperties: false,
  };
}

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

// ⑤ 既存スライドの登録。専用の列は増やさず、登録内容をこのマーカー付きの最初のuser
// メッセージとして slide_refine_messages（既存テーブル）に保存する。メッセージは
// 会話履歴・構成案・熟成まとめのすべてに自然に流れ込むため、土台の置き場所として
// 一番壊れにくく、マイグレーション不要で済む。マーカーは改善モードの判別にも使う。
const BASE_DECK_MARKER = "【既存スライドの登録】";

function buildBaseDeckMessage(baseSlides: string | null, baseScript: string | null): string {
  return [
    `${BASE_DECK_MARKER}この壁打ちの目的は、以下の既存スライドの改善・完成です。`,
    "==== スライド構成 ====",
    baseSlides ?? "（未登録。台本だけを土台にする）",
    "==== 台本・スクリプト ====",
    baseScript ?? "（未登録）",
  ].join("\n");
}

function hasBaseDeck(history: Msg[]): boolean {
  return history.some((m) => m.role === "user" && m.content.startsWith(BASE_DECK_MARKER));
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
    `${restUrl(supabaseUrl, "slide_refine_messages")}?select=role,content&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc`,
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
): Promise<boolean> {
  const inserted = await fetch(restUrl(supabaseUrl, "slide_refine_messages"), {
    method: "POST",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ session_id: sessionId, role, content }),
    cache: "no-store",
  });
  if (!inserted.ok) return false;
  const touched = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
    cache: "no-store",
  });
  return touched.ok;
}

async function askClaude(
  theme: string,
  history: Msg[],
  organization?: string | null,
  category?: string | null,
  purpose?: string | null,
  baseRegistered = false
): Promise<string> {
  // 既存スライドの改善モードでは「ゼロから作る」前提の深掘りをさせない。
  // 登録済みの内容を既知として扱わせ、足りない部分を埋める質問に寄せる。
  const baseInstruction = baseRegistered
    ? `

吉井さんは過去に作った既存スライドの構成（と台本）を登録済みで、この会話に含まれています。この壁打ちの目的は「既存スライドの改善・完成」であり、ゼロから作り直すことではありません。登録内容に既に書かれていることを改めて質問せず、足りない部分・弱い部分・聞き手に刺さらない部分を埋める質問をしてください。`
    : "";

  const linkInstruction =
    organization && organization.trim()
      ? `このスライドは特定の対象に紐付いています。対象: ${organization}（${category ?? "その他"}）。聞き手を深掘りする際はこの対象を踏まえてください。`
      : `特定の対象には紐付いていません。聞き手は汎用の想定で構いません。`;

  const purposeInstruction =
    purpose && purpose.trim()
      ? `壁打ちの目的はすでに「${purpose}」として指定されています。目的について改めて尋ねる必要はありません。この目的だけでは具体的な行動に移せないほど曖昧な場合に限り目的も深掘りしてください。基本的には聞き手・ゴールの深掘りに重点を置いてください。`
      : `壁打ちの目的はまだ指定されていません。目的・聞き手・ゴールの3つを深掘りしてください。`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `【お題】このスライドで伝えたいこと
${theme}

${purposeInstruction}

${linkInstruction}${baseInstruction}

このお題をもとに壁打ちを始めてください。聞き手・ゴールを中心に、まだ言語化されていないものを深掘りする質問を2〜3問投げてください。`,
    },
  ];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  // 面談の応答は構造化出力ではなく素の文章なので text() を使う。
  const reply = await llmText({
    system: SYSTEM_PROMPT,
    messages,
    maxTokens: 8000,
  });

  return reply || "（応答を生成できませんでした）";
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
      `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=purpose,slides,visuals,visual_candidates,template_id&id=eq.${encodeURIComponent(sessionId)}`,
      { headers: restHeaders(anonKey), cache: "no-store" }
    );
    const srows = sres.ok ? await sres.json() : [];
    const purpose = srows?.[0]?.purpose ?? null;
    const templateId = srows?.[0]?.template_id ?? null;
    const slides = Array.isArray(srows?.[0]?.slides) ? srows[0].slides : [];
    const visuals = Array.isArray(srows?.[0]?.visuals) ? srows[0].visuals : [];
    const visualCandidates = Array.isArray(srows?.[0]?.visual_candidates)
      ? srows[0].visual_candidates
      : [];
    return NextResponse.json({
      messages,
      purpose,
      templateId,
      slides,
      visuals,
      visual_candidates: visualCandidates,
    });
  }

  const res = await fetch(
    `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=id,theme,organization,category,title,purpose,template_id,updated_at&order=updated_at.desc&limit=20`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  const sessions = res.ok ? await res.json() : [];
  return NextResponse.json({ sessions: Array.isArray(sessions) ? sessions : [] });
}

export async function POST(req: NextRequest) {
  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  const supabaseUrl = anon.url;
  const anonKey = anon.key;
  const serviceKey = service.key;
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "ANTHROPIC_APIキーが未設定です" }, { status: 500 });
  }

  let body: {
    action?: unknown;
    sessionId?: unknown;
    theme?: unknown;
    organization?: unknown;
    category?: unknown;
    purpose?: unknown;
    message?: unknown;
    slides?: unknown;
    visuals?: unknown;
    choices?: unknown;
    slideCount?: unknown;
    templateId?: unknown;
    index?: unknown;
    visual?: unknown;
    slide?: unknown;
    instruction?: unknown;
    baseSlides?: unknown;
    baseScript?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const action = body.action;

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
      const purpose =
        typeof body.purpose === "string" && body.purpose.trim() ? body.purpose.trim() : null;
      const templateId =
        typeof body.templateId === "string" && body.templateId.trim()
          ? findTemplate(body.templateId).id
          : findTemplate(null).id;
      // ⑤ 既存スライドの登録（両方とも任意。どちらかがあれば改善モードで始める）。
      const baseSlides =
        typeof body.baseSlides === "string" && body.baseSlides.trim()
          ? body.baseSlides.trim()
          : null;
      const baseScript =
        typeof body.baseScript === "string" && body.baseScript.trim()
          ? body.baseScript.trim()
          : null;
      if (!theme) {
        return NextResponse.json({ error: "お題を入力してください" }, { status: 400 });
      }

      const created = await fetch(restUrl(supabaseUrl, "slide_refine_sessions"), {
        method: "POST",
        headers: restHeaders(serviceKey, { Prefer: "return=representation" }),
        body: JSON.stringify({ theme, organization, category, purpose, template_id: templateId }),
        cache: "no-store",
      });
      if (!created.ok) {
        return NextResponse.json({ error: "セッション作成に失敗しました" }, { status: 502 });
      }
      const rows = await created.json();
      const session = Array.isArray(rows) ? rows[0] : rows;

      // 既存スライドが登録されていれば、最初のuserメッセージとして土台を積んでから面談を始める
      // （画面にもそのまま出るので、何を土台にしたかが後から見ても分かる）。
      const hasBase = !!(baseSlides || baseScript);
      const baseHistory: Msg[] = [];
      if (hasBase) {
        const baseMessage = buildBaseDeckMessage(baseSlides, baseScript);
        if (!(await saveMessage(supabaseUrl, serviceKey, session.id, "user", baseMessage))) {
          return NextResponse.json({ error: "既存スライドの登録に失敗しました" }, { status: 502 });
        }
        baseHistory.push({ role: "user", content: baseMessage });
      }

      const reply = await askClaude(theme, baseHistory, organization, category, purpose, hasBase);
      if (!(await saveMessage(supabaseUrl, serviceKey, session.id, "assistant", reply))) {
        return NextResponse.json({ error: "メッセージの保存に失敗しました" }, { status: 502 });
      }

      return NextResponse.json({
        sessionId: session.id,
        messages: hasBase
          ? await loadMessages(supabaseUrl, anonKey, session.id)
          : [{ role: "assistant", content: reply }],
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
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,category,purpose&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const organization = srows?.[0]?.organization ?? null;
      const category = srows?.[0]?.category ?? null;
      const purpose = srows?.[0]?.purpose ?? null;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      if (!(await saveMessage(supabaseUrl, serviceKey, sessionId, "user", message))) {
        return NextResponse.json({ error: "メッセージの保存に失敗しました" }, { status: 502 });
      }
      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      // 既存スライドの改善モードかは、履歴のマーカーで判別する（列を増やさない方針）。
      const reply = await askClaude(
        theme,
        history,
        organization,
        category,
        purpose,
        hasBaseDeck(history)
      );
      if (!(await saveMessage(supabaseUrl, serviceKey, sessionId, "assistant", reply))) {
        return NextResponse.json({ error: "メッセージの保存に失敗しました" }, { status: 502 });
      }

      return NextResponse.json({ messages: await loadMessages(supabaseUrl, anonKey, sessionId) });
    }

    // ── 構成案: 面談の全会話からスライド構成案を作る
    if (action === "outline") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const slideCount =
        typeof body.slideCount === "number" && Number.isFinite(body.slideCount) && body.slideCount > 0
          ? Math.round(body.slideCount)
          : null;
      const requestedTemplateId =
        typeof body.templateId === "string" && body.templateId.trim() ? body.templateId.trim() : null;
      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,category,template_id&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const organization = srows?.[0]?.organization ?? null;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      // 構成案生成時にテンプレートを選び直せる（未指定ならセッション作成時に決めたものを使う）。
      const template = findTemplate(requestedTemplateId ?? srows?.[0]?.template_id);
      const order = sectionNames(template).join("→");
      const sectionGuidance = template.sections
        .map((s) => `- ${s.name}: ${s.guidance}（${s.countHint}）`)
        .join("\n");

      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");

      const slideCountInstruction = slideCount
        ? slideCount <= 2
          ? `スライドは${slideCount}枚だけにしてください。${order}の要素を${slideCount}枚に統合しますが、` +
            `本文(bullets)に${sectionNames(template).map((n) => `「【${n}】」`).join("")}のようなラベル文字列を書き込まないこと` +
            `（セクション分類はsectionフィールドだけで表現し、本文には現れないようにする）。` +
            `要点(bullets)は各スライド多くても4個までにすること。`
          : `スライドの枚数はちょうど${slideCount}枚にしてください（${order}の配分はこの${slideCount}枚に収まるよう調整すること）。要点(bullets)は各スライド3〜5個を超えないこと。`
        : `スライド枚数の指定はありません。内容に応じて5〜10枚程度で構いません。要点(bullets)は各スライド3〜5個を超えないこと。`;

      // 既存スライドの改善モードでは、テンプレの型よりも登録済み構成の流れを優先させる。
      // ここを指示しないと、せっかく登録した構成をゼロから作り直してしまう。
      const baseDeckInstruction = hasBaseDeck(history)
        ? `
（重要）この壁打ちには「${BASE_DECK_MARKER}」として登録済みの既存スライドがあります。目的は既存スライドの改善・完成であり、ゼロから作り直さないこと。既存の枚数・流れ・文言を土台にし、壁打ちの会話で判明した改善点だけを反映すること。型の並びと既存の流れが食い違う場合は既存の流れを優先し、各スライドはsectionのうち最も近いものに割り当ててよい。`
        : "";

      const parsed = await structured<{ slides: Slide[]; constraints?: string[] }>({
        system: PERSONA_PROMPT,
        schema: buildOutlineSchema(template, slideCount),
        maxTokens: 16000,
        prompt: `【お題】${theme}
${organization ? `【紐付く対象】${organization}` : ""}

==== 壁打ちの会話 ====
${transcript || "（まだ会話はありません。お題のみからスライド構成案を作ってください）"}

この壁打ちの内容をもとに、スライド構成案を作ってください。
必ず「${order}」の型で並べること。
${sectionGuidance}
${slideCountInstruction}${baseDeckInstruction}
スライドは${order}の順にすでに並んだ状態で返すこと（後で並べ替えない前提）。

あわせて、この壁打ちの会話の中で吉井さんが述べた「デッキ全体で守るべき制約」があれば抽出してください
（例:「自治体批判ではなく環境変化の共有にとどめる」「用語は正式名称で統一する」等）。
明示的な言及が無ければ空配列で構いません。憶測で作らないこと。
指定のJSONスキーマで返してください。`,
      });
      const constraints = Array.isArray(parsed.constraints) ? parsed.constraints.filter(Boolean) : [];

      const outlineSaved = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({
          slides: parsed.slides,
          constraints: constraints.length > 0 ? constraints.join("\n") : null,
          template_id: template.id,
        }),
        cache: "no-store",
      });
      if (!outlineSaved.ok) {
        return NextResponse.json({ error: "構成案の保存に失敗しました" }, { status: 502 });
      }

      return NextResponse.json({ slides: parsed.slides, constraints, templateId: template.id });
    }

    // ── 図解候補提案(Step A): (編集済みの可能性がある)構成案から、スライドごとに2〜3個の図解パターン候補を出す。
    // SVGはまだ作らない（軽量・高速に保つ）。
    if (action === "propose-visuals") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const slides = Array.isArray(body.slides) ? (body.slides as Slide[]) : null;
      if (!sessionId || !slides || slides.length === 0) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }

      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,constraints&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const organization = srows?.[0]?.organization ?? null;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      const slidesText = slides
        .map((s, i) => `${i + 1}. [${s.section}] ${s.title}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`)
        .join("\n\n");

      const parsed = await structured<{ proposals: { candidates: VisualCandidate[] }[] }>({
        system: PERSONA_PROMPT,
        schema: VISUAL_CANDIDATES_SCHEMA,
        maxTokens: 16000,
        prompt: `【お題】${theme}
${organization ? `【紐付く対象】${organization}` : ""}
${constraintsBlock(srows?.[0]?.constraints)}
==== スライド構成案 ====
${slidesText}

各スライドについて、その内容を一目で伝える図解パターンの候補を2〜3個提案してください。SVGはまだ不要です。
インスピレーション例: 比較表・Before/After、フロー図・タイムライン、ピラミッド構造、KPI・数字強調カード。
ただしこれらに縛られる必要はありません。そのスライドの内容に本当に合うパターンを選んでください
（機械的に多様性を出したり、決まったリストを順番に回したりしないこと）。
slidesと同じ順・同じ枚数で、指定のJSONスキーマで返してください。`,
      });
      const candidates = parsed.proposals.map((p) => p.candidates);

      const candidatesSaved = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ slides, visual_candidates: candidates }),
        cache: "no-store",
      });
      if (!candidatesSaved.ok) {
        return NextResponse.json({ error: "図解候補の保存に失敗しました" }, { status: 502 });
      }

      return NextResponse.json({ candidates });
    }

    // ── 図解描画(Step C): 吉井さんが選んだ候補（スライドごとに1個）だけをSVGとして描画する。
    if (action === "render-visuals") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const choices = Array.isArray(body.choices)
        ? (body.choices as (VisualCandidate & { slide?: Slide })[])
        : null;
      if (!sessionId || !choices || choices.length === 0) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }

      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,constraints&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      // 重要: 図解の材料はここで渡すスライド本文だけ。diagramType/descriptionは
      // 「どんな図か」の指示に過ぎず、文言・数値・年月の出所にはならない
      // （本文を渡さずSVGを描かせていたことが、事実誤り混入の根本原因だった）。
      const choicesText = choices
        .map((c, i) => {
          const slideBlock = c.slide
            ? `タイトル: ${c.slide.title}\n要点:\n${c.slide.bullets.map((b) => `- ${b}`).join("\n")}`
            : "（本文情報なし。図解の説明文だけを頼りに、事実を創作しない範囲で描くこと）";
          return `${i + 1}. [${c.diagramType}] ${c.description}\n--- このスライドの本文（図解の文言・数値・年月はここだけから取ること） ---\n${slideBlock}`;
        })
        .join("\n\n");

      const parsed = await structured<{ visuals: Visual[] }>({
        system: PERSONA_PROMPT,
        schema: RENDER_VISUALS_SCHEMA,
        maxTokens: 16000,
        prompt: `【お題】${theme}
${constraintsBlock(srows?.[0]?.constraints)}
==== 選ばれた図解パターンとスライド本文（スライドごとに1個・確定済み） ====
${choicesText}

それぞれの図解パターンに従って、実際のSVGを描いてください。diagramTypeとdescriptionはそのまま踏襲し、svgだけ新規に作成してください。
${NO_FABRICATION_INSTRUCTION}
${todayContext()}
choicesと同じ順・同じ枚数で、指定のJSONスキーマで返してください。`,
      });

      const visualsSaved = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ visuals: parsed.visuals }),
        cache: "no-store",
      });
      if (!visualsSaved.ok) {
        return NextResponse.json({ error: "ビジュアルの保存に失敗しました" }, { status: 502 });
      }

      return NextResponse.json({ visuals: parsed.visuals });
    }

    // ── 1枚だけ作り直す: 納得いかないスライドの内容とビジュアルをまとめて再生成する。
    if (action === "regenerate-slide") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const slide = body.slide as Slide | undefined;
      if (!sessionId || !slide) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }
      const currentVisual = body.visual as VisualCandidate | undefined;
      const otherTitles = Array.isArray(body.slides)
        ? (body.slides as Slide[]).map((s) => s.title).filter((t) => t && t !== slide.title)
        : [];

      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,constraints,template_id&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const organization = srows?.[0]?.organization ?? null;
      const template = findTemplate(srows?.[0]?.template_id);
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      const parsed = await structured<{ slide: Slide; visual: Visual }>({
        system: PERSONA_PROMPT,
        schema: buildRegenerateSlideSchema(template),
        maxTokens: 16000,
        prompt: `【お題】${theme}
${organization ? `【紐付く対象】${organization}` : ""}
${constraintsBlock(srows?.[0]?.constraints)}
==== 他のスライドの見出し（重複回避の参考。内容は変えない） ====
${otherTitles.length > 0 ? otherTitles.map((t) => `- ${t}`).join("\n") : "（なし）"}

==== 今のスライド（吉井さんが納得していない・作り直したい） ====
セクション: ${slide.section}
タイトル: ${slide.title}
要点:
${slide.bullets.map((b) => `- ${b}`).join("\n")}
${currentVisual ? `現在の図解: [${currentVisual.diagramType}] ${currentVisual.description}` : ""}

このスライド1枚だけを、同じセクション（${slide.section}）の役割を保ったまま、内容・図解ともに違う切り口で作り直してください。
他のスライドとの重複は避け、セクションの並び順・枚数には影響を与えないこと。
新しい内容は本文(title/bullets)の中だけで完結させ、図解(svg)の文言・数値・年月も本文と一致させること。
${todayContext()}
指定のJSONスキーマで返してください。`,
      });
      return NextResponse.json(parsed);
    }

    // ── ここを直す: 全面作り直しではなく、吉井さんの自然文の指示だけを反映する。
    // 注意: SVGは毎回丸ごと再生成されるため「指示箇所以外は一字一句同一」までは保証できない
    // （ベストエフォート）。それ以外の変更は避けるよう強く指示するが、完全な差分適用ではない。
    if (action === "fix-slide") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const slide = body.slide as Slide | undefined;
      const visual = body.visual as Visual | undefined;
      const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
      if (!sessionId || !slide || !visual || !instruction) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }

      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,constraints,template_id&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const theme = srows?.[0]?.theme;
      const template = findTemplate(srows?.[0]?.template_id);
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      const parsed = await structured<{ slide: Slide; visual: Visual }>({
        system: PERSONA_PROMPT,
        schema: buildRegenerateSlideSchema(template),
        maxTokens: 8000,
        // 注: thinking:adaptiveを付けると、現在のSVG全文を入力に含む都合上、実測で100秒超かかり
        // Vercelの maxDuration=60 を超えて本番で失敗する恐れがあった（2026-07-27確認）。
        // このアクションは「指示された箇所だけを直す」狭い作業なので、深い思考は不要と判断し外した。
        thinking: false,
        prompt: `【お題】${theme}
${srows?.[0]?.organization ? `【紐付く対象】${srows[0].organization}` : ""}
${constraintsBlock(srows?.[0]?.constraints)}
==== 今のスライド ====
セクション: ${slide.section}
タイトル: ${slide.title}
要点:
${slide.bullets.map((b) => `- ${b}`).join("\n")}

==== 今のビジュアル ====
図解の種類: ${visual.diagramType}
説明: ${visual.description}
現在のSVG:
${visual.svg}

==== 吉井さんからの修正指示 ====
${instruction}

この指示された箇所だけを変更してください。指示に関係ない文言・数値・レイアウト・配色・図解パターン・構図は、できる限りそのまま維持すること
（丸ごと作り直すのではなく、指示箇所以外は「今の状態」を踏襲する）。
${NO_FABRICATION_INSTRUCTION}
${todayContext()}
セクション・並び順への影響は与えないこと。修正後のslideとvisual一式を、指定のJSONスキーマで返してください。`,
      });
      return NextResponse.json(parsed);
    }

    // ── 登録の取り消し: 記憶層(memory_chunks)に登録済みの成果物を削除する（汚染防止のセーフティネット）。
    if (action === "retract") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const purged = await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `slide-refine:${sessionId}` }),
        cache: "no-store",
      });
      if (!purged.ok) {
        return NextResponse.json({ error: "取り消しに失敗しました" }, { status: 502 });
      }
      const titleCleared = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ title: null }),
        cache: "no-store",
      });
      if (!titleCleared.ok) {
        return NextResponse.json({ error: "取り消しに失敗しました" }, { status: 502 });
      }
      return NextResponse.json({ retracted: true });
    }

    // ── 確定して登録: スライド一式を統合し、成果物として記憶層へ保存する
    if (action === "save") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const sres = await fetch(
        `${restUrl(supabaseUrl, "slide_refine_sessions")}?select=theme,organization,category,slides,visuals,constraints&id=eq.${encodeURIComponent(sessionId)}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const row = srows?.[0];
      const theme = row?.theme;
      const organization: string | null = row?.organization ?? null;
      const category: string = row?.category ?? "その他";
      // 吉井さんが最終プレビューで削除・編集した後の一覧が送られてきていれば、そちらを正とする
      // （DBに保存済みの、削除前・編集前の一覧ではなく）。
      const slides: Slide[] = Array.isArray(body.slides)
        ? (body.slides as Slide[])
        : Array.isArray(row?.slides)
          ? row.slides
          : [];
      const visuals: Visual[] = Array.isArray(body.visuals)
        ? (body.visuals as Visual[])
        : Array.isArray(row?.visuals)
          ? row.visuals
          : [];
      if (!theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      if (slides.length === 0) {
        return NextResponse.json({ error: "登録するスライドがありません（すべて削除されています）" }, { status: 400 });
      }

      // 確定した一覧（削除・編集後）をセッションにも反映しておく。
      const finalizedSaved = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ slides, visuals }),
        cache: "no-store",
      });
      if (!finalizedSaved.ok) {
        return NextResponse.json({ error: "確定内容の保存に失敗しました" }, { status: 502 });
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

      const parsed = await structured<{ title: string; content: string }>({
        system: PERSONA_PROMPT,
        schema: SYNTHESIS_SCHEMA,
        maxTokens: 16000,
        prompt: `【お題】${theme}
${organization ? `【紐付く対象】${organization}（${category}）` : ""}
${constraintsBlock(row?.constraints)}
==== 壁打ちの会話 ====
${transcript || "（会話なし）"}

==== 確定したスライド構成案 ====
${slidesText}

==== ビジュアルの狙い ====
${visualsText || "（なし）"}

このスライド壁打ちで熟成した内容を、今後の別提案でも土台として再利用できる形にまとめてください。
目的・聞き手・ゴール、確定した構成、ビジュアルの狙いを必ず反映し、指定のJSONスキーマで返してください。`,
      });

      const today = toJstDateString(new Date().toISOString());
      const chunks = windowChunks(parsed.content);
      if (chunks.length === 0) {
        return NextResponse.json({ error: "熟成した内容が空でした" }, { status: 502 });
      }

      // 同じセッションで再度「確定して登録」すると内容が変わりチャンク数がずれるので、
      // 古いチャンクを先に一掃してから積み直す（/refine の save と同じ理由）。
      const purgedBeforeSave = await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `slide-refine:${sessionId}` }),
        cache: "no-store",
      });
      if (!purgedBeforeSave.ok) {
        return NextResponse.json({ error: "登録に失敗しました" }, { status: 502 });
      }

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

      const titleSaved = await fetch(`${restUrl(supabaseUrl, "slide_refine_sessions")}?id=eq.${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ title: parsed.title }),
        cache: "no-store",
      });
      if (!titleSaved.ok) {
        return NextResponse.json({ error: "タイトルの保存に失敗しました" }, { status: 502 });
      }

      return NextResponse.json({ saved: true, title: parsed.title, chunks: chunks.length });
    }

    return NextResponse.json({ error: "不正なアクションです" }, { status: 400 });
  } catch (error) {
    console.error("スライド壁打ちエラー:", error);
    return NextResponse.json(
      { error: llmErrorMessage(error, "処理に失敗しました。") },
      { status: llmErrorStatus(error) }
    );
  }
}
