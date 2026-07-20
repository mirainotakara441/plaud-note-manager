import { NextRequest, NextResponse } from "next/server";

// 合言葉認証（2026-07-18 CTOレビューの最重要指摘への対応）。
// このアプリには個人の日記・実名の商談データ・課金を伴う生成APIが載っており、
// これまで守りが「URLが知られていない」だけだった。全ページ・全APIをここで守る。
//
// 仕組み:
//   - 環境変数 APP_PASSPHRASE に合言葉を設定する（Vercel / .env.local）
//   - 未認証のページアクセスは /login へリダイレクト、API は 401 を返す
//   - /api/login で合言葉が一致したら、合言葉の SHA-256 を httpOnly cookie に1年保存
//   - cookie には合言葉そのものではなくハッシュを入れる（漏れても原文が割れない）
//
// ⚠️ フェイルオープン設計: APP_PASSPHRASE が未設定なら素通しにする。
//   デプロイ直後に締め出される事故を防ぐため。環境変数を入れた瞬間から施錠される。
//   （Mac側ワーカーや取込スクリプトは Supabase 直通なので、この認証の影響を受けない）

const COOKIE_NAME = "aiworkos_auth";

// 認証なしで通すパス。PWA の起動アセットとログイン経路は塞がない。
const PUBLIC_PATHS = [
  /^\/login$/,
  /^\/api\/login$/,
  /^\/manifest\.json$/,
  /^\/icon-\d+\.png$/,
  /^\/favicon\.ico$/,
  // Vercel Cron が叩く日々のToDo自動処理。Cronのリクエストには合言葉cookieが無いため
  // ここは通すが、ルート側で CRON_SECRET を照合するので無認証では実行できない。
  /^\/api\/cron\/daily-todo$/,
];

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function proxy(request: NextRequest) {
  const passphrase = process.env.APP_PASSPHRASE;
  if (!passphrase || passphrase.trim() === "") {
    // フェイルオープン（上記コメント参照）
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((re) => re.test(pathname))) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  const expected = await sha256Hex(passphrase);
  if (cookie === expected) {
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
