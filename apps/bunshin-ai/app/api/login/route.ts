import { NextRequest, NextResponse } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import {
  AUTH_COOKIE,
  NAME_COOKIE,
  ADMIN_COOKIE,
  COOKIE_MAX_AGE,
  memberPassphrase,
  adminPassphrase,
} from "@/lib/session";

// 合言葉の照合と cookie 発行。proxy.ts（認証ゲート）とペア。
//
// 合言葉は2種類ある：
//   BUNSHIN_PASSPHRASE       … メンバー用。分身AIと話せる。
//   BUNSHIN_ADMIN_PASSPHRASE … 吉井さん用。上に加えて /admin（相談ログ）が開く。
// 管理用を入れた場合もメンバー用のcookieを併せて発行するので、
// 吉井さんは合言葉を1つ覚えるだけで両方使える。

export async function POST(req: NextRequest) {
  const member = memberPassphrase();
  if (!member) {
    return NextResponse.json(
      { error: "サーバーに合言葉が設定されていません" },
      { status: 500 }
    );
  }

  let body: { passphrase?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/login: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const input = typeof body.passphrase === "string" ? body.passphrase : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json({ error: "お名前を入力してください" }, { status: 400 });
  }
  if (name.length > 40) {
    return NextResponse.json({ error: "お名前が長すぎます" }, { status: 400 });
  }

  const admin = adminPassphrase();
  const isAdmin = !!admin && constantTimeEqual(input, admin);
  const isMember = constantTimeEqual(input, member);

  if (!isMember && !isAdmin) {
    return NextResponse.json({ error: "合言葉が違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, admin: isAdmin });
  const base = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  };
  res.cookies.set(AUTH_COOKIE, await cookieValueFor(member), base);
  res.cookies.set(NAME_COOKIE, encodeURIComponent(name), base);
  if (isAdmin && admin) {
    res.cookies.set(ADMIN_COOKIE, await cookieValueFor(admin), base);
  }
  return res;
}

// ログアウト。この端末の cookie を消すだけ。
// 全員を一斉に締め出したいときは Vercel の BUNSHIN_PASSPHRASE を変える。
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  const kill = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    maxAge: 0,
    path: "/",
  };
  res.cookies.set(AUTH_COOKIE, "", kill);
  res.cookies.set(NAME_COOKIE, "", kill);
  res.cookies.set(ADMIN_COOKIE, "", kill);
  return res;
}
