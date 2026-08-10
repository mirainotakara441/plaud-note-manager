import { NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// SALT2 AIサマーブートキャンプ Slack「#0404_お役立ち情報」ダイジェスト（/bootcamp/tips）の読み取りAPI。
//
// salt2_qa_log は毎日21:30 JSTに自動同期される側と分業していて、
// ここは読み取り専用（POSTは持たない）。件数は現状5件と小さいので、
// 全件を1回で返してソートはクエリ側（posted_at.asc）で済ませる。
//
// channel_name の値（0404_お役立ち情報）は日本語＋アンダースコアを含むため、
// URLSearchParams でエンコードしてから組み立てる（手でテンプレートに埋めると
// 日本語部分が壊れたクエリになる）。
//
// salt2_qa_log は RLS で anon に SELECT を許可している前提（未適用ならAPIは空/エラーになる）。

export const dynamic = "force-dynamic";

const CHANNEL_NAME = "0404_お役立ち情報";

const COLUMNS = ["message_ts", "text", "permalink", "posted_at"].join(",");

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const params = new URLSearchParams({
    select: COLUMNS,
    channel_name: `eq.${CHANNEL_NAME}`,
    order: "posted_at.asc",
  });

  try {
    const res = await fetch(`${c.url}/rest/v1/salt2_qa_log?${params.toString()}`, {
      headers: restHeaders(c.key),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`お役立ち情報の取得に失敗しました（${res.status}）${detail.slice(0, 120)}`);
    }
    const tips = await res.json();
    return NextResponse.json({ tips });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}
