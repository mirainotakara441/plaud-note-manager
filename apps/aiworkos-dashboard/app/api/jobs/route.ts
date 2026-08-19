import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

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

const JOB_SELECT = "id,kind,status,result,error,created_at,updated_at";

// ホームの取込パネルに出す履歴の期間（JSTの日付基準・今日を含めた日数）。
// 完了・エラーの古い行がいつまでも積み上がって読めなくなるため、既定は直近3日だけ。
// 「非表示にする」の実装であって行は消さない（障害調査のために履歴は残す）。
export const RECENT_DAYS = 3;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 「JSTで直近 days 日」の開始時刻をUTCのISO文字列で返す。
// サーバーがUTCで動く（Vercel）ため、素の new Date() の日付では日本時間の
// 00:00〜08:59 が前日扱いになり、境界が1日ずれる。JSTの日付を出してから
// その日の00:00(JST)をUTCへ引き直す。
function jstWindowStartIso(days: number): string {
  const [y, m, d] = toJstDateString(new Date().toISOString()).split("-").map(Number);
  // Date.UTC は d - (days - 1) が 0 以下でも月・年をまたいで正しく繰り下がる。
  const jstMidnight = Date.UTC(y, m - 1, d - (days - 1));
  return new Date(jstMidnight - JST_OFFSET_MS).toISOString();
}

async function fetchJobs(c: { url: string; key: string }, query: string) {
  const res = await fetch(`${rest(c.url)}?select=${JOB_SELECT}&${query}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

export async function GET() {
  const c = anonCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }
  const since = jstWindowStartIso(RECENT_DAYS);
  try {
    // 1本目: 直近3日分（完了・エラーも含む全ステータス）
    // 2本目: 未処理（待機中・実行中）は3日より古くても必ず出す。
    //        古い未処理が隠れるとワーカーが詰まっているのに気づけなくなるため。
    const [recent, pending] = await Promise.all([
      fetchJobs(c, `created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=50`),
      fetchJobs(c, `status=in.(queued,running)&order=created_at.desc&limit=50`),
    ]);
    if (recent === null || pending === null) {
      console.error("GET /api/jobs: 取得失敗（fetchがエラーを返しました）");
      return NextResponse.json({ error: "ジョブ一覧の取得に失敗しました" }, { status: 502 });
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of [...recent, ...pending]) {
      const id = typeof row.id === "string" ? row.id : String(row.id);
      if (!byId.has(id)) byId.set(id, row);
    }
    const jobs = [...byId.values()].sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
    );
    return NextResponse.json({ jobs, since, days: RECENT_DAYS });
  } catch (err) {
    console.error("GET /api/jobs: 取得失敗", err);
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
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
  } catch (err) {
    console.error("POST /api/jobs: リクエストJSON解析失敗", err);
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
  } catch (err) {
    console.error("POST /api/jobs: 通信エラー", err);
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
  }
}
