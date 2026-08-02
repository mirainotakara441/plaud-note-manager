import { NextRequest } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";

// 家庭訪問の書き込み認証（サーバー専用）。lib/homeVisit.ts はクライアントからも
// 読むため、next/server に依存するこの関数だけを分けてある（ファミリーと同じ形）。
//
// 入口はサイトの合言葉cookieだけ。iPhoneショートカット等の外部経路は用意しない
// （メンバーの氏名・年齢を含むので、増やすなら都度考えたい）。

const COOKIE_NAME = "aiworkos_auth";

export async function homeVisitAuthorized(req: NextRequest): Promise<boolean> {
  const passphrase = process.env.APP_PASSPHRASE;
  if (!passphrase || passphrase.trim() === "") return false;
  const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
  return constantTimeEqual(cookie, await cookieValueFor(passphrase));
}
