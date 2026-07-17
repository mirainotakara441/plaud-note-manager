import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// thinking を有効化すると生成に時間がかかるため、Vercel の関数タイムアウトを引き上げる
// （Hobby プランの上限。org-history/search-memory/Claude 生成を合算しても収まる想定）。
export const maxDuration = 60;

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
- 必ず与えられた「会議履歴」「過去成果物（過去にこの団体向けに作った提案書・資料）」「関連メモ」に書かれた事実のみに基づいて分析すること。
- 過去成果物がある場合は、それを今回の提案の土台（ベース）として最大限活用し、会議履歴の最新状況で更新・発展させること。過去に整理済みの論点・打ち手・骨子は引き継ぎ、変化があった点だけ差し替える。
- 【実績数値は「最新実績サマリ」が絶対の正】導入実績・自治体数・事業者数・人口カバー率を書くときは、冒頭に与えられる「最新実績サマリ」の数値だけを使うこと。他の資料（会議録・過去の提案書・年度振り返り等）に別の数値があっても、それは作成当時の値であり最新ではない。資料の日付が新しくても同じ（古い数値を含む資料が新しい日付で登録されていることがある）。サマリ以外の実績数値を引用してはならない。
- 【団体別優先の範囲】「この団体向けの記述を優先する」のは、その団体固有の事情（経緯・キーパーソン・懸念・約束事）に限る。全社共通の実績数値には適用しない。
- 資料に無い数字・人名・経緯・約束事などを憶測で創作してはならない。情報が不足している場合は、その旨を前提として扱う。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書くこと。
- 出力は必ず指定された JSON スキーマに従って構造化して返すこと。issues・actions・materialOutline は必ず中身を埋め、空配列で返してはならない。まず過去成果物と会議履歴を読み込んで論点と打ち手を分析し、その分析結果を各フィールドに反映すること。`;

// structured outputs（output_config.format）で JSON 形状を保証する。
// ツール強制（tool_choice: tool）だと Sonnet が「考えずに即出力」して summary だけ埋め
// issues/actions/materialOutline を空配列で返す問題があったため、ツール使用をやめて
// adaptive thinking を有効化し、思考の上で全フィールドを埋めさせる方式に変更した。
// フィールド順は issues→actions→materialOutline→summary（重要な分析フィールドを先に）。
const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      description:
        "現状の論点・ボトルネックを2〜4個。会議履歴の「課題：」を材料にする。空配列にしないこと。",
      items: { type: "string" },
    },
    actions: {
      type: "array",
      description:
        "次の打ち手を3〜5個。会議履歴の「アクション：」「示唆：」を材料にする。空配列にしないこと。",
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
      description: "提案資料の見出し骨子を4〜6個。空配列にしないこと。",
      items: { type: "string" },
    },
    summary: {
      type: "string",
      description: "これまでの経緯を時系列で3〜5文でまとめた要約。",
    },
  },
  required: ["issues", "actions", "materialOutline", "summary"],
  additionalProperties: false,
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

// 特定団体に紐づかない横断資料（初回提案資料・セミナー資料・戦略など）を入れておく
// 擬似団体名。どの団体の提案でも共通の土台として参照する。
const COMMON_ORG = "共通";

// 実績数値（自治体数・事業者数・人口カバー率）の「正」を1枚に持たせた記録。
// 数値は事業の成長で増え続けるため、各資料には作成当時の値が残る。日付順では
// 解決できない（古い数値を含む資料が新しい日付で登録されることがある）ので、
// この1枚を常に読ませて正とする。
//
// 類似度の順位に頼ると取りこぼす（通常のクエリでは共通資料120件中14位で、
// match_count を絞ると圏外に落ちる）。専用クエリで取ってプロンプト先頭に固定する。
// 実体は memory_chunks の source_id="metrics:共通:最新実績サマリ"（更新はそこへ上書き）。
// metadata.資料名 が "最新実績サマリ" のものを拾う。
const METRICS_QUERY = "最新実績サマリ 自治体トライアル 参加事業者 人口カバー率 団体数";

async function fetchLatestMetrics(
  supabaseUrl: string,
  anonKey: string
): Promise<MemoResult | null> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: METRICS_QUERY,
        source_type: "成果物",
        organization: COMMON_ORG,
        match_count: 5,
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows: MemoResult[] = Array.isArray(data?.results) ? data.results : [];
    return rows.find((r) => (r.metadata?.["資料名"] as string) === "最新実績サマリ") ?? null;
  } catch {
    return null;
  }
}

// 過去成果物（source_type:成果物）を organization で絞って取得。提案のベースとして使う。
// organization フィルタで RPC が対象団体の行のみを返す。
// 検索クエリは絞込先ではなく「提案対象の団体」で作る（共通資料を引くときも、その団体に
// 関連の深い型・戦略が上位に来るようにするため）。
async function fetchDeliverables(
  supabaseUrl: string,
  anonKey: string,
  targetOrg: string,
  filterOrg: string,
  matchCount: number
): Promise<MemoResult[]> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `${targetOrg} 提案 論点 打ち手 骨子`,
        source_type: "成果物",
        organization: filterOrg,
        match_count: matchCount,
      }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? (data.results as MemoResult[]) : [];
  } catch {
    return [];
  }
}

// 会議＋過去成果物の決定的署名。いずれかが変われば（＝新しい成果物を登録した等）
// キャッシュが無効化され、提案が再生成される。
function computeSignature(
  meetings: Meeting[],
  deliverables: MemoResult[],
  commonDocs: MemoResult[]
): string {
  const latest = meetings.reduce(
    (max, m) => (m.event_date && (!max || m.event_date > max) ? m.event_date : max),
    ""
  );
  const totalChars = meetings.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  const delChars = deliverables.reduce((s, d) => s + (d.content?.length ?? 0), 0);
  const comChars = commonDocs.reduce((s, d) => s + (d.content?.length ?? 0), 0);
  return `${meetings.length}:${latest}:${totalChars}:d${deliverables.length}:${delChars}:c${commonDocs.length}:${comChars}`;
}

// proposal-cache Edge Function から取得。失敗しても null を返し生成にフォールバック。
async function fetchProposalCache(
  supabaseUrl: string,
  anonKey: string,
  organization: string
): Promise<{ signature: string; proposal: Proposal; edited: boolean } | null> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/proposal-cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "get", organization }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const cache = data?.cache;
    if (
      cache &&
      typeof cache.signature === "string" &&
      cache.proposal &&
      typeof cache.proposal === "object"
    ) {
      return {
        signature: cache.signature,
        proposal: cache.proposal as Proposal,
        edited: cache.edited === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// proposal-cache Edge Function へ保存。失敗は握りつぶす（保存できなくても返却は続行）。
async function saveProposalCache(
  supabaseUrl: string,
  anonKey: string,
  payload: {
    organization: string;
    signature: string;
    proposal: Proposal;
    meetings: Meeting[];
    model: string;
    edited: boolean;
  }
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/proposal-cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "set", ...payload }),
      cache: "no-store",
    });
  } catch {
    // キャッシュ保存失敗は致命的でない
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

// 数値の食い違いを日付で解決させるため、資料には必ず日付を添える。
// 日付が見えないと「新しい方を採用する」という判断ができない。
function formatDeliverables(docs: MemoResult[], emptyLabel: string): string {
  if (docs.length === 0) return emptyLabel;
  return docs
    .map((d) => {
      const kind = (d.metadata?.["種別"] as string) ?? "成果物";
      return `- [${formatDate(d.event_date)}][${kind}] ${d.title}: ${d.content}`;
    })
    .join("\n");
}

// 吉井さんが手直しした提案を、再生成時に引き継ぐためのテキスト。
// 手直しは「AIの間違いの訂正」か「吉井さん自身の案」であり、会議・成果物が増えた
// というだけで捨ててよいものではない。
function formatEdited(p: Proposal): string {
  const lines: string[] = [];
  if (p.summary) lines.push(`【経緯】${p.summary}`);
  if (p.issues.length) lines.push(`【論点】\n${p.issues.map((s) => `- ${s}`).join("\n")}`);
  if (p.actions.length)
    lines.push(
      `【打ち手】\n${p.actions.map((a) => `- ${a.title}: ${a.detail}`).join("\n")}`
    );
  if (p.materialOutline.length)
    lines.push(`【骨子】\n${p.materialOutline.map((s) => `- ${s}`).join("\n")}`);
  return lines.join("\n\n");
}

function buildUserPrompt(
  organization: string,
  meetings: Meeting[],
  memos: MemoResult[],
  deliverables: MemoResult[],
  commonDocs: MemoResult[],
  editedProposal: Proposal | null,
  metrics: MemoResult | null
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

  const deliverablesText = formatDeliverables(deliverables, "（この団体向けの過去成果物なし）");
  const commonText = formatDeliverables(commonDocs, "（共通資料なし）");

  const memosText =
    memos.length > 0
      ? memos
          .map(
            (m) =>
              `- [${m.source_type}] ${formatDate(m.event_date)} ${m.title}: ${m.content}`
          )
          .join("\n")
      : "（関連メモなし）";

  const editedText = editedProposal
    ? `
========================================
以下は、前回の提案を【吉井さん自身が手直しした版】です。AIの間違いを訂正したか、
吉井さんの考えを反映したものであり、最も信頼できる情報です。
- ここに書かれた内容は原則そのまま引き継ぐこと。特に訂正された事実・数字・固有名詞は絶対に元に戻さないこと。
- 会議履歴に新しい動きがあった場合のみ、その部分を更新・追記する。
- 吉井さんが削除した項目を復活させないこと。
==== 吉井さんが手直しした前回の提案 ====
${formatEdited(editedProposal)}
========================================
`
    : "";

  // 実績数値の唯一の正。他の資料に別の数値があっても、こちらを使わせる。
  const metricsText = metrics
    ? `
==== 最新実績サマリ（実績数値はこれだけを使うこと）====
${metrics.content}
`
    : "";

  return `対象自治体: ${organization}
${metricsText}${editedText}
以下は、法人請求オンラインサービスの【共通資料】（特定の団体に限らない、サービス標準の提案の型・セミナー資料・事業戦略）の抜粋です。提案の「型」「サービスの価値訴求」「全社戦略との整合」はここに従ってください。
==== 共通資料 ====
${commonText}

以下は、過去にこの自治体向けに作成した成果物（提案書・資料など）の抜粋です。今回の提案の【土台（ベース）】として活用してください。共通資料と重複する内容は、この団体向けの記述を優先してください。
==== この団体向けの過去成果物 ====
${deliverablesText}

以下は、この自治体に関するこれまでの会議履歴（時系列・古い順）です。
==== 会議履歴 ====
${meetingsText}

以下は、日記・学びから抽出した関連メモ（補強用）です。
==== 関連メモ ====
${memosText}

上記の事実だけをもとに（共通資料の提案の型と、この団体向けの過去成果物を土台に、会議履歴の最新状況で更新して）、${organization}への営業・提案戦略を指定の JSON スキーマで構造化して返してください。
その際、summary（経緯）だけでなく、以下も必ず空にせず具体的に記述すること:
- issues: 現状の論点・ボトルネックを2〜4個。会議履歴中の「課題：」を主な材料にする。
- actions: 次の打ち手を3〜5個。それぞれ title（見出し）と detail（具体策）。会議履歴中の「アクション：」「示唆：」を材料にする。
- materialOutline: 提案資料の見出し骨子を4〜6個。
いずれのフィールドも空配列のまま返してはならない。`;
}

// summary だけでなく論点・打ち手・骨子まで揃っているか。空の結果をキャッシュしないための判定。
function isComplete(p: Proposal): boolean {
  return (
    !!p.summary &&
    p.issues.length > 0 &&
    p.actions.length > 0 &&
    p.materialOutline.length > 0
  );
}

// Claude で1回生成し Proposal を組み立てる。
// structured outputs（output_config.format）で JSON 形状を保証しつつ、
// adaptive thinking で会議履歴を分析させてから全フィールドを埋めさせる。
async function generateProposal(
  client: Anthropic,
  organization: string,
  meetings: Meeting[],
  memos: MemoResult[],
  deliverables: MemoResult[],
  commonDocs: MemoResult[],
  editedProposal: Proposal | null,
  metrics: MemoResult | null
): Promise<Proposal> {
  const message = await client.messages.create({
    model: MODEL,
    // thinking + 4フィールドの構造化出力を収めるため 16000 に引き上げ。
    max_tokens: 16000,
    // 思考を有効化して、即出力ではなく会議履歴を分析させてから各フィールドを埋めさせる。
    thinking: { type: "adaptive" },
    // 最後の system ブロックの cache_control で system をキャッシュ対象にする
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    // ツール強制の代わりに structured outputs で JSON 形状を保証する
    output_config: {
      format: { type: "json_schema", schema: PROPOSAL_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          organization,
          meetings,
          memos,
          deliverables,
          commonDocs,
          editedProposal,
          metrics
        ),
      },
    ],
  });

  console.log("提案生成:", message.stop_reason, JSON.stringify(message.usage));

  if (message.stop_reason === "refusal") {
    throw new Error("refusal");
  }

  // structured outputs では最初の text ブロックが有効な JSON になる
  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  if (!textBlock) throw new Error("no_text_output");

  let input: Partial<Proposal>;
  try {
    input = JSON.parse(textBlock.text) as Partial<Proposal>;
  } catch {
    throw new Error("invalid_json_output");
  }

  return {
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
}

// 手直しの保存。吉井さんが論点・打ち手・骨子を直したら、その版をキャッシュに書き戻す。
// Claude は呼ばない（訂正をAIに再解釈させない）。
export async function PUT(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  let body: { organization?: unknown; proposal?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const organization =
    typeof body.organization === "string" ? body.organization.trim() : "";
  if (!organization) {
    return NextResponse.json({ error: "自治体が指定されていません" }, { status: 400 });
  }
  const p = body.proposal as Proposal | undefined;
  if (!p || typeof p !== "object" || !Array.isArray(p.issues)) {
    return NextResponse.json({ error: "提案の形式が不正です" }, { status: 400 });
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/proposal-cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", organization, proposal: p }),
      cache: "no-store",
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: d?.error ?? "手直しの保存に失敗しました" },
        { status: 502 }
      );
    }
    return NextResponse.json({ saved: true, edited: true });
  } catch {
    return NextResponse.json({ error: "手直しの保存に失敗しました" }, { status: 502 });
  }
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

  let body: { organization?: unknown; force?: unknown };
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

  // a-2. 提案のベースとなる成果物。キャッシュ署名に含めるため、キャッシュ確認より先に取得する。
  //   - この団体向け: 取りこぼしを避けるため多め（40）に取る。
  //   - 共通資料: 全団体分の横断資料（100件超）が対象なので、類似度上位のみに絞って
  //     プロンプトの肥大を防ぐ。
  const [deliverables, commonDocs, metrics] = await Promise.all([
    fetchDeliverables(supabaseUrl, anonKey, organization, organization, 40),
    organization === COMMON_ORG
      ? Promise.resolve<MemoResult[]>([])
      : fetchDeliverables(supabaseUrl, anonKey, organization, COMMON_ORG, 20),
    fetchLatestMetrics(supabaseUrl, anonKey),
  ]);

  // a-3. 永続キャッシュ確認。会議・成果物が変わっておらず force でなければ Claude を呼ばず即返す。
  const force = body.force === true;
  const signature = computeSignature(meetings, deliverables, commonDocs);
  const cached = await fetchProposalCache(supabaseUrl, anonKey, organization);
  if (!force && cached && cached.signature === signature) {
    return NextResponse.json({
      organization,
      meetings,
      proposal: cached.proposal,
      deliverablesCount: deliverables.length,
      commonDocsCount: commonDocs.length,
      cached: true,
      edited: cached.edited,
    });
  }

  // 手直しされた版があれば再生成の土台にする。会議・成果物が増えたというだけで
  // 吉井さんの訂正を捨ててはいけない。
  const editedProposal = cached?.edited ? cached.proposal : null;

  // b. 関連メモ（補強・失敗しても続行）
  const memos = await fetchRelatedMemos(supabaseUrl, anonKey, organization);

  // c. Claude で提案生成（structured outputs + adaptive thinking）
  const client = new Anthropic({ apiKey: anthropicKey });

  let proposal: Proposal;
  try {
    // adaptive thinking で過去成果物・会議履歴を分析させてから構造化出力するため、
    // 1回の生成で全フィールドが埋まる想定（従来の空配列問題への対処）。
    proposal = await generateProposal(
      client,
      organization,
      meetings,
      memos,
      deliverables,
      commonDocs,
      editedProposal,
      metrics
    );
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

  // 完全な結果のときだけ永続キャッシュに保存する（空をキャッシュして固定化しないため）。
  // 同一自治体の次回表示は Claude を呼ばず即返す。
  if (isComplete(proposal)) {
    await saveProposalCache(supabaseUrl, anonKey, {
      organization,
      signature,
      proposal,
      meetings,
      model: MODEL,
      // 手直しを土台に再生成した場合は訂正が引き継がれているので、印を保つ。
      // ここを落とすと次の再生成で訂正が消える。
      edited: !!editedProposal,
    });
  }

  return NextResponse.json({
    organization,
    meetings,
    proposal,
    deliverablesCount: deliverables.length,
    commonDocsCount: commonDocs.length,
    cached: false,
    edited: !!editedProposal,
  });
}
