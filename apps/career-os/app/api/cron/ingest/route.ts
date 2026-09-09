import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";

// 日次のメール取込。Vercel Cron から毎日叩かれる（スケジュールは vercel.json）。
//
// ★重要★ このパスは proxy.ts の PUBLIC_PATHS に入っている。
// Cron のリクエストには合言葉 cookie が付かないため通してあるが、
// そのぶん認証はこのファイルの責任になる。ここを抜くと取込APIが全世界に開く。
//
// 通すのは次のどちらか:
//   - Authorization: Bearer <CRON_SECRET>（Vercel Cron が自動で付ける）
//   - 合言葉 cookie（ブラウザから「今すぐ取り込む」を押したとき）
//
// フェイルクローズ設計: CRON_SECRET が未設定なら 503 で閉じる。
// 「設定を忘れたまま無防備に動いている」より「動かない」ほうが安全側。

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const COOKIE_NAME = "careeros_auth";

/** 日次実行で遡る日数。毎日走る前提なので7日ぶん見ておけば取りこぼさない。 */
const CRON_NEWER_THAN_DAYS = 7;

async function authorized(req: NextRequest): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET?.trim();
  // 未設定なら誰も通さない（呼び出し元で 503 を返す）。
  if (!cronSecret) return false;

  const header = req.headers.get("authorization") ?? "";
  if (constantTimeEqual(header, `Bearer ${cronSecret}`)) return true;

  // 手動実行を許すための合言葉 cookie 経路。
  const passphrase = process.env.APP_PASSPHRASE;
  if (passphrase && passphrase.trim() !== "") {
    const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
    if (constantTimeEqual(cookie, await cookieValueFor(passphrase))) return true;
  }

  return false;
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json(
      { error: "サーバー設定エラー: CRON_SECRET が設定されていません" },
      { status: 503 }
    );
  }

  if (!(await authorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  try {
    const summary = await runIngest({
      trigger: "cron",
      newerThanDays: CRON_NEWER_THAN_DAYS,
    });
    return NextResponse.json(summary, { status: summary.error ? 500 : 200 });
  } catch (err) {
    console.error("GET /api/cron/ingest: 取込に失敗", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
