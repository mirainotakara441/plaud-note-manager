import { NextResponse } from "next/server";
import { anonCreds } from "@/lib/supabase";
import { fetchAllBlockers } from "@/lib/organizations";

// 団体ごとの「詰まり」（案件が止まっている理由の5分類）を全団体ぶん返す。
// 元は organization_notes(section=課題) 本文の `【詰まり】` 行。分類の定義と
// パース規則は lib/organizations.ts の ORG_BLOCKERS / parseBlockers を参照。
//
//   GET → { blockers: { "大田区": ["委託構造","費用対効果"], ... } }
//
// /status の団体一覧がチップとして出す。★（org_priority）と同じく付随情報なので、
// 取れなくても一覧本体は止めない（画面側でフォールバック）。
// organization_notes は RLS で anon に SELECT が許可されているため anonCreds()。

export const dynamic = "force-dynamic";

export async function GET() {
  const anon = anonCreds();
  if (!anon) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }
  try {
    const blockers = await fetchAllBlockers(anon.url, anon.key);
    return NextResponse.json({ blockers });
  } catch (error) {
    console.error("詰まり取得エラー:", error);
    return NextResponse.json(
      { error: "詰まりの取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}
