import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { serviceCreds, anonCreds, restHeaders } from "@/lib/supabase";
import { captureAuthorized, draftPrompt, parseDraft, type RamenRow } from "@/lib/ramen";

// 起票済みの一杯から、食べログ用とX用の文章を1本ずつ生成する。
// 文体は lib/ramen.ts の型 ＋ 直近の投稿済み3件を実例として渡して寄せる
// （文体の説明だけでは「AIが書いた食レポ」になるため、実物を見せるほうが効く）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-5";

const SELECT =
  "id,eaten_on,bowl_no,bowl_label,shop,area,genre,visit_count,menu,price,score,score_time,title,excerpt,memo,status,draft_tabelog,draft_x,is_ramen";

export async function POST(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY が未設定です" }, { status: 500 });
  }
  const svc = serviceCreds();
  const anon = anonCreds();
  if (!svc || !anon) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  }

  let id: number | null = null;
  try {
    const body = await req.json();
    id = typeof body?.id === "number" ? body.id : parseInt(String(body?.id), 10);
  } catch {
    /* 下で弾く */
  }
  if (!id || !Number.isFinite(id)) {
    return NextResponse.json({ error: "対象のidが必要です" }, { status: 400 });
  }

  // 対象の一杯と、文体の見本になる直近の投稿済みを同時に取る。
  const [targetRes, sampleRes] = await Promise.all([
    fetch(`${anon.url}/rest/v1/ramen_logs?select=${SELECT}&id=eq.${id}`, {
      headers: restHeaders(anon.key),
      cache: "no-store",
    }),
    fetch(
      `${anon.url}/rest/v1/ramen_logs?select=${SELECT}&status=eq.posted&is_ramen=is.true&order=eaten_on.desc&limit=3`,
      { headers: restHeaders(anon.key), cache: "no-store" }
    ),
  ]);

  if (!targetRes.ok) {
    return NextResponse.json({ error: `対象の取得に失敗（${targetRes.status}）` }, { status: 502 });
  }
  const targets = (await targetRes.json()) as RamenRow[];
  const target = targets[0];
  if (!target) {
    return NextResponse.json({ error: "対象の記録が見つかりません" }, { status: 404 });
  }
  const samples = sampleRes.ok ? ((await sampleRes.json()) as RamenRow[]) : [];

  const client = new Anthropic({ apiKey });
  let text = "";
  try {
    const msg = await client.messages.create({
      model: MODEL,
      // 食べログ本文とX本文の2本立てなので2000だと途中で切れ、
      // 区切り行の ===X=== に届かないまま止まることがある（2026-08-01）。
      max_tokens: 4000,
      messages: [{ role: "user", content: draftPrompt(target, samples) }],
    });
    text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
  } catch (e) {
    console.error("ラーメン下書き生成エラー:", e);
    return NextResponse.json({ error: "文章の生成に失敗しました" }, { status: 502 });
  }

  const draft = parseDraft(text);
  if (!draft) {
    // 何が返ってきたか分からないと直しようがないので、末尾だけログに残す。
    console.error("下書きの読み取り失敗。生成文の長さ:", text.length, "末尾:", text.slice(-200));
    return NextResponse.json(
      { error: "生成結果を読み取れませんでした。もう一度お試しください。", chars: text.length },
      { status: 502 }
    );
  }

  const patch = {
    title: draft.title || target.title,
    // 食べログ本文が生成されなかった一杯（既に書き終えているもの）は既存を残す。
    draft_tabelog: draft.tabelog ?? target.draft_tabelog ?? target.excerpt,
    draft_x: draft.x,
    drafted_at: new Date().toISOString(),
    status: "drafted",
    updated_at: new Date().toISOString(),
  };

  const upd = await fetch(`${svc.url}/rest/v1/ramen_logs?id=eq.${id}`, {
    method: "PATCH",
    headers: restHeaders(svc.key, { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });

  if (!upd.ok) {
    const detail = await upd.text().catch(() => "");
    console.error("下書き保存失敗:", upd.status, detail);
    // 生成自体は成功しているので、保存に失敗しても本文は返す（画面で拾えるように）。
    return NextResponse.json(
      { error: "下書きの保存に失敗しました", draft },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, id, draft });
}
