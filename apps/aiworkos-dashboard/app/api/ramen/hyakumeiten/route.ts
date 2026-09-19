import { NextResponse } from "next/server";

// 食べログ 百名店（ラーメン）の一覧を返す。
//
// 「今後行きたい店」の台帳。行ったかどうかは /ramen 側で ramen_logs の店URLと
// 突き合わせて決める（このAPIは台帳をそのまま返すだけ）。
// /api/ramen と同じく、合言葉認証の内側から anon キーで読む。

export const dynamic = "force-dynamic";

const TABLE = "tabelog_hyakumeiten";
const DEFAULT_EDITION = "ramen_tokyo_2025";

export async function GET(req: Request) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  // 版は英小文字・数字・_ だけ許す（そのままクエリへ入るため）
  const wanted = new URL(req.url).searchParams.get("edition") ?? DEFAULT_EDITION;
  if (!/^[a-z0-9_]+$/.test(wanted)) {
    return NextResponse.json({ error: "editionの形式が不正です" }, { status: 400 });
  }

  const res = await fetch(
    `${url}/rest/v1/${TABLE}?select=id,edition,list_order,shop,station,holiday,tabelog_url,tabelog_shop_id` +
      `&edition=eq.${wanted}&order=list_order.asc`,
    {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const items = await res.json();
  return NextResponse.json({ edition: wanted, items });
}
