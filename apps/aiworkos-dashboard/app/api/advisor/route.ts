import { NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";
import { runAdvisor } from "@/lib/advisor";
import { jstToday } from "@/lib/advisor/types";

// ホームの「今朝の気づき」の中身。
//
// 読み取り専用。参謀は気づいたことを言うだけで、何も直さない・何も消さない
// （何を直すかは吉井さんが決める。勝手に直すと、直したこと自体に気づけない）。
//
// health_metrics など authenticated 限定のテーブルを読むため service role で動く。
// このファイルはサーバー側でのみ実行される（キーはブラウザに出ない）。

export const dynamic = "force-dynamic";

export async function GET() {
  const creds = serviceCreds();
  if (!creds) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const now = new Date();
  try {
    const result = await runAdvisor({ creds, today: jstToday(now), now });
    return NextResponse.json(result);
  } catch (err) {
    // runAdvisor は検知器ごとの失敗を握るので、ここに来るのは想定外の事故だけ。
    console.error("advisor: 実行に失敗", err);
    return NextResponse.json({ error: "気づきの取得に失敗しました" }, { status: 502 });
  }
}
