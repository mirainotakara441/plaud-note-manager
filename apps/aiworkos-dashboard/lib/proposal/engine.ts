// 提案エージェントの生成エンジン。
//
// ■ なぜ route.ts から切り出したか（2026-09-12）
//   夜間の自動仕込み（/api/agent/refresh）が同じ生成ロジックを使うため。
//   ルート同士のHTTP呼び出しは作らない方針（依存が「言い分の一致」でしか保てず
//   静かにズレる）なので、共有はこの1本のモジュールで行う。
//   中身は app/api/agent/route.ts から挙動を変えずに移設したもの。
//
// ■ 2つの生成モード
//   generateProposal()     … 従来どおり。固定で引いた材料から1回で組む（60秒に収まる）
//   generateProposalDeep() … tool use 版。先にAIが search-memory / org-history /
//                            weekly_reports を自分で引いて調査メモを作り、
//                            それを追加材料にして提案を組む（2〜4分かかる。
//                            60秒制限のある Vercel 上では使わず、夜間とローカル用）

import {
  DEFAULT_MODEL,
  structured,
  toolLoop,
  retryOnceOnTransient,
} from "@/lib/llm";
import { COMMON_ORG, fetchLatestMetrics } from "@/lib/metrics";
import { proposalSignature } from "@/lib/cacheSignature.mjs";
import { parseSegmentTarget } from "@/lib/categories";
import { buildAskTools } from "@/lib/ask/tools";
import type { Creds } from "@/lib/supabase";

export type Meeting = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  organization: string | null;
};

export type MemoResult = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
};

export type Proposal = {
  summary: string;
  issues: string[];
  actions: { title: string; detail: string }[];
  materialOutline: string[];
};

// claude-sonnet-5: 入力 $3/MTok（〜2026-08-31 は導入価格 $2）、出力 $15/MTok（同 $10）。
// system＋tools は毎回同一なので cache_control を付けて prefix キャッシュ対象にする。
// モデル名と cache_control は lib/llm.ts に集約（DEFAULT_MODEL / structured() の cache 既定 true）。
const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
自治体（地方公共団体）・議員への営業・提案戦略を立案します。対象は特定の団体のこともあれば、「政令市」「国会議員」のような区分全体（セグメント）への汎用的な訴求のこともあります。

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

export async function fetchOrgHistory(
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

export async function fetchRelatedMemos(
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
  } catch (err) {
    // 補強用なので失敗しても致命的ではない
    console.error("fetchRelatedMemos: search-memory呼び出し失敗", err);
    return [];
  }
}

// 過去成果物（source_type:成果物）を organization で絞って取得。提案のベースとして使う。
// organization フィルタで RPC が対象団体の行のみを返す。
// 検索クエリは絞込先ではなく「提案対象の団体」で作る（共通資料を引くときも、その団体に
// 関連の深い型・戦略が上位に来るようにするため）。
export async function fetchDeliverables(
  supabaseUrl: string,
  anonKey: string,
  targetOrg: string,
  filterOrg: string, // 空文字なら団体で絞らない（セグメント向けの横断検索）
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
        ...(filterOrg ? { organization: filterOrg } : {}),
        match_count: matchCount,
      }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? (data.results as MemoResult[]) : [];
  } catch (err) {
    console.error("fetchDeliverables: search-memory呼び出し失敗", err);
    return [];
  }
}

// 会議＋過去成果物の決定的署名。いずれかが変われば（＝新しい成果物を登録した等）
// キャッシュが無効化され、提案が再生成される。
// 実装は lib/cacheSignature.mjs 1本だけ。ここには書き写さない。
export const computeSignature = proposalSignature;

// proposal-cache Edge Function から取得。失敗しても null を返し生成にフォールバック。
export async function fetchProposalCache(
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
  } catch (err) {
    console.error("fetchProposalCache: proposal-cache呼び出し失敗", err);
    return null;
  }
}

// proposal-cache Edge Function へ保存。失敗は握りつぶす（保存できなくても返却は続行）。
export async function saveProposalCache(
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
  } catch (err) {
    // キャッシュ保存失敗は致命的でない
    console.error("saveProposalCache: proposal-cache保存失敗", err);
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
  metrics: MemoResult | null,
  researchMemo: string | null
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

  // deep モードのときだけ入る。AIが自分で調べた補強材料。
  const researchText = researchMemo
    ? `
以下は、この提案のためにAIが記憶層を追加調査した結果のメモです。固定取得の資料に
無い文脈（直近の週報の動き・未解決の宿題・他団体の前例・過去に空振りした打ち手）を
補うものとして使ってください。事実の優先度は 手直し版 > 実績サマリ > 会議履歴 >
このメモ の順（メモは二次的な整理であり、原典と食い違えば原典が正）。
==== 追加調査メモ ====
${researchMemo}
`
    : "";

  // セグメントは「相手が決まっていない」のではなく「特定しないのが狙い」。
  // 明示しないと、最初の出力が「どの自治体ですか」の確認で埋まる。
  const seg = parseSegmentTarget(organization);
  const targetLine = seg
    ? `対象: ${organization}（特定の団体ではなく「${organization}」という区分全体への汎用的な訴求。個別の団体名を特定せず、${organization}に共通する構造・決裁の通り方・響く論点を扱うこと。${seg === "議員" ? "相手は行政職員ではなく議員。議会質問・政策実績・地元へのメリットという議員の関心軸で組み立てること。" : ""}）`
    : `対象自治体: ${organization}`;

  return `${targetLine}
${metricsText}${editedText}${researchText}
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
export function isComplete(p: Proposal): boolean {
  return (
    !!p.summary &&
    p.issues.length > 0 &&
    p.actions.length > 0 &&
    p.materialOutline.length > 0
  );
}

function toProposal(input: Partial<Proposal>): Proposal {
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

// Claude で1回生成し Proposal を組み立てる。
// structured outputs（output_config.format）で JSON 形状を保証しつつ、
// adaptive thinking で会議履歴を分析させてから全フィールドを埋めさせる。
export async function generateProposal(
  organization: string,
  meetings: Meeting[],
  memos: MemoResult[],
  deliverables: MemoResult[],
  commonDocs: MemoResult[],
  editedProposal: Proposal | null,
  metrics: MemoResult | null
): Promise<Proposal> {
  const input = await structured<Partial<Proposal>>({
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(
      organization,
      meetings,
      memos,
      deliverables,
      commonDocs,
      editedProposal,
      metrics,
      null
    ),
    schema: PROPOSAL_SCHEMA,
    // thinking + 4フィールドの構造化出力を収めるため 16000 に引き上げ。
    maxTokens: 16000,
    label: "提案生成",
  });
  return toProposal(input);
}

// ---- deep モード（tool use 版）----------------------------------------

const RESEARCH_SYSTEM = `あなたは吉井さん（富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者）の参謀の、調査担当です。
これから対象団体への提案を組み直します。その前に、固定で取得済みの資料に**入っていない**文脈を、道具で記憶層から掘り起こしてください。

## 必ず調べること（それぞれ1〜3回、道具を使う）
1. **直近の週報の動き** … weekly_reports をこの団体で引く。会議録より新しい事実が載っていることが多い
2. **未解決の宿題・懸念** … 会議で出た宿題（「〜までに」「確認する」）がその後どうなったか。search_memory で宿題の中身を引き直す
3. **似た構造の他団体の前例** … この団体と同じ壁（決裁レイヤー・条例・費用対効果など）を越えた/越えられなかった他団体の記録。search_memory で壁の名前で引く
4. **過去に空振りした打ち手** … 同じ打ち手を二度提案しないため。この団体・類似団体で「進まなかった」「保留」「見送り」の記録

## 出力（調査メモ）
見出し4つ（上の1〜4）でまとめる。各項目に出典（[種類 日付 タイトル]）を付ける。
見つからなかった項目は「記録なし」と書く（それも重要な情報）。
自分の意見・提案は書かない。ここは材料集めであり、提案は次の工程が作る。
分量は全体で1500字以内。関西弁ではなく通常のビジネス日本語で。`;

/**
 * tool use で追加調査してから提案を組む。
 *
 * ★60秒制限のある場所（Vercel）では呼ばないこと★
 * 実測で調査に1〜2分＋生成に1〜2分かかる。夜間の自動仕込み（/api/agent/refresh）と
 * ローカルでの手動実行が使い口。昼の /agent はキャッシュを即返しするだけなので、
 * 夜に仕込んでおけば昼の体感は変わらず中身だけ深くなる。
 */
export async function generateProposalDeep(
  creds: Creds,
  anonKey: string,
  organization: string,
  meetings: Meeting[],
  memos: MemoResult[],
  deliverables: MemoResult[],
  commonDocs: MemoResult[],
  editedProposal: Proposal | null,
  metrics: MemoResult | null
): Promise<{ proposal: Proposal; researchMemo: string; researchSteps: number }> {
  // 調査担当に渡すのは「何を持っているか」の目録。全文は渡さない——
  // 調査の目的は固定材料の外を探すことであって、固定材料の再読ではない。
  const meetingDigest =
    meetings.length > 0
      ? meetings
          .slice(-10)
          .map((m) => `- ${formatDate(m.event_date)} ${m.title}`)
          .join("\n")
      : "（会議履歴なし）";
  const deliverableDigest =
    deliverables.length > 0
      ? deliverables.map((d) => `- ${d.title}`).join("\n")
      : "（過去成果物なし）";

  const { text: researchMemo, steps } = await toolLoop({
    system: RESEARCH_SYSTEM,
    prompt: `対象団体: ${organization}

手元にある固定材料の目録（これらの中身は次の工程が読む。あなたはこの外を探す）:
==== 会議履歴（直近10件の見出し）====
${meetingDigest}
==== 過去成果物（見出し）====
${deliverableDigest}
${editedProposal ? "\n※前回の提案には吉井さんの手直しが入っている。打ち手の重複調査（4）を特に丁寧に。" : ""}

上の「必ず調べること」1〜4を道具で調べ、調査メモを出してください。`,
    tools: buildAskTools(creds, anonKey),
    maxSteps: 6,
    maxTokens: 8000,
    label: `提案調査(${organization})`,
  });

  // 生成側も再試行付き。調査（toolLoop側で再試行済み）が成功したのに、
  // 最後の生成が接続断1回で落ちると、調査ぶんが丸ごと無駄になるため。
  const input = await retryOnceOnTransient(
    () =>
      structured<Partial<Proposal>>({
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(
          organization,
          meetings,
          memos,
          deliverables,
          commonDocs,
          editedProposal,
          metrics,
          researchMemo
        ),
        schema: PROPOSAL_SCHEMA,
        maxTokens: 16000,
        label: `提案生成deep(${organization})`,
      }),
    `提案生成deep(${organization})`
  );

  return { proposal: toProposal(input), researchMemo, researchSteps: steps.length };
}

/**
 * 1団体ぶんの deep 生成を、材料集めからキャッシュ保存まで通しで行う。
 *
 * /api/agent の mode:"deep" と、夜間の自動仕込み /api/agent/refresh の両方がこれを呼ぶ。
 * 編成をここ1箇所に置くのは「同じ規則を2箇所に書かない」ため——署名の計算や
 * 手直し版の引き継ぎが片方だけ変わると、昼と夜で違う提案の作り方になる。
 */
export async function runDeepForOrg(
  creds: Creds,
  anonKey: string,
  organization: string
): Promise<{
  organization: string;
  meetings: Meeting[];
  proposal: Proposal;
  deliverablesCount: number;
  commonDocsCount: number;
  edited: boolean;
  researchSteps: number;
}> {
  const supabaseUrl = creds.url;
  const segment = parseSegmentTarget(organization);

  let meetings: Meeting[] = [];
  if (!segment) {
    meetings = await fetchOrgHistory(supabaseUrl, anonKey, organization);
  }

  const [deliverables, commonDocs, metrics] = await Promise.all([
    segment
      ? fetchDeliverables(supabaseUrl, anonKey, `${organization} ${segment}`, "", 40)
      : fetchDeliverables(supabaseUrl, anonKey, organization, organization, 40),
    organization === COMMON_ORG
      ? Promise.resolve<MemoResult[]>([])
      : fetchDeliverables(supabaseUrl, anonKey, organization, COMMON_ORG, 20),
    fetchLatestMetrics<MemoResult>(supabaseUrl, anonKey),
  ]);

  const signature = computeSignature(meetings, deliverables, commonDocs);
  const cached = await fetchProposalCache(supabaseUrl, anonKey, organization);
  const editedProposal = cached?.edited ? cached.proposal : null;
  const memos = await fetchRelatedMemos(supabaseUrl, anonKey, organization);

  const { proposal, researchSteps } = await generateProposalDeep(
    creds,
    anonKey,
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

  if (isComplete(proposal)) {
    await saveProposalCache(supabaseUrl, anonKey, {
      organization,
      signature,
      proposal,
      meetings,
      // deep で作った版は model に印を残す（後から「深い版がどれだけあるか」を数える）。
      model: `${DEFAULT_MODEL}+deep`,
      // 手直しを土台に再生成した場合は訂正が引き継がれているので、印を保つ。
      edited: !!editedProposal,
    });
  }

  return {
    organization,
    meetings,
    proposal,
    deliverablesCount: deliverables.length,
    commonDocsCount: commonDocs.length,
    edited: !!editedProposal,
    researchSteps,
  };
}

// COMMON_ORG / fetchLatestMetrics は lib/metrics.ts が正。ルート側の import を減らすため再輸出。
export { COMMON_ORG, fetchLatestMetrics, parseSegmentTarget };
