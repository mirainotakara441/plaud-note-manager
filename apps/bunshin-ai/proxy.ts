import { NextRequest, NextResponse } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { AUTH_COOKIE, memberPassphrase } from "@/lib/session";

// 全ページ・全APIの認証ゲート。
//
// フェイルクローズ：BUNSHIN_PASSPHRASE が未設定なら全部閉じる。
// 設定漏れで無防備なまま公開される事故を防ぐため、開ける方に倒さない
// （aiworkos-dashboard の proxy.ts と同じ考え方）。

const PUBLIC_PATHS = [/^\/login$/, /^\/api\/login$/, /^\/favicon\.ico$/];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((re) => re.test(pathname))) {
    return NextResponse.next();
  }

  const passphrase = memberPassphrase();
  if (!passphrase) {
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

  const cookie = request.cookies.get(AUTH_COOKIE)?.value ?? "";
  if (constantTimeEqual(cookie, await cookieValueFor(passphrase))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // 静的アセットは除外する。ここを外すと CSS/JS まで /login へリダイレクトされ、
  // 画面がスタイルの当たっていない素のHTMLになる（実際に一度踏んだ）。
  matcher: ["/((?!_next/static|_next/image).*)"],
};
