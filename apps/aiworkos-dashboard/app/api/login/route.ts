import { NextRequest, NextResponse } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";

// 合言葉の照合と cookie 発行。proxy.ts（認証ゲート）とペア。
// cookie値は lib/auth.ts の cookieValueFor（AUTH_COOKIE_SECRET設定時はHMAC-SHA256、
// 未設定ならSHA-256）で作る（proxy.ts が同じ計算で照合する）。
// 合言葉の一致判定は constantTimeEqual（定数時間比較）で行う
// （2026-07-25 アーキテクチャレビュー P2対応: タイミング攻撃対策）。

const COOKIE_NAME = "aiworkos_auth";
const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(req: NextRequest) {
  const passphrase = process.env.APP_PASSPHRASE;
  if (!passphrase || passphrase.trim() === "") {
    return NextResponse.json(
      { error: "サーバーに合言葉が設定されていません" },
      { status: 500 }
    );
  }

  let body: { passphrase?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/login: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const input = typeof body.passphrase === "string" ? body.passphrase : "";
  if (!constantTimeEqual(input, passphrase)) {
    return NextResponse.json({ error: "合言葉が違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await cookieValueFor(passphrase), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return res;
}
