import { NextRequest, NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";
import { captureAuthorized } from "@/lib/ramen";

// 写真の受け口。iPhoneショートカットは multipart を組み立てにくいので、
// 画像を base64 で1枚ずつ送ってもらい、ここで Supabase Storage（非公開）へ置く。
// 返すのはバケット内のパスで、X投稿時にサーバーが service role で取り出す。
// 公開URLは発行しない（誰でも見られる場所に生写真を置かないため）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = "ramen-photos";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

export async function POST(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: SUPABASE_SERVICE_ROLE_KEY が未設定です" },
      { status: 500 }
    );
  }

  let body: { data?: string; content_type?: string; id?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが読めませんでした" }, { status: 400 });
  }

  const contentType = (body.content_type ?? "image/jpeg").toLowerCase();
  const ext = EXT[contentType];
  if (!ext) {
    return NextResponse.json(
      { error: `対応していない画像形式です（${contentType}）` },
      { status: 400 }
    );
  }

  // data URL 形式（data:image/jpeg;base64,...）で送られても受けられるようにする。
  const raw = (body.data ?? "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!raw) {
    return NextResponse.json({ error: "画像データがありません" }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    return NextResponse.json({ error: "画像データを復号できませんでした" }, { status: 400 });
  }
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "画像データが空です" }, { status: 400 });
  }

  const stamp = new Date().toISOString().replace(/[^\d]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${body.id ?? "unassigned"}/${stamp}-${rand}.${ext}`;

  const res = await fetch(`${c.url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      "Content-Type": contentType,
    },
    body: new Uint8Array(bytes),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("写真の保存失敗:", res.status, detail);
    return NextResponse.json(
      { error: `写真の保存に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, path, bytes: bytes.byteLength });
}
