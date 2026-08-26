import { NextRequest, NextResponse } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { HOJIN_QA_COOKIE_NAME, HOJIN_QA_PASSPHRASE } from "@/lib/hojinQaAuth";

// 法人請求QA検索（外部サイト）の入り口の合言葉照合。app/api/login/route.ts と
// 同じ作り（constantTimeEqual・cookieValueFor）だが、cookie名・合言葉は別。
// 詳細は lib/hojinQaAuth.ts。

export const dynamic = "force-dynamic";

const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(req: NextRequest) {
  let body: { passphrase?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/qa-gate: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const input = typeof body.passphrase === "string" ? body.passphrase : "";
  if (!constantTimeEqual(input, HOJIN_QA_PASSPHRASE)) {
    return NextResponse.json({ error: "合言葉が違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(HOJIN_QA_COOKIE_NAME, await cookieValueFor(HOJIN_QA_PASSPHRASE), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return res;
}
