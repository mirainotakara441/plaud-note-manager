import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";
import { select } from "@/lib/db";
import type { CareerIngestRun } from "@/lib/types";

// 手動での取込実行と、実行ログの参照。
//
// このパスは proxy.ts の PUBLIC_PATHS に入っていない＝合言葉認証の内側なので、
// ここで追加の認証は要らない。未認証のリクエストは proxy.ts が 401 で弾いている。
//
// 使い分け:
//   POST … 今すぐ取り込む（初回の遡り取込や、cronを待たずに反映したいとき）
//   GET  … 直近の実行ログを見る（動いているか / 何件入ったかの確認）

// 取込はGmail取得とAI抽出を数十回繰り返すため、既定の実行時間では足りない。
// Vercelの上限いっぱいまで確保する（処理件数の上限は lib/ingest.ts 側で持っている）。
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // bodyは省略可。付けない場合は .env の既定値で動く。
  let body: {
    maxResults?: unknown;
    newerThanDays?: unknown;
    maxScored?: unknown;
    skipScoring?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    // bodyなしのPOST（fetchでbodyを省いた場合）は正常系として扱う。
  }

  const maxResults =
    typeof body.maxResults === "number" && body.maxResults > 0
      ? Math.floor(body.maxResults)
      : undefined;
  const newerThanDays =
    typeof body.newerThanDays === "number" && body.newerThanDays > 0
      ? Math.floor(body.newerThanDays)
      : undefined;
  // 採点は1件$0.03（実測）。遡り取込で青天井にならないよう、外から上限を渡せる。
  // maxScored:0 と skipScoring:true はどちらも「採点しない」。0 を有効値として
  // 扱いたいので、maxResults 等と違って > 0 の条件を付けないこと。
  const maxScored =
    typeof body.maxScored === "number" && body.maxScored >= 0
      ? Math.floor(body.maxScored)
      : undefined;
  const skipScoring = body.skipScoring === true;

  try {
    const summary = await runIngest({
      trigger: "manual",
      maxResults,
      newerThanDays,
      maxScored,
      skipScoring,
    });
    // 個別メールの失敗があっても取込自体は成功扱い（summary.errors に載る）。
    // 実行全体が落ちた場合だけ 500 を返す。
    const status = summary.error ? 500 : 200;
    return NextResponse.json(summary, { status });
  } catch (err) {
    console.error("POST /api/ingest: 取込に失敗", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const runs = await select<CareerIngestRun>(
      "career_ingest_runs",
      "select=*&order=started_at.desc&limit=10"
    );
    return NextResponse.json({ runs });
  } catch (err) {
    console.error("GET /api/ingest: 実行ログの取得に失敗", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
