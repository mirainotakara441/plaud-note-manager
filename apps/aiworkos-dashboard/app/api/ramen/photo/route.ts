import { NextRequest, NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";
import { captureAuthorized, isSafePhotoPath, PHOTO_EXT, RAMEN_BUCKET } from "@/lib/ramen";

// 写真の出し入れ。
//
// POST: iPhoneショートカットは multipart を組み立てにくいので、画像を base64 で
//       1枚ずつ送ってもらい、ここで Supabase Storage（非公開）へ置く。
//       返すのはバケット内のパスで、X投稿時にサーバーが service role で取り出す。
//       公開URLは発行しない（誰でも見られる場所に生写真を置かないため）。
// GET:  そのパスの画像を、このアプリ自身が service role で取り出して返す。
//       署名付きURLではなくプロキシにしているのは、URLが独り歩きしないようにするため
//       （/api/family/photo と同じ方式）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKET = RAMEN_BUCKET;
const EXT = PHOTO_EXT;

// 縮小して返す幅。一覧のサムネイル（3列）と、1枚だけのカード用。
const ALLOWED_WIDTHS = new Set([480, 1280]);

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

  // id は ramen_logs の自動採番（整数）主キー。パスに連結する前に数字のみへ絞り、
  // "../" 等でバケット外へ出られないようにする（web側は id を送らず "unassigned" のまま使う）。
  const rawId = body.id;
  let idSegment = "unassigned";
  if (rawId !== undefined && rawId !== null && rawId !== "") {
    if (!/^\d+$/.test(String(rawId))) {
      return NextResponse.json({ error: "idの形式が不正です" }, { status: 400 });
    }
    idSegment = String(rawId);
  }

  const stamp = new Date().toISOString().replace(/[^\d]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${idSegment}/${stamp}-${rand}.${ext}`;

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

export async function GET(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  const sp = new URL(req.url).searchParams;
  const path = sp.get("path") ?? "";
  if (!isSafePhotoPath(path)) {
    return NextResponse.json({ error: "パスが不正です" }, { status: 400 });
  }

  // 一覧のサムネイル用に縮めて返す。原寸は1枚0.7〜1MBあり、1か月ぶん（10〜20杯）
  // 並べるだけで10MB超をiPhoneに落とすことになる。幅は許す値だけに絞る
  // （任意の数を許すと、同じ写真が無数の別URLになってキャッシュが効かない）。
  const wantedWidth = ALLOWED_WIDTHS.has(Number(sp.get("w"))) ? Number(sp.get("w")) : null;

  const res = await fetch(`${c.url}/storage/v1/object/${BUCKET}/${path}`, {
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
  let body: ArrayBuffer = buf;
  let type = res.headers.get("content-type") ?? "image/jpeg";

  if (wantedWidth) {
    try {
      const sharp = (await import("sharp")).default;
      const out = await sharp(Buffer.from(buf))
        // 元より大きくはしない（拡大してもデータが増えるだけで綺麗にならない）
        .resize({ width: wantedWidth, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      // Buffer のままだと NextResponse の型（BodyInit）に合わないので ArrayBuffer へ写す
      body = out.buffer.slice(
        out.byteOffset,
        out.byteOffset + out.byteLength
      ) as ArrayBuffer;
      type = "image/jpeg";
    } catch (err) {
      // 縮小に失敗したら原寸を返す。重いだけで、写真が出ないより良い
      console.error("ramen photo: 縮小に失敗", err);
    }
  }

  return new NextResponse(body, {
    headers: {
      "Content-Type": type,
      // パスは毎回ユニーク（上書きしない）ので端末側に長く置いてよい。
      // private を付けて共有キャッシュには残さない。
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
