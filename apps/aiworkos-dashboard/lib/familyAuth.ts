import { NextRequest } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";

// ファミリー起票の認証（サーバー専用）。lib/family.ts はクライアントからも読むため、
// next/server に依存するこの関数だけを分けてある。
//
// サイトの入力フォームは合言葉cookieを持っているのでそれで通し、
// iPhoneショートカットから叩きたくなった時のために Bearer も残す
// （FAMILY_CAPTURE_SECRET 未設定ならショートカット経路は閉じたまま＝フェイルクローズ）。

const COOKIE_NAME = "aiworkos_auth";

export async function familyAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.FAMILY_CAPTURE_SECRET?.trim();
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) {
    return true;
  }
  const passphrase = process.env.APP_PASSPHRASE;
  if (passphrase && passphrase.trim() !== "") {
    const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
    if (constantTimeEqual(cookie, await cookieValueFor(passphrase))) return true;
  }
  return false;
}
