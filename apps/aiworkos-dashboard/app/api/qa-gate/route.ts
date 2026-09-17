import { NextRequest, NextResponse } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { HOJIN_QA_COOKIE_NAME, hojinQaPassphrase } from "@/lib/hojinQaAuth";

// 法人請求QA検索（/hojin-qa）の合言葉照合。app/api/login/route.ts と
// 同じ作り（constantTimeEqual・cookieValueFor）だが、cookie名・合言葉は別。
// 詳細は lib/hojinQaAuth.ts。

export const dynamic = "force-dynamic";

const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(req: NextRequest) {
  const passphrase = hojinQaPassphrase();
  if (!passphrase) {
    // フェイルクローズ（lib/hojinQaAuth.ts 参照）
    return NextResponse.json(
      { error: "サーバーにQAの合言葉が設定されていません" },
      { status: 500 }
    );
  }

  let body: { passphrase?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/qa-gate: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const input = typeof body.passphrase === "string" ? body.passphrase : "";
  if (!constantTimeEqual(input, passphrase)) {
    return NextResponse.json({ error: "合言葉が違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(HOJIN_QA_COOKIE_NAME, await cookieValueFor(passphrase), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return res;
}

// この端末だけQAから降りる（cookie を消す）。共用端末で開いたときの逃げ道。
// 全員を一斉に締め出すときは Vercel の HOJIN_QA_PASSPHRASE を変える
// （cookie 値は合言葉から作るので、変えた瞬間に全端末の cookie が無効になる）。
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(HOJIN_QA_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return res;
}
