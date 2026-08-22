import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { isLlmConfigured, structured, text, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import { windowChunks } from "@/lib/chunks";
import {
  categoryReadAliases,
  isOrgCategory,
  ORG_CATEGORIES,
  parseCategoryWideName,
  type OrgCategory,
} from "@/lib/categories";

// 壁打ち（熟成ループ）。対象の登録内容を土台に Claude が深掘り質問 → 吉井さんが回答 →
// 内容を熟成 → 成果物として記憶層へ保存し直す。会話は refine_sessions / refine_messages に残す。

export const maxDuration = 60;

type Msg = { role: "user" | "assistant"; content: string };

// 一覧に返すセッション1件。message_count / has_deliverable は
// 「どれを整理してよいか」を画面で判断するための材料。
type SessionRow = {
  id: string;
  organization: string;
  category: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  message_count: number;
  has_deliverable: boolean;
};

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

type WeeklyRow = {
  week_start: string;
  organization: string | null;
  summary: string | null;
  insight: string | null;
  tactic: string | null;
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

出力の形式（厳守）:
- 質問は必ず「**Q1. 問いの見出し**」という行で始めること（Q2, Q3 も同様）。見出し行は ** で囲み、1行で完結させる。
- 見出しの次の行から、その問いの補足説明を書く。
- 画面はこの形式を頼りに問いを切り出し、1問ごとに入力欄を並べる。形式が崩れると吉井さんが答えにくくなる。
- 聞き方を変えて問い直す場合は「**Q3（言い換え）. …**」のようにラベルに括弧書きを添える。

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

// 埋め込みモデル gte-small は 512token 上限で、超過分は黙って切り捨てられる。
// 実測（embed に「先頭N字＋末尾に無関係な文」を投げて比較）では、日本語は約500字で頭打ちになり
// 600字目以降は埋め込みに一切影響しなかった。store-memory は `title\n\ncontent` を1本の
// 埋め込みにするため、タイトル分を差し引いて content は 400字/チャンクに刻む。
// これを怠ると、熟成した内容の大半が検索に引っかからなくなる（保存はされるが引けない）。
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

// 壁打ちの土台を集める。対象が「自治体全般」のような全般指定かどうかで集め方が変わる。
async function fetchContext(
  supabaseUrl: string,
  anonKey: string,
  organization: string
): Promise<string> {
  const wide = parseCategoryWideName(organization);
  return wide
    ? fetchCategoryContext(supabaseUrl, anonKey, wide)
    : fetchOrgContext(supabaseUrl, anonKey, organization);
}

/** セッションに紐づく持ち込み資料を土台の先頭に重ねる。今まさに見ている物なので過去の蓄積より前に置く。 */
function withBaseDoc(context: string, doc?: string | null, name?: string | null): string {
  if (!doc) return context;
  return `==== 今回持ち込んだ資料${name ? `（${name}）` : ""} ====\n${doc}\n\n${context}`;
}

// 分類全体の土台。特定の団体に絞らないので、団体タグでの検索と会議履歴は使えない。
// 代わりに週報（分類ごとの章立てがそのまま入っている唯一のテーブル）を横串で読む。
// ここを入れないと土台が空同然になり、全般の壁打ちはAIが何も知らないまま始まる。
async function fetchCategoryContext(
  supabaseUrl: string,
  anonKey: string,
  category: OrgCategory
): Promise<string> {
  const parts: string[] = [];

  // 分類を問わず横断で成果物を拾う（organization を渡さない＝団体で絞らない）
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `${category} 向けの提案 論点 打ち手 判断軸`,
        source_type: "成果物",
        match_count: 20,
      }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const rows: MemoResult[] = Array.isArray(data?.results) ? data.results : [];
      if (rows.length > 0) {
        parts.push(
          `==== 登録済みの成果物（${category}まわりを横断） ====\n` +
            rows.map((r) => `- ${r.title}: ${r.content}`).join("\n")
        );
      }
    }
  } catch (err) {
    console.error("fetchCategoryContext: 成果物検索失敗", err);
  }

  // 週報の該当カテゴリー。表記ゆれの残っている行も拾う。
  try {
    const cats = categoryReadAliases(category)
      .map((c) => `"${c}"`)
      .join(",");
    const res = await fetch(
      `${restUrl(supabaseUrl, "weekly_reports")}?select=week_start,organization,summary,insight,tactic&category=in.(${encodeURIComponent(cats)})&order=week_start.desc&limit=60`,
      { headers: restHeaders(anonKey), cache: "no-store" }
    );
    if (res.ok) {
      const rows: WeeklyRow[] = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        parts.push(
          `==== 週報（${category}） ====\n` +
            rows
              .map((r) =>
                [
                  `- ${r.week_start}週 ${r.organization ?? ""}: ${r.summary ?? ""}`,
                  r.insight ? `  気づき: ${r.insight}` : "",
                  r.tactic ? `  打ち手: ${r.tactic}` : "",
                ]
                  .filter(Boolean)
                  .join("\n")
              )
              .join("\n")
        );
      }
    }
  } catch (err) {
    // 週報が取れなくても成果物だけで壁打ちは成立する
    console.error("fetchCategoryContext: 週報取得失敗", err);
  }

  // 関連メモ（日記・学び）
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: category, match_count: 6 }),
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
  } catch (err) {
    console.error("fetchCategoryContext: 関連メモ検索失敗", err);
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : `（${category}に紐づく登録内容はまだありません）`;
}

// 特定の団体の登録内容（成果物・会議・メモ）を集めて壁打ちの土台にする。
async function fetchOrgContext(
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
  } catch (err) {
    // 土台が一部欠けても壁打ちは続行できる
    console.error("fetchContext: 成果物検索失敗", err);
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
  } catch (err) {
    // 会議が無い対象（議員・事業者など）もあるため失敗は許容
    console.error("fetchContext: org-history取得失敗", err);
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
  } catch (err) {
    // 補強用
    console.error("fetchContext: 関連メモ検索失敗", err);
  }

  return parts.length > 0 ? parts.join("\n\n") : "（この対象の登録内容はまだありません）";
}

// 「熟成して登録」済みのセッションIDを集める。
// 成果物は memory_chunks に source_id = `refine:<sessionId>:<n>` で入っており、
// このテーブルは anon に SELECT ポリシーが無いので、この参照だけ service キーを使う。
// 取り出すのは source_id だけで、本文はブラウザに一切返さない（返すのは真偽値のみ）。
async function fetchDeliverableSessionIds(
  supabaseUrl: string,
  serviceKey: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const res = await fetch(
      `${restUrl(supabaseUrl, "memory_chunks")}?select=source_id&source_id=like.${encodeURIComponent("refine:*")}&limit=2000`,
      { headers: restHeaders(serviceKey), cache: "no-store" }
    );
    if (!res.ok) return ids;
    const rows = await res.json();
    if (!Array.isArray(rows)) return ids;
    for (const row of rows) {
      const m = /^refine:([^:]+):/.exec(String(row?.source_id ?? ""));
      if (m) ids.add(m[1]);
    }
  } catch (err) {
    // 目印が出せないだけで一覧自体は使える
    console.error("fetchDeliverableSessionIds: 取得失敗", err);
  }
  return ids;
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

// 書き込み（refine_messages / refine_sessions）なので service role キーを使う。
async function saveMessage(
  supabaseUrl: string,
  serviceKey: string,
  sessionId: string,
  role: Msg["role"],
  content: string
): Promise<void> {
  await fetch(restUrl(supabaseUrl, "refine_messages"), {
    method: "POST",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ session_id: sessionId, role, content }),
    cache: "no-store",
  });
  await fetch(`${restUrl(supabaseUrl, "refine_sessions")}?id=eq.${sessionId}`, {
    method: "PATCH",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
    cache: "no-store",
  });
}

async function askClaude(
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

  // 全般指定は「相手が決まっていない」のではなく「相手を特定しないのが狙い」。
  // これを書いておかないと、AIが最初の質問で必ず「どの自治体ですか」と聞き返してくる。
  const wide = parseCategoryWideName(organization);
  const target = wide
    ? `${organization}（特定の相手ではなく、${wide}という区分全体についての壁打ちです。個別の団体名を特定しようとせず、${wide}に共通して効く論点・型・判断軸を扱ってください）`
    : organization;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `対象: ${target}

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

  // 構造化出力ではなく素の文章を返させる（画面が「**Q1. …**」の行形式を頼りに切り出す）。
  const answer = await text({
    system: SYSTEM_PROMPT,
    messages,
    maxTokens: 8000,
  });
  return answer || "（応答を生成できませんでした）";
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
    return NextResponse.json({ messages });
  }

  // クローズ済みも含めて返し、既定で隠すかどうかは画面側で切り替える。
  // 発言数は refine_messages を埋め込みcountで一緒に取る（1往復で済む）。
  const res = await fetch(
    `${restUrl(supabaseUrl, "refine_sessions")}?select=id,organization,category,title,created_at,updated_at,closed_at,refine_messages(count)&order=updated_at.desc&limit=50`,
    { headers: restHeaders(anonKey), cache: "no-store" }
  );
  const raw = res.ok ? await res.json() : [];
  if (!Array.isArray(raw)) return NextResponse.json({ sessions: [] });

  const service = serviceCreds();
  const withDeliverable = service
    ? await fetchDeliverableSessionIds(supabaseUrl, service.key)
    : new Set<string>();

  const sessions: SessionRow[] = raw.map((r) => ({
    id: r.id,
    organization: r.organization,
    category: r.category,
    title: r.title ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at ?? null,
    message_count: Number(r?.refine_messages?.[0]?.count ?? 0),
    has_deliverable: withDeliverable.has(r.id),
  }));

  return NextResponse.json({ sessions });
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

  let body: {
    action?: unknown;
    sessionId?: unknown;
    organization?: unknown;
    category?: unknown;
    theme?: unknown;
    message?: unknown;
    baseDoc?: unknown;
    baseDocName?: unknown;
  };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/refine: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const action = body.action;

  // ── 履歴の整理（クローズ／再開／削除）
  // Claudeを呼ばないので、この3つは ANTHROPIC_API_KEY の有無に関係なく動く。
  if (action === "close" || action === "reopen" || action === "delete") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
    }
    // 実在確認。存在しないIDでのDELETEはPostgRESTが黙って成功扱いにするため、先に見る。
    const sres = await fetch(
      `${restUrl(supabaseUrl, "refine_sessions")}?select=id&id=eq.${sessionId}`,
      { headers: restHeaders(anonKey), cache: "no-store" }
    );
    const srows = sres.ok ? await sres.json() : [];
    if (!Array.isArray(srows) || srows.length === 0) {
      return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
    }

    if (action === "close" || action === "reopen") {
      // クローズ＝一覧から引っ込めるだけ。会話ログも成果物もそのまま残る。
      const res = await fetch(
        `${restUrl(supabaseUrl, "refine_sessions")}?id=eq.${sessionId}`,
        {
          method: "PATCH",
          headers: restHeaders(serviceKey),
          body: JSON.stringify({
            closed_at: action === "close" ? new Date().toISOString() : null,
          }),
          cache: "no-store",
        }
      );
      if (!res.ok) {
        return NextResponse.json(
          { error: action === "close" ? "クローズに失敗しました" : "再開に失敗しました" },
          { status: 502 }
        );
      }
      return NextResponse.json({ ok: true, closed: action === "close" });
    }

    // ── 削除＝会話ログだけを消す。
    // 「熟成して登録」で memory_chunks に入った成果物には絶対に手を出さない。
    // あれは記憶層の資産で、横断検索・提案エージェント・団体別攻略のタイムラインが
    // 参照している。セッションの削除は会話ログの削除であって、成果物の削除ではない。
    // （purge-memory は呼ばない。ここに削除処理を足そうとしたら、まずこの注記を読むこと）
    const delMsgs = await fetch(
      `${restUrl(supabaseUrl, "refine_messages")}?session_id=eq.${sessionId}`,
      { method: "DELETE", headers: restHeaders(serviceKey), cache: "no-store" }
    );
    if (!delMsgs.ok) {
      return NextResponse.json({ error: "会話の削除に失敗しました" }, { status: 502 });
    }
    const delSession = await fetch(
      `${restUrl(supabaseUrl, "refine_sessions")}?id=eq.${sessionId}`,
      { method: "DELETE", headers: restHeaders(serviceKey), cache: "no-store" }
    );
    if (!delSession.ok) {
      return NextResponse.json({ error: "削除に失敗しました" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, deleted: true });
  }

  if (!isLlmConfigured()) {
    return NextResponse.json(
      { error: "ANTHROPIC_APIキーが未設定です" },
      { status: 500 }
    );
  }

  try {
    // ── 開始: セッションを作り、土台を読んで最初の深掘り質問を出す
    if (action === "start") {
      const organization =
        typeof body.organization === "string" ? body.organization.trim() : "";
      const categoryRaw = body.category;
      if (categoryRaw !== undefined && !isOrgCategory(categoryRaw)) {
        return NextResponse.json(
          { error: `カテゴリーは次から選んでください: ${ORG_CATEGORIES.join(" / ")}` },
          { status: 400 }
        );
      }
      const category: OrgCategory = isOrgCategory(categoryRaw) ? categoryRaw : "自治体";
      const theme =
        typeof body.theme === "string" && body.theme.trim()
          ? body.theme.trim()
          : null;
      if (!organization) {
        return NextResponse.json({ error: "対象を入力してください" }, { status: 400 });
      }

      // 画面から登録された「元になる資料」。ブラウザで抽出済みのテキストだけが来る
      // （ファイル本体は送らせない。Vercelの4.5MB制限に資料の実体で当たらないため）。
      const baseDoc =
        typeof body.baseDoc === "string" ? body.baseDoc.trim().slice(0, 60000) : "";
      const baseDocName =
        typeof body.baseDocName === "string" ? body.baseDocName.trim().slice(0, 200) : "";

      const created = await fetch(restUrl(supabaseUrl, "refine_sessions"), {
        method: "POST",
        headers: restHeaders(serviceKey, { Prefer: "return=representation" }),
        body: JSON.stringify({
          organization,
          category,
          theme,
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

      const base = await fetchContext(supabaseUrl, anonKey, organization);
      // 登録された資料は記憶層より前に置く。今まさに見ている物であり、
      // 過去の蓄積より優先して読ませたいため。
      const context = baseDoc
        ? `==== 今回持ち込んだ資料${baseDocName ? `（${baseDocName}）` : ""} ====\n${baseDoc}\n\n${base}`
        : base;
      const reply = await askClaude(context, [], organization, theme);
      await saveMessage(supabaseUrl, serviceKey, session.id, "assistant", reply);

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
        `${restUrl(supabaseUrl, "refine_sessions")}?select=organization,theme,base_doc,base_doc_name&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const organization = srows?.[0]?.organization;
      const theme = srows?.[0]?.theme ?? null;
      if (!organization) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }

      await saveMessage(supabaseUrl, serviceKey, sessionId, "user", message);
      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      const context = withBaseDoc(
        await fetchContext(supabaseUrl, anonKey, organization),
        srows?.[0]?.base_doc,
        srows?.[0]?.base_doc_name
      );
      const reply = await askClaude(context, history, organization, theme);
      await saveMessage(supabaseUrl, serviceKey, sessionId, "assistant", reply);

      return NextResponse.json({ messages: await loadMessages(supabaseUrl, anonKey, sessionId) });
    }

    // ── 熟成して登録: 会話を統合し、成果物として記憶層へ保存する（熟成ループを閉じる）
    if (action === "save") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "セッションIDが不正です" }, { status: 400 });
      }
      const sres = await fetch(
        `${restUrl(supabaseUrl, "refine_sessions")}?select=organization,category,base_doc,base_doc_name&id=eq.${sessionId}`,
        { headers: restHeaders(anonKey), cache: "no-store" }
      );
      const srows = sres.ok ? await sres.json() : [];
      const organization = srows?.[0]?.organization;
      const category = srows?.[0]?.category ?? "自治体";
      if (!organization) {
        return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
      }
      const wideCategory = parseCategoryWideName(organization);

      const history = await loadMessages(supabaseUrl, anonKey, sessionId);
      if (history.length === 0) {
        return NextResponse.json({ error: "壁打ちの内容がありません" }, { status: 400 });
      }
      const context = withBaseDoc(
        await fetchContext(supabaseUrl, anonKey, organization),
        srows?.[0]?.base_doc,
        srows?.[0]?.base_doc_name
      );

      const transcript = history
        .map((m) => `${m.role === "user" ? "吉井" : "参謀"}: ${m.content}`)
        .join("\n\n");

      // ここは深掘り（askClaude）と違い1回きりの呼び出しなので、
      // systemプロンプトのキャッシュは効かせない（元の形どおり cache: false）。
      // 応答が空・拒否のときは structured() が投げ、下の catch で 502 になる。
      const parsed = await structured<{ title: string; content: string }>({
        system: SYSTEM_PROMPT,
        prompt: `対象: ${organization}${wideCategory ? `（特定の相手ではなく、${wideCategory}という区分全体についての壁打ち）` : ""}

==== 既存の土台 ====
${context}

==== 壁打ちの会話 ====
${transcript}

この壁打ちで熟成した内容を、今後の提案の土台として再利用できる形にまとめてください。
会話で新たに判明した事実・判断軸・次アクションを必ず反映し、指定のJSONスキーマで返してください。`,
        schema: SYNTHESIS_SCHEMA,
        maxTokens: 8000,
        cache: false,
      });

      const today = new Date().toISOString().slice(0, 10);
      const chunks = windowChunks(parsed.content);
      if (chunks.length === 0) {
        return NextResponse.json({ error: "熟成した内容が空でした" }, { status: 502 });
      }

      // 同じセッションを再度「熟成して登録」すると、会話が伸びた分だけチャンク数が変わる。
      // 古いチャンクを先に一掃しないと、source_id のズレで前回分が孤児として残り、
      // 古い内容が検索に混ざる。
      await fetch(`${supabaseUrl}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `refine:${sessionId}` }),
        cache: "no-store",
      });

      const results = await Promise.all(
        chunks.map((chunk, i) =>
          fetch(`${supabaseUrl}/functions/v1/store-memory`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${anonKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              source_type: "成果物",
              source_id: `refine:${sessionId}:${i + 1}`,
              // 全般の壁打ちは実在の団体に紐づかない。「自治体全般」という団体が
              // あるかのように記録すると、団体別タイムラインに幽霊が1つ増える。
              organization: wideCategory ? null : organization,
              title: `${parsed.title}｜壁打ち熟成｜${today}｜${i + 1}/${chunks.length}`,
              content: chunk,
              event_date: today,
              metadata: {
                種別: "メモ",
                カテゴリ: category,
                ...(wideCategory ? { 対象範囲: organization } : {}),
                資料名: parsed.title,
                出所: "壁打ち",
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

      await fetch(`${restUrl(supabaseUrl, "refine_sessions")}?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ title: parsed.title }),
        cache: "no-store",
      });

      return NextResponse.json({ saved: true, title: parsed.title, chunks: chunks.length });
    }

    return NextResponse.json({ error: "不正なアクションです" }, { status: 400 });
  } catch (error) {
    console.error("壁打ちエラー:", error);
    return NextResponse.json(
      { error: llmErrorMessage(error, "処理に失敗しました。") },
      { status: llmErrorStatus(error) }
    );
  }
}
