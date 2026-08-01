import { NextResponse } from "next/server";

// ラーメン（ライフOS側）：1行＝1杯（1訪問）の記録 ramen_logs を読む。
// 食べログ（mirainotakara）の口コミと X（@0kara1_man）の投稿を同じ行に束ねてあり、
// 「食べた → 食べログに書いた → Xに出した」までを1本の線で追える。
// 日報録・週報と同じく anonキーで Supabase PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "ramen_logs";

const COLUMNS = [
  "id",
  "eaten_on",
  "bowl_no",
  "bowl_label",
  "shop",
  "area",
  "genre",
  "visit_count",
  "menu",
  "price",
  "score",
  "score_time",
  "score_food",
  "score_service",
  "score_mood",
  "score_cp",
  "title",
  "excerpt",
  "photo_count",
  "tabelog_url",
  "tabelog_shop_url",
  "x_url",
  "x_posted_on",
  "x_excerpt",
  "is_ramen",
  "note",
  "stars",
  "status",
  "memo",
  "draft_tabelog",
  "draft_x",
  "photo_urls",
].join(",");

function creds() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

export async function GET() {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=${COLUMNS}&order=eaten_on.desc,bowl_no.desc,id.desc`,
    {
      headers: {
        apikey: c.anon,
        Authorization: `Bearer ${c.anon}`,
        "Content-Type": "application/json",
      },
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
  return NextResponse.json({ items });
}
