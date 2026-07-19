import { NextRequest, NextResponse } from "next/server";

// 合言葉の照合と cookie 発行。proxy.ts（認証ゲート）とペア。
// cookie には合言葉の SHA-256 を入れる（proxy.ts が同じ計算で照合する）。

const COOKIE_NAME = "aiworkos_auth";
const ONE_YEAR = 60 * 60 * 24 * 365;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const input = typeof body.passphrase === "string" ? body.passphrase : "";
  if (input !== passphrase) {
    return NextResponse.json({ error: "合言葉が違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await sha256Hex(passphrase), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return res;
}
