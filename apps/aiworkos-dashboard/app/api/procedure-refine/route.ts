import { NextRequest, NextResponse } from "next/server";
// Anthropic は Anthropic.MessageParam / Anthropic.TextBlock の型と、
// 名称付け（save）で使う生クライアント呼び出しのために残している。
// 実際の呼び出しは原則 lib/llm.ts のヘルパー経由。
import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL,
  isLlmConfigured,
  llmClient,
  structured,
  text as llmText,
} from "@/lib/llm";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import {
  findProcedureTemplate,
  procedureSectionNames,
  procedureToMarkdown,
  type ProcedureItem,
  type ProcedureTemplate,
} from "@/lib/procedureTemplates";

// 提出文書 壁打ち。/slide-refine の文書版。
// 実施理由書・実施要領書・スキーム整理など、相手方に出して判断・合意を得る文書を扱う。
// お題（何の文書か）を軸に、文書の型ごとの急所（lib/procedureTemplates.ts の interviewFocus）をAIが深掘り →
// 章立て案（表を含む） → 章ごとの手直し → 成果物として記憶層へ保存する。
// 会話は procedure_refine_sessions / procedure_refine_messages に残す。
//
// スライド壁打ちとの設計上の違い:
//   - 生成物がSVGではなく「文書の章」なので、図解の候補選択・描画のステージが無い。
//     代わりに、章によっては表（スケジュール・役割分担）が主役になる。
//   - この種の文書は「決まっていないことを決めきる」ためのものである。埋められない項目を
//     もっともらしく創作されると実害が出るので、AIには創作させず open_items（要確認事項）
//     として別立てで出させ、画面で潰していく。

export const maxDuration = 60;

type Msg = { role: "user" | "assistant"; content: string };
// AIには rows を {cells:[...]} の配列で返させ、保存時に string[][] へ均す
// （表の行を素の二次元配列で返させるより、スキーマ違反が起きにくい）。
type RawTable = { caption: string; headers: string[]; rows: { cells: string[] }[] };
type RawItem = { section: string; title: string; body: string[]; table: RawTable };

// 面談用のシステムプロンプト。深掘りの急所は文書の種類ごとに違う（実施理由書なら
// 「庁内で誰が反対しそうか」、実施要領書なら「役割分担が曖昧でないか」）ため、
// テンプレートの interviewFocus を差し込んで組み立てる。
function systemPrompt(template: ProcedureTemplate): string {
  return `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
これから作る1本の「${template.label}」について、吉井さんと「壁打ち」をして中身の土台を固めます。

この文書の位置づけ: ${template.description}
相手方（自治体・事業者・社内）に提示して、判断・合意を得るための文書です。
提案書と違い、曖昧なまま出すと相手が動けません。次の急所が埋まっているかを確かめてください。

深掘りの軸:
${template.interviewFocus}

深掘りのルール（厳守）:
- 質問は「判断軸の発見」と「次のアクション」につながる前向きな問いにすること。
- 表面的な質問（資料を読めば分かること、はい/いいえで終わること）はしない。
- 1回に投げる質問は2〜3問まで。多すぎると答えられない。
- 事実・数字・人名・日付を憶測で創作しない。不明なことは質問で埋める。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 過度なポジティブや励ましは不要。簡潔・直接的に。

出力の形式（厳守）:
- 質問は必ず「**Q1. 問いの見出し**」という行で始めること（Q2, Q3 も同様）。見出し行は ** で囲み、1行で完結させる。
- 見出しの次の行から、その問いの補足説明を書く。
- 画面はこの形式を頼りに問いを切り出し、1問ごとに入力欄を並べる。形式が崩れると吉井さんが答えにくくなる。
- 聞き方を変えて問い直す場合は「**Q3（言い換え）. …**」のようにラベルに括弧書きを添える。

進め方（重要: 2〜3往復での収束を目安にする）:
- 文書の種類と目的はあらかじめ与えられているので、上の深掘りの軸のうち、まだ言語化されていないものを優先して聞く。
- 吉井さんの回答を受けたら、それを踏まえて更に深掘りするか、次の急所に移る。
- 十分に固まったと判断したら、質問を続ける代わりにその旨を伝え、「続けてもいいし、このまま章立て案に進んでもいい」という趣旨を明示すること。どちらも対等な選択肢として伝え、強制しないこと。`;
}

// 章立て生成・作り直し・要約まとめ用の軽量ペルソナ指示。
// 面談用の systemPrompt() は「**Q1. 見出し**」形式を強く指示しているため、JSON生成の呼び出しに
// 使い回すと面談形式の文章が本文に混入する事故が起きる（slide-refine で実際に発生・確認済み）。
const PERSONA_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
相手方に提示して判断・合意を得るための文書（実施理由書・実施要領書・スキーム整理など）の中身を検討・作成する場面です。

ルール:
- 事実・数字・人名・日付・部署名を憶測で創作しない。壁打ちの会話に無い固有名詞や日付を勝手に埋めないこと。
- 埋められない項目は、それらしい内容で埋めるのではなく「要確認事項」として別立てで挙げること。
  本文中でどうしても触れる必要がある場合は「（要確認）」と明記し、断定しない。
- 文体は行政文書として一般的な「〜する」「〜とする」の簡潔な書き方にする。
- 関西弁は使わない。通常の丁寧なビジネス日本語で書くこと。過度なポジティブや励ましは不要。
- 出力は指定されたJSON schemaで要求されている内容そのものにすること。「**Q1.**」のような見出し記法や、面談・質問形式の文章を混ぜないこと。
- 相手方が自治体・議員など公的な立場の場合、特定企業の売り込みや相手への批判と受け取られる表現は避け、事実と手順の記述にとどめること。`;

const NO_FABRICATION_INSTRUCTION =
  "固有名詞・数値・年月日・部署名・担当者名は、壁打ちの会話で実際に出たものだけを使うこと。" +
  "会話に無い事実を新たに作らない。期間や日付の計算を憶測で行わない。" +
  "用語は会話に出た表記に一字一句合わせ、言い換えないこと（例:「定額小為替」を「郵便小為替」等に変えない）。";

function todayContext(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `【今日の日付】${today}。スケジュールを書く場合、この日付と会話に出た予定日から素直に導ける範囲にとどめ、根拠のない具体日を置かないこと。`;
}

function constraintsBlock(constraints?: string | null): string {
  const c = constraints?.trim();
  return c ? `\n==== 守るべき制約（壁打ちの会話から抽出） ====\n${c}\n` : "";
}

// 1章分のschema。sectionのenumは選ばれたテンプレートの章名に合わせて組み立てる。
function itemSchema(template: ProcedureTemplate) {
  const names = procedureSectionNames(template);
  const sectionDescription = template.sections
    .map((s) => `${s.name}=${s.guidance}（${s.countHint}）。`)
    .join("");
  return {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: names,
        description: `この章がどの区分にあたるか。${sectionDescription}`,
      },
      title: { type: "string", description: "章の見出し（本文の内容が分かる具体的な見出し）" },
      body: {
        type: "array",
        description:
          "章の本文。1要素が1行。手順の章では実行する順番に並べ、1行1動作にする。3〜7行程度。",
        items: { type: "string" },
      },
      table: {
        type: "object",
        description:
          "この章に表が必要な場合だけ作る。不要ならcaption・headers・rowsをすべて空にすること。",
        properties: {
          caption: { type: "string", description: "表の見出し。表が無い場合は空文字。" },
          headers: {
            type: "array",
            description: "表の列名。表が無い場合は空配列。",
            items: { type: "string" },
          },
          rows: {
            type: "array",
            description: "表の行。cellsの数はheadersと同じにすること。表が無い場合は空配列。",
            items: {
              type: "object",
              properties: { cells: { type: "array", items: { type: "string" } } },
              required: ["cells"],
              additionalProperties: false,
            },
          },
        },
        required: ["caption", "headers", "rows"],
        additionalProperties: false,
      },
    },
    required: ["section", "title", "body", "table"],
    additionalProperties: false,
  };
}

// 章立ては「1回で全章」ではなく数章ずつに分けて作る（下の draft アクションのコメント参照）。
// sectionNames はそのバッチで作る章だけに絞り、schemaのenumもそこへ狭める
// （全章のenumを渡すと、担当外の章まで書き始めてしまう）。
function buildDraftPartSchema(template: ProcedureTemplate, sectionNames: string[]) {
  const scoped: ProcedureTemplate = {
    ...template,
    sections: template.sections.filter((s) => sectionNames.includes(s.name)),
  };
  const order = sectionNames.join("→");
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: `${template.label}のうち、次の章だけを作る: ${order}。1要素が1章。この順で並んでいること。指定外の章は絶対に作らない。表紙・目次は不要。`,
        items: itemSchema(scoped),
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}

// 要確認事項・制約の抽出だけを行う軽い呼び出し（出力が短いので速い）。
const OPEN_ITEMS_SCHEMA = {
  type: "object",
  properties: {
    openItems: {
      type: "array",
      description:
        "この文書を相手方に出す前に決めきる必要があるのに、壁打ちの会話ではまだ決まっていない事項。" +
        "「誰に確認すれば決まるか」まで書くと望ましい。本文に「要確認」と書かれている箇所は必ずここに挙げる。",
      items: { type: "string" },
    },
    constraints: {
      type: "array",
      description:
        "壁打ちの会話全体から抽出した、文書全体で守るべき制約（用語の統一、避けるべき表現、相手方の事情など）。" +
        "明示的な言及が無ければ空配列でよい。憶測で作らないこと。",
      items: { type: "string" },
    },
  },
  required: ["openItems", "constraints"],
  additionalProperties: false,
};

function buildSingleItemSchema(template: ProcedureTemplate) {
  return {
    type: "object",
    properties: { item: itemSchema(template) },
    required: ["item"],
    additionalProperties: false,
  };
}

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "この文書の名称（簡潔に。例:「◯◯市 法人請求オンラインサービス実施理由書」）",
    },
  },
  required: ["title"],
  additionalProperties: false,
};

// 埋め込みモデル gte-small は 512token 上限で超過分が黙って切り捨てられる。
// 他の登録経路と同じく400字で刻む（AGENTS.md の再発防止ルール）。
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

function restHeaders(key: string, extra?: Record<string, string>) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// AIの {cells:[...]} 形式から、保存・表示で使う string[][] へ均す。
// 行ごとにセル数がずれていても列数に合わせて詰める（表崩れを画面まで持ち込まない）。
function normalizeItem(raw: RawItem): ProcedureItem {
  const headers = Array.isArray(raw?.table?.headers) ? raw.table.headers.filter(Boolean) : [];
  const rows = Array.isArray(raw?.table?.rows)
    ? raw.table.rows.map((r) =>
        headers.map((_, ci) => (Array.isArray(r?.cells) ? (r.cells[ci] ?? "") : ""))
      )
    : [];
  return {
    section: raw?.section ?? "",
    title: raw?.title ?? "",
    body: Array.isArray(raw?.body) ? raw.body : [],
    table: {
      caption: headers.length > 0 ? (raw?.table?.caption ?? "") : "",
      headers,
      rows: headers.length > 0 ? rows : [],
    },
  };
}

// 画面から戻ってきた章（吉井さんが編集済み）を、そのままAIへ渡せるテキストにする。
function itemToText(item: ProcedureItem, i: number): string {
  const lines = [`${i + 1}. [${item.section}] ${item.title}`];
  (item.body ?? []).filter(Boolean).forEach((b) => lines.push(`- ${b}`));
  const headers = item.table?.headers?.filter(Boolean) ?? [];
  if (headers.length > 0) {
    lines.push(`表: ${item.table.caption || "（見出しなし）"}`);
    lines.push(`  ${headers.join(" / ")}`);
    (item.table.rows ?? []).forEach((r) => lines.push(`  ${r.join(" / ")}`));
  }
  return lines.join("\n");
}

async function loadMessages(
  supabaseUrl: string,
  anonKey: string,
  sessionId: string
): Promise<Msg[]> {
  const res = await fetch(
    `${restUrl(supabaseUrl, "procedure_refine_messages")}?select=role,content&session_id=eq.${sessionId}&order=created_at.asc`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? (rows as Msg[]) : [];
}

async function saveMessage(
  supabaseUrl: string,
  serviceKey: string,
  sessionId: string,
  role: Msg["role"],
  content: string
): Promise<void> {
  await fetch(restUrl(supabaseUrl, "procedure_refine_messages"), {
    method: "POST",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ session_id: sessionId, role, content }),
    cache: "no-store",
  });
  await fetch(`${restUrl(supabaseUrl, "procedure_refine_sessions")}?id=eq.${sessionId}`, {
    method: "PATCH",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
    cache: "no-store",
  });
}

async function askClaude(
  theme: string,
  history: Msg[],
  template: ProcedureTemplate,
  organization?: string | null,
  category?: string | null,
  purpose?: string | null,
  period?: string | null,
  baseDoc?: string | null,
  baseDocName?: string | null
): Promise<string> {
  const linkInstruction =
    organization && organization.trim()
      ? `この文書は特定の相手方に紐付いています。相手方: ${organization}（${category ?? "その他"}）。深掘りの際はこの相手方の事情を踏まえてください。`
      : `特定の相手方には紐付いていません。汎用の想定で構いませんが、その旨を踏まえて「誰に出す前提か」を確認してください。`;

  const periodInstruction =
    period && period.trim()
      ? `実施時期の目安として「${period}」が与えられています。スケジュールの深掘りはこれを起点にしてください。`
      : `実施時期はまだ指定されていません。相手方の都合で動かせない日を含めて、時期を早めに固めてください。`;

  // 元文書があるときは「直す」仕事として指示を切り替える。ここを書かないと、
  // 資料を渡してもゼロから作り直した案を返してくる。
  const baseInstruction = baseDoc
    ? `【元になる文書${baseDocName ? `（${baseDocName}）` : ""}】
${baseDoc}

この文書は既にある下敷きです。ゼロから作り直すのではなく、これを今回のお題・相手向けに
直すことが目的です。まず何がそのまま使えて、何を差し替える必要があるかを見極め、
差し替えが要る箇所についてだけ質問してください。既に書いてあることを聞き直さないこと。`
    : "";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `【お題】どんな文書を作るか
${theme}

${baseInstruction}

【文書の種類】${template.label}（${template.description}）
想定している章立て: ${procedureSectionNames(template).join(" / ")}

${purpose ? `【この文書の位置づけ】${purpose}` : ""}

${periodInstruction}

${linkInstruction}

このお題をもとに壁打ちを始めてください。上の章立てのうち、まだ埋められない箇所を突き止める質問を2〜3問投げてください。`,
    },
  ];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  // 面談の応答は構造化出力ではなく素の文章なので text() を使う。
  const reply = await llmText({
    system: systemPrompt(template),
    messages,
    maxTokens: 8000,
  });

  return reply || "（応答を生成できませんでした）";
}

const SESSION_COLUMNS =
  "id,theme,organization,category,title,purpose,template_id,period,base_doc,base_doc_name,updated_at";

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
      `${restUrl(supabaseUrl, "procedure_refine_sessions")}?select=purpose,period,items,open_items,template_id&id=eq.${sessionId}`,
      { headers: restHeaders(anonKey), cache: "no-store" }
    );
    const srows = sres.ok ? await sres.json() : [];
    const row = srows?.[0];
    return NextResponse.json({
      messages,
      purpose: row?.purpose ?? null,
      period: row?.period ?? null,
      templateId: row?.template_id ?? null,
      items: Array.isArray(row?.items) ? row.items : [],
      openItems: Array.isArray(row?.open_items) ? row.open_items : [],
    });
  }

  const res = await fetch(
    `${restUrl(supabaseUrl, "procedure_refine_sessions")}?select=${SESSION_COLUMNS}&order=updated_at.desc&limit=20`,
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
    baseDoc?: unknown;
    baseDocName?: unknown;
    organization?: unknown;
    category?: unknown;
    purpose?: unknown;
    period?: unknown;
    templateId?: unknown;
    message?: unknown;
    items?: unknown;
    openItems?: unknown;
    sectionNames?: unknown;
    priorItems?: unknown;
    item?: unknown;
    instruction?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const action = body.action;

  // セッション行を読む共通処理（必要な列だけ都度指定する）。
  async function loadSession(sessionId: string, columns: string) {
    const res = await fetch(
      `${restUrl(supabaseUrl, "procedure_refine_sessions")}?select=${columns}&id=eq.${sessionId}`,
      { headers: restHeaders(anonKey), cache: "no-store" }
    );
    const rows = res.ok ? await res.json() : [];
    return rows?.[0] ?? null;
  }

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
      const period =
        typeof body.period === "string" && body.period.trim() ? body.period.trim() : null;
      const template = findProcedureTemplate(
        typeof body.templateId === "string" ? body.templateId : null
      );
      const baseDoc =
        typeof body.baseDoc === "string" ? body.baseDoc.trim().slice(0, 60000) : "";
      const baseDocName =
        typeof body.baseDocName === "string" ? body.baseDocName.trim().slice(0, 200) : "";
      if (!theme) {
        return NextResponse.json({ error: "お題を入力してください" }, { status: 400 });
      }

      const created = await fetch(restUrl(supabaseUrl, "procedure_refine_sessions"), {
        method: "POST",
        headers: restHeaders(serviceKey, { Prefer: "return=representation" }),
        body: JSON.stringify({
          theme,
          organization,
          category,
          purpose,
          period,
          template_id: template.id,
          base_doc: baseDoc || null,
          base_doc_name: baseDocName || null,
        }),
        cache: "no-store",
      });
      if (!created.ok) {
        return NextResponse.json({ error: "セッション作成に失敗しました" }, { status: 502 });
      }
      const rows = await created.json();
      const session = Array.isArray(rows) ? rows[0] : rows;

      const reply = await askClaude(
        theme,
        [],
        template,
        organization,
        category,
        purpose,
        period,
        baseDoc || null,
        baseDocName || null
      );
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
      const row = await loadSession(
        sessionId,
        "theme,organization,category,purpose,period,template_id"
      );
      if (!row?.theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      await saveMessage(supabaseUrl, serviceKey, sessionId, "user", message);
      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const reply = await askClaude(
        row.theme,
        history,
        findProcedureTemplate(row.template_id),
        row.organization,
        row.category,
        row.purpose,
        row.period,
        row.base_doc,
        row.base_doc_name
      );
      await saveMessage(supabaseUrl, serviceKey, sessionId, "assistant", reply);

      return NextResponse.json({ messages: await loadMessages(supabaseUrl, anonKey, sessionId) });
    }

    // ── 章立て案（分割生成）: 会話から指定された章だけを作る。
    //
    // なぜ分割するか: 1回で全章を作る設計にしていたが、2026-07-30 に吉井さんの実セッション
    // （trial型・8章・9往復・会話5,200字）で本番が失敗。同じ入力をローカルで測ると
    // thinking有りで56秒、thinkingを外しても62.6秒かかり、Vercelの maxDuration=60 を超えていた。
    // 律速はモデルの思考ではなく「日本語の章本文＋表をまとめて吐き出す出力量」なので、
    // thinkingを外すだけでは足りない。画面側が数章ずつに分けて呼び、1回の呼び出しを短く保つ。
    // 12章ある実施理由書でも各バッチは3章程度に収まり、上限に対して十分な余裕ができる。
    //
    // priorItems には、すでに出来上がっている前のバッチの章が入る。重複回避の参考として
    // モデルに見せ、DBにも合算して保存する（途中で失敗しても、そこまでは残って再開できる）。
    if (action === "draft") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const requestedTemplateId =
        typeof body.templateId === "string" && body.templateId.trim()
          ? body.templateId.trim()
          : null;
      const row = await loadSession(
        sessionId,
        "theme,organization,category,purpose,period,template_id"
      );
      if (!row?.theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      // 章立て案の生成時にテンプレートを選び直せる（未指定なら開始時のもの）。
      const template = findProcedureTemplate(requestedTemplateId ?? row.template_id);
      const allNames = procedureSectionNames(template);
      // 章の指定が無ければ全章（テンプレートの章数が少ない場合や、外部から素直に叩く場合）。
      const requested = Array.isArray(body.sectionNames)
        ? (body.sectionNames as unknown[]).filter(
            (n): n is string => typeof n === "string" && allNames.includes(n)
          )
        : [];
      const sectionNames = requested.length > 0 ? requested : allNames;
      const priorItems: ProcedureItem[] = Array.isArray(body.priorItems)
        ? (body.priorItems as ProcedureItem[])
        : [];

      const sectionGuidance = template.sections
        .filter((s) => sectionNames.includes(s.name))
        .map(
          (s) =>
            `- ${s.name}: ${s.guidance}（${s.countHint}）${s.tableHint ? ` ※${s.tableHint}` : " ※この章に表は不要"}`
        )
        .join("\n");

      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");

      const parsed = await structured<{ items: RawItem[] }>({
        system: PERSONA_PROMPT,
        schema: buildDraftPartSchema(template, sectionNames),
        maxTokens: 16000,
        // 上の実測メモの通り、この呼び出しは maxDuration=60 に対して余裕が無いため thinking は付けない。
        thinking: false,
        prompt: `【お題】${row.theme}
【文書の種類】${template.label}
${row.organization ? `【相手方】${row.organization}（${row.category ?? "その他"}）` : "【相手方】特定なし"}
${row.purpose ? `【位置づけ】${row.purpose}` : ""}
${row.period ? `【実施時期の目安】${row.period}` : ""}
【この文書の全体構成】${allNames.join("→")}

==== 壁打ちの会話 ====
${transcript || "（まだ会話はありません。お題のみから章立て案を作ってください）"}

${
  priorItems.length > 0
    ? `==== すでに出来ている章（内容は変えない。重複を避けるための参考） ====\n${priorItems
        .map((it, k) => `${k + 1}. [${it.section}] ${it.title}`)
        .join("\n")}\n`
    : ""
}
この壁打ちの内容をもとに、上の全体構成のうち **${sectionNames.join("・")}** の章だけを作ってください。
指定外の章は絶対に作らないこと（後続のバッチで別途作ります）。
${sectionGuidance}

${NO_FABRICATION_INSTRUCTION}
${todayContext()}
会話で決まっていない事項は、本文をそれらしく埋めるのではなく「（要確認）」と明記して断定しないでください。
指定のJSONスキーマで返してください。`,
      });
      const items = (parsed.items ?? []).map(normalizeItem);
      const merged = [...priorItems, ...items];

      await fetch(`${restUrl(supabaseUrl, "procedure_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ items: merged, template_id: template.id }),
        cache: "no-store",
      });

      return NextResponse.json({ items, allItems: merged, templateId: template.id });
    }

    // ── 要確認事項・制約の抽出: 章立てが揃ってから、決めきれていない事項だけを別立てで出す。
    // 章本文の生成と分けているのは、出力が短く速いのと、章を作り直した後にも再抽出できるため。
    if (action === "draft-open") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const items: ProcedureItem[] = Array.isArray(body.items) ? (body.items as ProcedureItem[]) : [];
      if (!sessionId || items.length === 0) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }
      const row = await loadSession(sessionId, "theme,organization,category,period,template_id");
      if (!row?.theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      const template = findProcedureTemplate(row.template_id);
      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");

      const parsed = await structured<{ openItems?: string[]; constraints?: string[] }>({
        system: PERSONA_PROMPT,
        schema: OPEN_ITEMS_SCHEMA,
        maxTokens: 4000,
        // 元から thinking は付けていない呼び出し（短い抽出処理・速度優先）。
        thinking: false,
        prompt: `【お題】${row.theme}
【文書の種類】${template.label}
${row.organization ? `【相手方】${row.organization}（${row.category ?? "その他"}）` : ""}

==== 壁打ちの会話 ====
${transcript || "（会話なし）"}

==== 出来上がった章立て ====
${items.map((it, k) => itemToText(it, k)).join("\n\n")}

この文書を相手方に出す前に決めきる必要があるのに、まだ決まっていない事項を openItems に挙げてください。
本文に「要確認」と書かれている箇所は必ず拾うこと。会話で決まっている事項は挙げないこと。
あわせて、会話の中で吉井さんが述べた「文書全体で守るべき制約」があれば constraints に抽出してください（無ければ空配列）。
指定のJSONスキーマで返してください。`,
      });
      const openItems = Array.isArray(parsed.openItems) ? parsed.openItems.filter(Boolean) : [];
      const constraints = Array.isArray(parsed.constraints)
        ? parsed.constraints.filter(Boolean)
        : [];

      await fetch(`${restUrl(supabaseUrl, "procedure_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({
          items,
          open_items: openItems,
          constraints: constraints.length > 0 ? constraints.join("\n") : null,
        }),
        cache: "no-store",
      });

      return NextResponse.json({ openItems, constraints });
    }

    // ── 1章だけ作り直す / ここを直す: instruction があれば「指示された箇所だけ」の修正、
    // 無ければ同じ章区分のまま違う切り口で作り直す。処理の骨格が同じなので1経路にまとめる。
    if (action === "rewrite-item") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const item = body.item as ProcedureItem | undefined;
      const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
      if (!sessionId || !item) {
        return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
      }
      const row = await loadSession(
        sessionId,
        "theme,organization,category,purpose,period,constraints,template_id"
      );
      if (!row?.theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      const template = findProcedureTemplate(row.template_id);
      const section = template.sections.find((s) => s.name === item.section);
      const otherTitles = Array.isArray(body.items)
        ? (body.items as ProcedureItem[]).map((x) => x.title).filter((t) => t && t !== item.title)
        : [];

      const task = instruction
        ? `==== 吉井さんからの修正指示 ====
${instruction}

この指示された箇所だけを変更してください。指示に関係のない文言・表の列・行・並び順は、できる限りそのまま維持すること（丸ごと作り直すのではなく、指示箇所以外は今の状態を踏襲する）。`
        : `この章1つだけを、同じ章区分（${item.section}）の役割を保ったまま、違う切り口で作り直してください。
他の章との重複は避け、章の並び順・数には影響を与えないこと。`;

      const parsed = await structured<{ item: RawItem }>({
        system: PERSONA_PROMPT,
        schema: buildSingleItemSchema(template),
        maxTokens: 8000,
        // 「ここを直す」は狭い作業。Vercelの maxDuration=60 に収めるため thinking は付けない
        // （slide-refine の fix-slide で実測100秒超になった経緯と同じ判断）。
        thinking: false,
        prompt: `【お題】${row.theme}
【文書の種類】${template.label}
${row.organization ? `【相手方】${row.organization}（${row.category ?? "その他"}）` : ""}
${row.period ? `【実施時期の目安】${row.period}` : ""}
${constraintsBlock(row.constraints)}
==== 他の章の見出し（重複回避の参考。内容は変えない） ====
${otherTitles.length > 0 ? otherTitles.map((t) => `- ${t}`).join("\n") : "（なし）"}

==== 今の章 ====
${itemToText(item, 0)}

この章の役割: ${section?.guidance ?? "（テンプレート外の章）"}
${section?.tableHint ? `この章は${section.tableHint}。` : "この章に表は不要（headersとrowsは空にすること）。"}

${task}

${NO_FABRICATION_INSTRUCTION}
${todayContext()}
指定のJSONスキーマで返してください。`,
      });
      return NextResponse.json({ item: normalizeItem(parsed.item) });
    }

    // ── 登録の取り消し: 記憶層(memory_chunks)に登録済みの成果物を削除する
    if (action === "retract") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const purged = await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `procedure-refine:${sessionId}` }),
        cache: "no-store",
      });
      if (!purged.ok) {
        return NextResponse.json({ error: "取り消しに失敗しました" }, { status: 502 });
      }
      await fetch(`${restUrl(supabaseUrl, "procedure_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ title: null }),
        cache: "no-store",
      });
      return NextResponse.json({ retracted: true });
    }

    // ── 確定して登録: 文書の全文をMarkdown化し、成果物として記憶層へ保存する
    if (action === "save") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const row = await loadSession(
        sessionId,
        "theme,organization,category,purpose,period,items,open_items,constraints,template_id"
      );
      if (!row?.theme) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      const organization: string | null = row.organization ?? null;
      const category: string = row.category ?? "その他";
      // 画面で編集・削除した後の一覧が送られてきていればそちらを正とする。
      const items: ProcedureItem[] = Array.isArray(body.items)
        ? (body.items as ProcedureItem[])
        : Array.isArray(row.items)
          ? row.items
          : [];
      const openItems: string[] = Array.isArray(body.openItems)
        ? (body.openItems as string[]).filter(Boolean)
        : Array.isArray(row.open_items)
          ? row.open_items
          : [];
      if (items.length === 0) {
        return NextResponse.json(
          { error: "登録する章がありません（すべて削除されています）" },
          { status: 400 }
        );
      }

      await fetch(`${restUrl(supabaseUrl, "procedure_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ items, open_items: openItems }),
        cache: "no-store",
      });

      // 名称だけAIに付けてもらう。本文は画面で確定した内容そのものを登録する
      // （AIに要約させ直すと、吉井さんが直した文言が登録側でまた変わってしまう）。
      const template = findProcedureTemplate(row.template_id);
      // 注: ここだけ生クライアント(llmClient)を使う。structured() は本文が返らないと例外を投げるが、
      // この呼び出しは「名称が取れなくても既定名で登録を続ける」フォールバックを持っており
      // （下の title の `|| ...` 部分）、その挙動をヘルパーでは表現できないため元の形を保つ。
      // thinking は元から付けていない（短い名称付けなので不要）。
      const naming = await llmClient().messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1000,
        system: [{ type: "text", text: PERSONA_PROMPT }],
        output_config: { format: { type: "json_schema", schema: SYNTHESIS_SCHEMA } },
        messages: [
          {
            role: "user",
            content: `【お題】${row.theme}
【文書の種類】${template.label}
${organization ? `【相手方】${organization}（${category}）` : ""}
${row.period ? `【実施時期の目安】${row.period}` : ""}

==== 章の見出し ====
${items.map((it, i) => `${i + 1}. ${it.title}`).join("\n")}

この文書の名称を付けてください。会話に無い固有名詞を足さないこと。指定のJSONスキーマで返してください。`,
          },
        ],
      });
      const tb = naming.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      const title =
        (tb ? (JSON.parse(tb.text) as { title: string }).title : "")?.trim() ||
        `${organization ? `${organization} ` : ""}${template.label}`;

      const markdown = procedureToMarkdown(title, items, openItems);
      const today = new Date().toISOString().slice(0, 10);
      const chunks = windowChunks(markdown);
      if (chunks.length === 0) {
        return NextResponse.json({ error: "登録する本文が空でした" }, { status: 502 });
      }

      // 同じセッションで登録し直すとチャンク数がずれるので、先に一掃してから積み直す。
      await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `procedure-refine:${sessionId}` }),
        cache: "no-store",
      });

      const results = await Promise.all(
        chunks.map((chunk, i) =>
          fetch(`${supabaseUrl}/functions/v1/store-memory`, {
            method: "POST",
            headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              source_type: "成果物",
              source_id: `procedure-refine:${sessionId}:${i + 1}`,
              organization: organization ?? undefined,
              title: `${title}｜${template.label}｜${today}｜${i + 1}/${chunks.length}`,
              content: chunk,
              event_date: today,
              metadata: {
                種別: "提出文書",
                カテゴリ: category,
                資料名: title,
                文書の型: template.label,
                出所: "提出文書壁打ち",
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

      await fetch(`${restUrl(supabaseUrl, "procedure_refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ title }),
        cache: "no-store",
      });

      return NextResponse.json({ saved: true, title, chunks: chunks.length });
    }

    return NextResponse.json({ error: "不正なアクションです" }, { status: 400 });
  } catch (error) {
    console.error("提出文書壁打ちエラー:", error);
    return NextResponse.json(
      { error: "処理に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
