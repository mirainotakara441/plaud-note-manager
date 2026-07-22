import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 取込ジョブのキュー。フロントの EIGHT/PLAUD ボタンから起票(POST)し、一覧(GET)する。
// 実行はワーカー(クラウドエージェント/Claude)が queued を拾って行い status を更新する（A2）。
// web app は anon キーで PostgREST 経由に insert/select する（RLSで anon に許可済み）。

// slides: /weapons で作ったスライド構成案の .pptx 清書。本物テンプレートと slide-architect が
// 吉井さんの Mac にしかないため、Vercel では実行できず eight/plaud と同じ起票方式に乗せる。
// proposal: /weapons で作った提案書（資料集）をNotionページとして起票する。
const KINDS = ["eight", "plaud", "slides", "proposal"] as const;
type Kind = (typeof KINDS)[number];

function rest(supabaseUrl: string) {
  return `${supabaseUrl}/rest/v1/integration_jobs`;
}

export async function GET() {
  const c = anonCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }
  try {
    const res = await fetch(
      `${rest(c.url)}?select=id,kind,status,result,error,created_at,updated_at&order=created_at.desc&limit=20`,
      {
        headers: restHeaders(c.key),
        cache: "no-store",
      }
    );
    if (!res.ok) return NextResponse.json({ jobs: [] });
    const jobs = await res.json();
    return NextResponse.json({ jobs: Array.isArray(jobs) ? jobs : [] });
  } catch {
    return NextResponse.json({ jobs: [] });
  }
}

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  let body: { kind?: unknown; params?: unknown };
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
  const params =
    body.params && typeof body.params === "object" ? body.params : {};

  try {
    const res = await fetch(rest(c.url), {
      method: "POST",
      headers: restHeaders(c.key, { Prefer: "return=representation" }),
      body: JSON.stringify({ kind, params }),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "ジョブの登録に失敗しました" },
        { status: 502 }
      );
    }
    const rows = await res.json();
    const job = Array.isArray(rows) ? rows[0] : rows;
    return NextResponse.json({ job });
  } catch {
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
  }
}
