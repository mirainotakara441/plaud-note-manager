import { NextRequest, NextResponse } from "next/server";

// 個人利用前提のAIワークOSをBasic認証で保護する。
// DASHBOARD_USER / DASHBOARD_PASS が両方セットされている時だけ有効化する。
// 未設定なら素通し（デプロイ直後のロックアウトを防ぐ）——Vercelに両方を登録してRedeployすると保護が有効になる。
// 注: このアプリ自身のfetchは同一オリジンなので、ブラウザが一度認証すれば以降のAPI呼び出しにも自動でBasic資格情報が付く。
//     取込ワーカー(jobs.py)はこのアプリを経由せずSupabase PostgRESTを直接叩くため、Basic認証の影響を受けない。

export const config = {
  // 静的アセット・PWAアイコンは認証対象外。それ以外（ページ／API全て）を保護する。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-.*\\.png).*)"],
};

export function middleware(req: NextRequest) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;

  // 資格情報が未設定なら認証を課さない。
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6)); // "user:pass"（Edge Runtimeで atob 利用可）
    const idx = decoded.indexOf(":");
    if (idx !== -1) {
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      if (u === user && p === pass) return NextResponse.next();
    }
  }

  // WWW-Authenticate はHTTPヘッダ=ByteStringのためASCIIのみ（realmに日本語を入れると500になる）。
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AI Work OS"' },
  });
}
