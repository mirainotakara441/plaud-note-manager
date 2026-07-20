import { NextResponse } from "next/server";

// 日報録：CCDセッション横断で集約した日次の作業ログ daily_work_log を読む。
// 既存ページと同じく anonキーで Supabase PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "daily_work_log";

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

// 一覧取得（新しい日付順 → 登録順）
export async function GET() {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id,work_date,session_title,session_id,workstream,summary,deliverables,status,next_action,source,created_at&order=work_date.desc,created_at.asc`,
    { headers: headers(c.anon), cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const items = await res.json();
  return NextResponse.json({ items });
}
