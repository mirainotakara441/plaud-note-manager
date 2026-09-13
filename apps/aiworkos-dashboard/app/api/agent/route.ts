import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_MODEL,
  llmErrorMessage,
  llmErrorStatus,
  isLlmConfigured,
} from "@/lib/llm";
import { serviceCreds } from "@/lib/supabase";
import {
  type Meeting,
  type MemoResult,
  type Proposal,
  COMMON_ORG,
  fetchLatestMetrics,
  parseSegmentTarget,
  fetchOrgHistory,
  fetchRelatedMemos,
  fetchDeliverables,
  fetchProposalCache,
  saveProposalCache,
  computeSignature,
  generateProposal,
  runDeepForOrg,
  isComplete,
} from "@/lib/proposal/engine";

// 提案エージェントの入口。生成ロジックの本体は lib/proposal/engine.ts
// （2026-09-12 に夜間の自動仕込み /api/agent/refresh と共有するため移設。挙動は不変）。
//
// thinking を有効化すると生成に時間がかかるため、Vercel の関数タイムアウトを引き上げる
// （Hobby プランの上限。org-history/search-memory/Claude 生成を合算しても収まる想定）。
// ★mode:"deep"（tool use で追加調査してから組む）は2〜4分かかるので、この上限がある
//   Vercel 上では使わないこと。夜間の自動仕込みとローカル実行が使い口。
export const maxDuration = 60;

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
  } catch (err) {
    console.error("PUT /api/agent: リクエストJSON解析失敗", err);
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
  } catch (err) {
    console.error("PUT /api/agent: proposal-cache保存失敗", err);
    return NextResponse.json({ error: "手直しの保存に失敗しました" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  if (!isLlmConfigured()) {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。",
      },
      { status: 500 }
    );
  }

  let body: { organization?: unknown; force?: unknown; mode?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/agent: リクエストJSON解析失敗", err);
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

  // deep = tool use で追加調査してから組む。常に再生成（キャッシュ照合を飛ばす）。
  // 編成は engine.runDeepForOrg に一本化（夜間の /api/agent/refresh と共有）。
  if (body.mode === "deep") {
    const creds = serviceCreds();
    if (!creds) {
      return NextResponse.json({ error: "Supabase未設定（service role）" }, { status: 500 });
    }
    try {
      const r = await runDeepForOrg(creds, anonKey, organization);
      return NextResponse.json({ ...r, cached: false, deep: true });
    } catch (error) {
      console.error("提案生成(deep)エラー:", error);
      return NextResponse.json(
        { error: llmErrorMessage(error, "AIによる提案生成に失敗しました。") },
        { status: llmErrorStatus(error) }
      );
    }
  }

  // セグメント（政令市・特別区・国会議員など）＝特定の団体ではなく区分全体への訴求。
  // 団体マスタ・会議履歴に存在しない名前なので、団体前提の取得をそのまま回すと
  // 土台が空になり、AIが何も知らないまま提案を書く。取り方を変える。
  const segment = parseSegmentTarget(organization);

  // a. 会議履歴（時系列）。セグメントには「その団体の会議」が存在しないので飛ばす
  //    （org-history に存在しない名前を投げても空が返るだけだが、待ち時間が無駄）。
  let meetings: Meeting[] = [];
  if (!segment) {
    try {
      meetings = await fetchOrgHistory(supabaseUrl, anonKey, organization);
    } catch (err) {
      console.error("POST /api/agent: 会議履歴取得失敗", err);
      return NextResponse.json(
        { error: "会議履歴の取得に失敗しました。しばらくしてから再度お試しください。" },
        { status: 502 }
      );
    }
  }

  // a-2. 提案のベースとなる成果物。キャッシュ署名に含めるため、キャッシュ確認より先に取得する。
  //   - この団体向け: 取りこぼしを避けるため多め（40）に取る。
  //   - 共通資料: 全団体分の横断資料（100件超）が対象なので、類似度上位のみに絞って
  //     プロンプトの肥大を防ぐ。
  //   - セグメント: 団体タグで絞ると0件になるので、絞りを外して横断で引く。
  const [deliverables, commonDocs, metrics] = await Promise.all([
    segment
      ? fetchDeliverables(supabaseUrl, anonKey, `${organization} ${segment}`, "", 40)
      : fetchDeliverables(supabaseUrl, anonKey, organization, organization, 40),
    organization === COMMON_ORG
      ? Promise.resolve<MemoResult[]>([])
      : fetchDeliverables(supabaseUrl, anonKey, organization, COMMON_ORG, 20),
    fetchLatestMetrics<MemoResult>(supabaseUrl, anonKey),
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
  let proposal: Proposal;
  try {
    proposal = await generateProposal(
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
    console.error("提案生成エラー:", error);
    return NextResponse.json(
      { error: llmErrorMessage(error, "AIによる提案生成に失敗しました。") },
      { status: llmErrorStatus(error) }
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
      model: DEFAULT_MODEL,
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
