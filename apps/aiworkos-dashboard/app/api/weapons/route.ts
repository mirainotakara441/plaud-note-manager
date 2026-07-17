import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// 武器生成。/agent が出した打ち手のうち「これでいく」と決めたものを受け取り、
// 現場で使える形（想定ストーリー・想定問答・スライド構成案）に落とす。
//
// パイプライン上の位置: 収集 → 登録 → 壁打ちで深める → 【施策案の決定 → 武器を出す】
// スライドの .pptx 清書だけは本物テンプレートが吉井さんの Mac にあるため Vercel では行えない。
// ここでは構成案（1枚ずつの見出しと中身）まで作り、pptx 化は integration_jobs へ起票して
// Claude Code 側の slide-architect に渡す。

export const maxDuration = 60;

const MODEL = "claude-sonnet-5";
const COMMON_ORG = "共通";

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

export type Weapon = {
  /** 自治体への想定ストーリー。説明の流れを場面ごとに */
  story: { scene: string; talk: string }[];
  /** 想定問答。相手の反論・懸念と切り返し */
  qa: { question: string; answer: string }[];
  /** スライド構成案。1要素=1枚 */
  slides: { title: string; bullets: string[] }[];
};

export type Kind = keyof Weapon;
const KINDS: Kind[] = ["story", "qa", "slides"];

// 3種類を1リクエストで作ると、thinking + 出力量で Vercel の60秒上限を超えて
// FUNCTION_INVOCATION_TIMEOUT になる（実測）。種類ごとに分けて呼ぶ。
// 画面側も、先に想定ストーリーが出て順に埋まる方が待ち時間が短く感じられる。
const PART_SCHEMAS: Record<Kind, { [key: string]: unknown }> = {
  story: {
    type: "object",
    properties: {
      story: {
        type: "array",
        description:
          "自治体への想定ストーリー。掴み→現状の課題→打ち手→効果→次の一歩、のように場面を追って説明の流れを作る。5〜7場面。",
        items: {
          type: "object",
          properties: {
            scene: { type: "string", description: "場面の見出し（例: 掴み／現状の痛み）" },
            talk: {
              type: "string",
              description:
                "その場面で実際に話す内容。吉井さんがそのまま口に出せる具体的な言い回しで書く。",
            },
          },
          required: ["scene", "talk"],
          additionalProperties: false,
        },
      },
    },
    required: ["story"],
    additionalProperties: false,
  },
  qa: {
    type: "object",
    properties: {
      qa: {
        type: "array",
        description:
          "想定問答。相手（自治体の担当者・上長）が実際に投げてきそうな反論・懸念と、その切り返し。4〜6組。会議履歴に出てくる実際の懸念を優先する。",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "相手からの問い・反論・懸念" },
            answer: { type: "string", description: "切り返し。事実・数字で答える" },
          },
          required: ["question", "answer"],
          additionalProperties: false,
        },
      },
    },
    required: ["qa"],
    additionalProperties: false,
  },
  slides: {
    type: "object",
    properties: {
      slides: {
        type: "array",
        description:
          "提案スライドの構成案。1要素が1枚。表紙は不要で、中身のスライドだけ。6〜10枚。",
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
  },
};

const PART_LABEL: Record<Kind, string> = {
  story: "想定ストーリー",
  qa: "想定問答",
  slides: "スライド構成案",
};

const PART_INSTRUCTION: Record<Kind, string> = {
  story:
    "story のみを作ってください。要約ではなく、吉井さんがそのまま口に出せる「実際に話す言葉」で書くこと。",
  qa:
    "qa のみを作ってください。会議履歴に実際に出てくる相手の懸念・反論を最優先で拾うこと。実際に言われたことが最も価値があります。",
  slides:
    "slides のみを作ってください。1要素が1枚。表紙は不要で、中身のスライドだけ。この構成案はそのまま .pptx に清書されます。",
};

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
吉井さんが「この打ち手でいく」と決めた施策を、現場でそのまま使える武器（想定ストーリー・想定問答・スライド構成案）に落とします。

厳守事項:
- 与えられた「決定した施策」「共通資料」「この団体向けの成果物」「会議履歴」に書かれた事実のみに基づくこと。
- 資料に無い数字・人名・経緯・約束事を憶測で創作してはならない。情報が足りない部分は、踏み込んだ断定を避ける。
- 共通資料にあるサービスの価値訴求・実績数値は積極的に使う。ただし数値は資料どおりに正確に引くこと。
- 会議履歴に出てくる相手の懸念・反論は、想定問答に必ず反映すること。実際に言われたことが最も価値がある。
- 想定ストーリーの talk は、要約ではなく「実際に話す言葉」で書くこと。吉井さんがそのまま口に出せる粒度にする。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 出力は必ず指定された JSON スキーマに従うこと。各配列を空にしてはならない。`;

async function searchMemory(
  supabaseUrl: string,
  anonKey: string,
  body: Record<string, unknown>
): Promise<MemoResult[]> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? (data.results as MemoResult[]) : [];
  } catch {
    return [];
  }
}

async function fetchMeetings(
  supabaseUrl: string,
  anonKey: string,
  organization: string
): Promise<Meeting[]> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/org-history`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ organization }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.meetings) ? (data.meetings as Meeting[]) : [];
  } catch {
    return [];
  }
}

function formatDocs(docs: MemoResult[], empty: string): string {
  if (docs.length === 0) return empty;
  return docs.map((d) => `- ${d.title}: ${d.content}`).join("\n");
}

// 武器を成果物として記憶へ戻す（壁打ちの熟成と同じ考え方。次の提案の土台になる）。
// 埋め込み(gte-small)は日本語およそ500字で頭打ちになるため 400字に刻む。
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 60;

function windowChunks(text: string): string[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= CHUNK_SIZE) return [body];
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    chunks.push(body.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/** 武器の1種類を、記憶に戻すための1本のテキストにする */
function partToText(kind: Kind, part: Partial<Weapon>, actions: string[]): string {
  const head = `【決定した施策】\n${actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
  if (kind === "story") {
    return `${head}\n\n【想定ストーリー】\n${(part.story ?? [])
      .map((s) => `■${s.scene}\n${s.talk}`)
      .join("\n\n")}`;
  }
  if (kind === "qa") {
    return `${head}\n\n【想定問答】\n${(part.qa ?? [])
      .map((q) => `Q: ${q.question}\nA: ${q.answer}`)
      .join("\n\n")}`;
  }
  return `${head}\n\n【スライド構成案】\n${(part.slides ?? [])
    .map((s, i) => `${i + 1}. ${s.title}\n${s.bullets.map((b) => `  - ${b}`).join("\n")}`)
    .join("\n")}`;
}

async function savePart(
  supabaseUrl: string,
  anonKey: string,
  organization: string,
  weaponId: string,
  kind: Kind,
  title: string,
  text: string
): Promise<number> {
  const chunks = windowChunks(text);
  const today = new Date().toISOString().slice(0, 10);

  // 同じ武器を作り直すとチャンク数が変わるため、この種類の前回分を一掃してから入れ直す
  await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
    method: "POST",
    headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source_id_prefix: `weapon:${weaponId}:${kind}:` }),
    cache: "no-store",
  });

  await Promise.all(
    chunks.map((chunk, i) =>
      fetch(`${supabaseUrl}/functions/v1/store-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "成果物",
          source_id: `weapon:${weaponId}:${kind}:${i + 1}`,
          organization,
          title: `${title}｜${PART_LABEL[kind]}｜${today}｜${i + 1}/${chunks.length}`,
          content: chunk,
          event_date: today,
          metadata: {
            種別: "その他",
            資料名: title,
            出所: "武器生成",
            武器種別: PART_LABEL[kind],
            位置: `${i + 1}/${chunks.length}`,
          },
        }),
        cache: "no-store",
      })
    )
  );
  return chunks.length;
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  if (!anthropicKey || anthropicKey.trim() === "" || anthropicKey === "sk-ant-xxxxx") {
    return NextResponse.json({ error: "ANTHROPIC_APIキーが未設定です" }, { status: 500 });
  }

  let body: {
    organization?: unknown;
    actions?: unknown;
    note?: unknown;
    kind?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const kind = body.kind as Kind;
  if (!KINDS.includes(kind)) {
    return NextResponse.json(
      { error: `kind は次から指定してください: ${KINDS.join(" / ")}` },
      { status: 400 }
    );
  }

  const organization =
    typeof body.organization === "string" ? body.organization.trim() : "";
  if (!organization) {
    return NextResponse.json({ error: "対象を選んでください" }, { status: 400 });
  }

  // 「これでいく」と決めた打ち手。ここが施策案の決定にあたる。
  const actions = Array.isArray(body.actions)
    ? body.actions.filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  if (actions.length === 0) {
    return NextResponse.json(
      { error: "武器にする打ち手を1つ以上選んでください" },
      { status: 400 }
    );
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";

  // 土台を集める。壁打ちの熟成メモも成果物なのでここに含まれる。
  // 60秒上限に収めるため、件数は控えめにして類似度上位だけを使う。
  const [deliverables, commonDocs, meetings] = await Promise.all([
    searchMemory(supabaseUrl, anonKey, {
      query: `${organization} ${actions.join(" ")}`,
      source_type: "成果物",
      organization,
      match_count: 20,
    }),
    searchMemory(supabaseUrl, anonKey, {
      query: `${organization} ${actions.join(" ")}`,
      source_type: "成果物",
      organization: COMMON_ORG,
      match_count: 12,
    }),
    fetchMeetings(supabaseUrl, anonKey, organization),
  ]);

  const meetingsText =
    meetings.length > 0
      ? meetings
          .map((m) => `- ${m.event_date ?? ""} ${m.title}: ${m.content}`)
          .join("\n")
      : "（会議履歴なし）";

  const userPrompt = `対象: ${organization}

==== 決定した施策（これでいくと決めた打ち手）====
${actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}
${note ? `\n【吉井さんからの補足】\n${note}` : ""}

==== 共通資料（サービス標準の提案の型・実績・戦略）====
${formatDocs(commonDocs, "（共通資料なし）")}

==== この団体向けの成果物（過去の提案・壁打ちで熟成したメモを含む）====
${formatDocs(deliverables, "（この団体向けの成果物なし）")}

==== 会議履歴（時系列・古い順）====
${meetingsText}

上記の事実だけをもとに、決定した施策を${organization}で実行するための武器のうち【${PART_LABEL[kind]}】を作ってください。
${PART_INSTRUCTION[kind]}
配列を空にせず、指定の JSON スキーマで返してください。`;

  const client = new Anthropic({ apiKey: anthropicKey });

  try {
    const message = await client.messages.create({
      model: MODEL,
      // 1種類だけ作るので 8000 で足りる。thinking 込みで60秒に収める。
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      output_config: { format: { type: "json_schema", schema: PART_SCHEMAS[kind] } },
      messages: [{ role: "user", content: userPrompt }],
    });

    if (message.stop_reason === "refusal") {
      return NextResponse.json({ error: "生成が拒否されました" }, { status: 502 });
    }
    const tb = message.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    if (!tb) {
      return NextResponse.json({ error: "武器の生成に失敗しました" }, { status: 502 });
    }

    let part: Partial<Weapon>;
    try {
      part = JSON.parse(tb.text) as Partial<Weapon>;
    } catch {
      return NextResponse.json({ error: "武器の生成に失敗しました" }, { status: 502 });
    }

    // 作った武器を成果物として記憶へ戻す。次に /agent や /refine を開いたとき土台に入る。
    // weaponId は決定した施策から決まるため、同じ施策で作り直すと上書きされ、増殖しない。
    const weaponId = `${organization}:${actions.join("|")}`.slice(0, 100);
    const title = `${organization} ${actions[0]}${
      actions.length > 1 ? ` ほか${actions.length - 1}件` : ""
    }｜武器`;
    let savedChunks = 0;
    try {
      savedChunks = await savePart(
        supabaseUrl,
        anonKey,
        organization,
        weaponId,
        kind,
        title,
        partToText(kind, part, actions)
      );
    } catch (e) {
      // 記憶への保存に失敗しても、武器そのものは画面に返す
      console.error("武器の記憶保存に失敗:", e);
    }

    return NextResponse.json({
      organization,
      kind,
      part,
      title,
      savedChunks,
      deliverablesCount: deliverables.length,
      commonDocsCount: commonDocs.length,
      meetingsCount: meetings.length,
    });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401) {
      return NextResponse.json({ error: "ANTHROPIC_APIキーが無効です" }, { status: 500 });
    }
    console.error("武器生成エラー:", error);
    return NextResponse.json(
      { error: "武器の生成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
