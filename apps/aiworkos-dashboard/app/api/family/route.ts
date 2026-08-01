import { NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// ファミリー（ライフOS側）：1行＝1つのお出かけ family_logs を読む。
// ラーメンと同じく anonキーで PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "family_logs";

const COLUMNS = [
  "id",
  "happened_on",
  "title",
  "place",
  "place_kind",
  "area",
  "members",
  "memo",
  "highlight",
  "stars",
  "cost",
  "photo_paths",
  "photo_count",
].join(",");

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=${COLUMNS}&order=happened_on.desc,id.desc`,
    { headers: restHeaders(c.key), cache: "no-store" }
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
