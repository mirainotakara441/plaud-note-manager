import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// ブートキャンプ学習ログ（/bootcamp）の読み書きAPI。
//
// 件数はSprint×フェーズ×論点で数十件どまりなので、全件を1回で返して
// 絞り込みと検索はブラウザ側で行う（/salt2・家庭訪問と同じ流儀）。
// 打つたびにサーバーへ問い合わせないぶん、検索語の出し入れが速い。
//
// GET  … 読み取り。bootcamp_logs は RLS で anon に SELECT を許可しているため anonCreds()
// POST … 登録。書き込みは service role でのみ行う（anonに書き込みを開けない）

export const dynamic = "force-dynamic";

const COLUMNS = [
  "id",
  "sprint",
  "phase",
  "topic",
  "source_content",
  "source_url",
  "notes",
  // 壁打ちで決めたことと、その理由
  "decisions",
  // 新規事業への応用ポイント（DB側で NOT NULL）
  "business_application",
  // qa-thinkingスキルのセッション内容。クイズ生成の第一候補の材料
  "qa_session",
  "quiz",
  "created_at",
].join(",");

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  try {
    const res = await fetch(
      `${c.url}/rest/v1/bootcamp_logs?select=${COLUMNS}&order=created_at.desc`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `学習ログの取得に失敗しました（${res.status}）${detail.slice(0, 120)}`
      );
    }
    const logs = await res.json();
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

export async function POST(req: Request) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "書き込み用の認証情報（SUPABASE_SERVICE_ROLE_KEY）が未設定です" },
      { status: 500 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSONを読めませんでした" }, { status: 400 });
  }

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  // 必須4項目。business_application を必須にしているのがこの画面の肝で、
  // 「学んだだけ」で終わらせないための歯止め（DB側もNOT NULL）。
  const sprint = str(body.sprint);
  const phase = str(body.phase);
  const topic = str(body.topic);
  const businessApplication = str(body.business_application);

  const missing: string[] = [];
  if (!sprint) missing.push("Sprint");
  if (!phase) missing.push("フェーズ");
  if (!topic) missing.push("学びのタイトル");
  if (!businessApplication) missing.push("新規事業への応用ポイント");
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `次の項目が空です：${missing.join(" / ")}` },
      { status: 400 }
    );
  }

  const nullable = (v: unknown): string | null => {
    const s = str(v);
    return s === "" ? null : s;
  };

  const row = {
    sprint,
    phase,
    topic,
    source_content: nullable(body.source_content),
    source_url: nullable(body.source_url),
    notes: nullable(body.notes),
    decisions: nullable(body.decisions),
    business_application: businessApplication,
    // qa_session はフォームからは入らない。Claude Code 側から流し込む前提なので
    // 受け取った場合だけそのまま通す（構造の検証はしない＝壊れた形は入れない運用）。
    qa_session: body.qa_session ?? null,
    quiz: null,
  };

  try {
    const res = await fetch(`${c.url}/rest/v1/bootcamp_logs`, {
      method: "POST",
      headers: restHeaders(c.key, { Prefer: "return=representation" }),
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`登録に失敗しました（${res.status}）${detail.slice(0, 160)}`);
    }
    const inserted = await res.json();
    return NextResponse.json({ log: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "登録に失敗しました" },
      { status: 502 }
    );
  }
}
