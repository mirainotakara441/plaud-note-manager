import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { ADMIN_COOKIE, adminPassphrase } from "@/lib/session";
import { listLogs } from "@/lib/logs";

// 相談ログ一覧（吉井さん専用）。
// proxy.ts はメンバー用の合言葉までしか見ていないので、ここで管理用cookieを別途照合する。

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = adminPassphrase();
  if (!admin) {
    return NextResponse.json(
      { error: "サーバーに管理用の合言葉が設定されていません" },
      { status: 503 }
    );
  }
  const store = await cookies();
  const cookie = store.get(ADMIN_COOKIE)?.value ?? "";
  if (!constantTimeEqual(cookie, await cookieValueFor(admin))) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 });
  }
  return NextResponse.json({ logs: await listLogs() });
}
