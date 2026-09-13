import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, anonCreds, restHeaders } from "@/lib/supabase";
import {
  toolLoop,
  isLlmConfigured,
  llmErrorMessage,
  llmErrorStatus,
  DEFAULT_MODEL,
} from "@/lib/llm";
import { buildAskTools } from "@/lib/ask/tools";

// /ask 相談窓口。難しい問いを投げると、AIが記憶層を自分で何度も引きながら
// 根拠つきで統合回答する。
//
// ■ なぜ /search と別か
//   /search は生チャンクを並べるだけで、統合も要約もしない（それはそれで
//   「原文を見る」用途として正しい）。相談窓口は逆で、複数回の検索を重ねて
//   1本の答えにする。2026-09-12 の総点検で「目標(3) 難しい問いへの回答を
//   担う機能が現状ゼロ」と特定された、その穴を埋める口。
//
// ■ AIワークOS初の tool use
//   資料の決め打ち渡し（/agent の match_count:40 等）と違い、ここではAIが
//   問いに応じて search_memory / org_history / weekly_reports を自分で呼ぶ。
//   欠損(b)「自分で探す手が無い」の最初の実装。うまく回れば /agent のツール化
//   （Phase 2 本丸）へ同じ型を持ち込む。
//
// ■ 答えは ask_log に残す
//   総点検の指摘(F)「出したものの半分は流れて消える」を繰り返さない。
//   問い・答え・何をどう調べたか（足あと）・役に立ったかを1行で残す。
//   溜まった問いは「吉井さんが何に悩んでいるか」の一次資料でもある
//   （夜間参謀の材料に将来加える前提で、最初から構造化して置く）。

export const dynamic = "force-dynamic";
// ツールを2〜4回引いてから統合するので60秒では収まらないことがある。
// ローカル実行なら上限は効かない。Vercel Hobby では実効上限に切られる可能性が
// あるため、切れる場合は「調べる回数を減らす」のではなくローカルで使うこと
// （夜間参謀と同じ判断。思考を削って収めるのは本末転倒）。
export const maxDuration = 300;

const TABLE = "ask_log";

type AskRow = {
  id: string;
  question: string;
  answer: string;
  sources: unknown;
  steps: unknown;
  rating: string | null;
  model: string | null;
  ms: number | null;
  created_at: string;
};

const SYSTEM = `あなたは富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんの参謀です。
吉井さんの難しい問いに、本人の記憶層（日記・会議録・成果物・週報・学び）を自分で検索しながら答えます。

## 調べ方
- まず問いを分解し、必要な材料を道具で取りにいく。1回で足りなければ言い換えて引き直す。
  団体の経緯を追うなら org_history、直近の動きと数字なら weekly_reports、
  それ以外の論点・人物・過去の考えは search_memory。
- 検索で出てきた人名・団体名・論点は、次の検索の手がかりにする（多段で辿る）。
- 3〜5回引いても核心が出ないときは、無いことを前提に答える。それ以上の空振りは時間の無駄。

## 答え方
- **結論から書く。** 問いに正面から答えてから、根拠と補足を続ける。
- **記憶にある事実と、あなたの推論を分けて書く。** 事実には出どころ（[会議 8/27] のような形）を
  文中に付ける。推論は「ここからは推測ですが」と明示する。
- 固有名詞と数字はそのまま使う。丸めない。
- 記憶に無いことは無いと言う。作らない。検索したが見つからなかった場合は
  「記録には見当たりません」と書き、何をどう検索したかを1行添える。
- 実績数値が問いに関わる場合、資料ごとに数字が食い違うことがある。
  その場合は新しい日付の会議・週報を優先し、食い違いがあること自体も書く。
- 長さは問いに合わせる。単純な確認なら3行、判断を要する問いなら根拠を並べて数段落。
- 関西弁ではなく、通常の丁寧なビジネス日本語で書く。

## 最後に必ず
答えの末尾に「---」を1行置き、その下に使った主な根拠を箇条書きで並べる
（形式: - [種類] 日付 タイトル）。根拠が無い答えのときは「- 根拠となる記録なし（推論のみ）」と書く。`;

async function authorizedByCookie(req: NextRequest): Promise<boolean> {
  // proxy.ts が合言葉を通した後のリクエストしか届かないパスなので、
  // ここでの再照合は不要（PUBLIC_PATHS に載せていない）。
  // ただし将来 PUBLIC_PATHS に載せる変更をしたとき静かに素通りにならないよう、
  // cookie の存在だけは見る。
  return !!req.cookies.get("aiworkos_auth")?.value;
}

export async function POST(req: NextRequest) {
  if (!(await authorizedByCookie(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }
  const c = serviceCreds();
  const anon = anonCreds();
  if (!c || !anon) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "問いを入力してください" }, { status: 400 });
  }
  if (question.length > 2000) {
    return NextResponse.json({ error: "問いが長すぎます（2000字まで）" }, { status: 400 });
  }

  const startedAt = Date.now();
  try {
    const { text, steps } = await toolLoop({
      system: SYSTEM,
      prompt: question,
      tools: buildAskTools(c, anon.key),
      maxSteps: 6,
      maxTokens: 12000,
      label: "相談窓口",
    });

    const ms = Date.now() - startedAt;

    // 「--- 以下の根拠」を sources として構造化しておく（画面でチップ表示する用）。
    const tail = text.split(/\n---\n/).at(-1) ?? "";
    const sources = tail
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2))
      .slice(0, 12);

    // 保存の失敗で答えを失わない。ログはあくまで副産物。
    let saved: string | null = null;
    try {
      const ins = await fetch(`${c.url}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: restHeaders(c.key, { Prefer: "return=representation" }),
        body: JSON.stringify({
          question,
          answer: text,
          sources,
          steps: steps.map((s) => ({
            tool: s.tool,
            input: s.input,
            resultChars: s.resultChars,
            ms: s.ms,
          })),
          model: DEFAULT_MODEL,
          ms,
        }),
      });
      if (ins.ok) {
        const rows = (await ins.json()) as { id: string }[];
        saved = rows[0]?.id ?? null;
      } else {
        console.error("相談窓口: ask_log保存失敗", ins.status, await ins.text().catch(() => ""));
      }
    } catch (err) {
      console.error("相談窓口: ask_log保存失敗", err);
    }

    return NextResponse.json({
      id: saved,
      answer: text,
      sources,
      steps: steps.map((s) => ({ tool: s.tool, input: s.input, ms: s.ms })),
      model: DEFAULT_MODEL,
      ms,
    });
  } catch (err) {
    console.error("相談窓口:", err);
    return NextResponse.json(
      { error: llmErrorMessage(err, "回答の生成に失敗しました。もう一度お試しください。") },
      { status: llmErrorStatus(err) }
    );
  }
}

// 過去の相談を新しい順に返す。読み取り専用。
export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  try {
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=id,question,answer,sources,rating,model,ms,created_at` +
        `&order=created_at.desc&limit=20`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      // テーブル未作成の環境では静かに空（ページは新規の問いだけ受け付ける）。
      return NextResponse.json({ logs: [], available: false });
    }
    const logs = (await res.json()) as AskRow[];
    return NextResponse.json({ logs, available: true });
  } catch {
    return NextResponse.json({ logs: [], available: false });
  }
}

// 役に立ったかの1タップ記録。夜間参謀の verdict と同じ思想で、
// これが無いと「相談窓口は使われているが役に立っているのか」を後から測れない。
export async function PATCH(req: NextRequest) {
  if (!(await authorizedByCookie(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id : "";
  const rating = body?.rating;
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  if (rating !== null && !["helpful", "off"].includes(rating)) {
    return NextResponse.json({ error: "ratingが不正です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=minimal" }),
    body: JSON.stringify({ rating }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: `保存に失敗しました（${res.status}）` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
