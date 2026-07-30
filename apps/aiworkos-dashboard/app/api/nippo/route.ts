import { NextResponse } from "next/server";

// 日報録：CCDセッション横断で集約した日次の作業ログ daily_work_log を読む。
// 既存ページと同じく anonキーで Supabase PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "daily_work_log";
const WEEKLY_TABLE = "weekly_work_minutes";

function creds() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

function headers(anon: string): Record<string, string> {
  return {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
    "Content-Type": "application/json",
  };
}

// 一覧取得（新しい日付順 → 登録順）。あわせて週次の稼働時間も返す。
// 週次は nippo-aggregate.py（launchd・1時間ごと）がセッション履歴から
// 機械的に推定して weekly_work_minutes に書いている。日報の行と対応づけずに
// 週単位で独立して数えているので、人が日報を書き直しても時間は狂わない。
export async function GET() {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const [logRes, weekRes] = await Promise.all([
    fetch(
      `${c.url}/rest/v1/${TABLE}?select=id,work_date,session_title,session_id,workstream,summary,deliverables,status,next_action,source,created_at&order=work_date.desc,created_at.asc`,
      { headers: headers(c.anon), cache: "no-store" }
    ),
    fetch(
      `${c.url}/rest/v1/${WEEKLY_TABLE}?select=week_start,minutes,sessions,active_days,by_workstream&order=week_start.desc`,
      { headers: headers(c.anon), cache: "no-store" }
    ),
  ]);

  if (!logRes.ok) {
    const detail = await logRes.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${logRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const items = await logRes.json();
  // 週次はあくまで補助表示。取れなくても日報本体は出す。
  const weeks = weekRes.ok ? await weekRes.json() : [];
  return NextResponse.json({ items, weeks });
}
