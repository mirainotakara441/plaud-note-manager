import { NextRequest, NextResponse } from "next/server";
import {
  QA_OPEN_COOKIE,
  QA_OPEN_COOKIE_MAX_AGE,
  logAccess,
  normalizeEmail,
  normalizeName,
  normalizeOrg,
  upsertVisitor,
} from "@/lib/qaOpen";

// /qa-open の入口。名前とメールアドレス（任意で所属）を受け取り、
// qa_open_visitors に登録して来訪者 cookie を発行する。
// 同じメールで再登録しても id は変わらない（名前・所属は最新で上書き）。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { name?: unknown; email?: unknown; org?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const org = normalizeOrg(body.org);
  if (!name) return NextResponse.json({ error: "お名前を入力してください" }, { status: 400 });
  if (!email) return NextResponse.json({ error: "メールアドレスの形式を確認してください" }, { status: 400 });

  const visitor = await upsertVisitor({ name, email, org });
  if (!visitor) {
    return NextResponse.json({ error: "登録に失敗しました。時間をおいて再度お試しください" }, { status: 502 });
  }
  await logAccess(visitor.id, "/qa-open (登録)", req.headers.get("user-agent"));

  const res = NextResponse.json({ ok: true, name: visitor.name });
  res.cookies.set(QA_OPEN_COOKIE, visitor.id, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: QA_OPEN_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}

// この端末の登録を外す（別の人が同じ端末で開くとき用）
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(QA_OPEN_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return res;
}
