import { NextRequest, NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";
import { isSafePhotoPath, FAMILY_BUCKET, PHOTO_EXT } from "@/lib/family";
import { familyAuthorized } from "@/lib/familyAuth";

// 思い出の写真の出し入れ。
//
// POST: 画像を base64 で1枚ずつ受け取り、非公開バケット family-photos へ置く。
//       返すのはバケット内のパスだけ（公開URLは発行しない）。
// GET:  そのパスの画像を、このアプリ自身が service role で取り出して返す。
//       合言葉認証（proxy.ts）の内側なので、ログインした端末からしか見えない。
//       署名付きURLではなくプロキシにしているのは、URLが独り歩きしないようにするため。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!(await familyAuthorized(req))) {
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
  const ext = PHOTO_EXT[contentType];
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
  const folder = String(body.id ?? "unassigned").replace(/[^A-Za-z0-9_-]/g, "") || "unassigned";
  const path = `${folder}/${stamp}-${rand}.${ext}`;

  const res = await fetch(`${c.url}/storage/v1/object/${FAMILY_BUCKET}/${path}`, {
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
    console.error("family 写真の保存失敗:", res.status, detail);
    return NextResponse.json(
      { error: `写真の保存に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, path, bytes: bytes.byteLength });
}

export async function GET(req: NextRequest) {
  if (!(await familyAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!isSafePhotoPath(path)) {
    return NextResponse.json({ error: "パスが不正です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/storage/v1/object/${FAMILY_BUCKET}/${path}`, {
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}` },
    cache: "no-store",
  });

  if (!res.ok) {
    // 消した写真・存在しないパスは storage が 400/404 のどちらでも返してくるので
    // まとめて404に寄せる（502だとサーバー障害と見分けがつかない）。
    const missing = res.status === 400 || res.status === 404;
    return NextResponse.json(
      { error: missing ? "写真が見つかりません" : `写真を取得できませんでした（${res.status}）` },
      { status: missing ? 404 : 502 }
    );
  }

  const buf = await res.arrayBuffer();
  return new NextResponse(buf, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
      // パスは毎回ユニーク（上書きしない）なので端末側に長く置いてよい。
      // private を付けて共有キャッシュには残さない。
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
