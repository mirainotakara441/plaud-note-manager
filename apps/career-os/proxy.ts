import { NextRequest, NextResponse } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";

// 合言葉認証。AIワークOS の proxy.ts をそのまま踏襲している。
//
// このアプリには転職活動という、現職に知られると実害のある情報が載る。
// 「URLが知られていない」だけの守りにはせず、全ページ・全APIをここで塞ぐ。
//
// 仕組み:
//   - 環境変数 APP_PASSPHRASE に合言葉を設定する（Vercel / .env.local）
//   - 未認証のページアクセスは /login へリダイレクト、API は 401 を返す
//   - cookie には合言葉そのものではなくハッシュ/HMAC を入れる（漏れても原文が割れない）
//   - cookie 比較は constantTimeEqual（定数時間比較）で行う
//
// フェイルクローズ設計: APP_PASSPHRASE が未設定/空なら全ページ・全APIを閉じる。
// 設定漏れ・削除事故に気づけないまま無防備になる方が危険なので、閉じる側へ倒す。

const COOKIE_NAME = "careeros_auth";

// 認証なしで通すパス。PWA の起動アセットとログイン経路は塞がない。
const PUBLIC_PATHS = [
  /^\/login$/,
  /^\/api\/login$/,
  /^\/manifest\.json$/,
  /^\/icon-\d+\.png$/,
  /^\/favicon\.ico$/,
  // Vercel Cron が叩く日次のメール取込。Cron のリクエストには合言葉 cookie が無いため
  // ここは通すが、ルート側で CRON_SECRET を照合するので無認証では実行できない。
  /^\/api\/cron\/ingest$/,
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((re) => re.test(pathname))) {
    return NextResponse.next();
  }

  const passphrase = process.env.APP_PASSPHRASE;
  if (!passphrase || passphrase.trim() === "") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "サーバー設定エラー: 認証が構成されていません" },
        { status: 503 }
      );
    }
    return new NextResponse("サーバー設定エラー: 認証が構成されていません", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? "";
  const expected = await cookieValueFor(passphrase);
  if (constantTimeEqual(cookie, expected)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // 静的アセットは除外（毎リクエストの proxy 実行を減らす）
  matcher: ["/((?!_next/static|_next/image).*)"],
};
