import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// ブラウザのプッシュ購読情報を登録・解除する。/actions の通知トグルから呼ばれる。
// 保存先は Supabase push_subscriptions。書き込みなので service role キーを使う
// （2026-07-25 レビュー対応）。endpoint がユニークキーなので同じ端末から二重に
// 押しても増殖しない（upsert）。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "購読情報が不正です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ endpoint, p256dh, auth }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: `登録失敗 ${res.status}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return NextResponse.json({ error: "endpointが必要です" }, { status: 400 });

  await fetch(`${c.url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "DELETE",
    headers: restHeaders(c.key),
  });
  return NextResponse.json({ ok: true });
}
