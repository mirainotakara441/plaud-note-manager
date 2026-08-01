import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, anonCreds, restHeaders } from "@/lib/supabase";
import { captureAuthorized } from "@/lib/ramen";
import { xCreds, uploadMedia, postTweet } from "@/lib/x";

// 下書きをXへ投稿する。写真は Supabase Storage（非公開）から取り出して media/upload に流す。
// 投稿できたら ramen_logs に x_url / x_posted_on を書き戻し、記録と投稿が二度と乖離しないようにする。
//
// 冪等性: すでに x_url が入っている行は二重投稿しない（画面の連打・再実行対策）。
// 上書きしたいときは force:true を明示する。

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BUCKET = "ramen-photos";
const MAX_MEDIA = 4; // Xの1投稿あたりの画像上限

function contentTypeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  return "image/jpeg";
}

export async function POST(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const x = xCreds();
  if (!x) {
    return NextResponse.json(
      {
        error:
          "Xのキーが未設定です。X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET を設定してください。",
      },
      { status: 503 }
    );
  }
  const svc = serviceCreds();
  const anon = anonCreds();
  if (!svc || !anon) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  }

  let id: number | null = null;
  let force = false;
  let overrideText: string | null = null;
  try {
    const body = await req.json();
    id = typeof body?.id === "number" ? body.id : parseInt(String(body?.id), 10);
    force = body?.force === true;
    overrideText = typeof body?.text === "string" ? body.text : null;
  } catch {
    /* 下で弾く */
  }
  if (!id || !Number.isFinite(id)) {
    return NextResponse.json({ error: "対象のidが必要です" }, { status: 400 });
  }

  const getRes = await fetch(
    `${anon.url}/rest/v1/ramen_logs?select=id,eaten_on,draft_x,x_url,photo_urls&id=eq.${id}`,
    { headers: restHeaders(anon.key), cache: "no-store" }
  );
  if (!getRes.ok) {
    return NextResponse.json({ error: `対象の取得に失敗（${getRes.status}）` }, { status: 502 });
  }
  const rows = await getRes.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return NextResponse.json({ error: "対象の記録が見つかりません" }, { status: 404 });
  }
  if (row.x_url && !force) {
    return NextResponse.json(
      { error: "この一杯はすでにXへ投稿済みです", x_url: row.x_url },
      { status: 409 }
    );
  }

  const text = (overrideText ?? row.draft_x ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "X用の下書きがありません" }, { status: 400 });
  }
  // URL入りは1本$0.20（通常の13倍）になるため、事故を金額の面でも止める。
  if (/https?:\/\//i.test(text)) {
    return NextResponse.json(
      { error: "本文にURLが含まれています。URL入りは課金単価が跳ね上がるため送信しません。" },
      { status: 400 }
    );
  }

  // 写真をStorageから取り出してXへ上げる。1枚でも落ちたら投稿自体を止める
  // （画像なしの投稿が勝手に出るほうが困るため）。
  const paths: string[] = Array.isArray(row.photo_urls) ? row.photo_urls.slice(0, MAX_MEDIA) : [];
  const mediaIds: string[] = [];
  try {
    for (const path of paths) {
      const obj = await fetch(`${svc.url}/storage/v1/object/${BUCKET}/${path}`, {
        headers: { apikey: svc.key, Authorization: `Bearer ${svc.key}` },
        cache: "no-store",
      });
      if (!obj.ok) throw new Error(`写真の取得に失敗（${path}: ${obj.status}）`);
      const buf = Buffer.from(await obj.arrayBuffer());
      mediaIds.push(await uploadMedia(buf, contentTypeOf(path), x));
    }
  } catch (e) {
    console.error("X画像アップロード失敗:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "写真のアップロードに失敗しました" },
      { status: 502 }
    );
  }

  let posted: { id: string; url: string };
  try {
    posted = await postTweet(text, mediaIds, x);
  } catch (e) {
    console.error("X投稿失敗:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "X投稿に失敗しました" },
      { status: 502 }
    );
  }

  const upd = await fetch(`${svc.url}/rest/v1/ramen_logs?id=eq.${id}`, {
    method: "PATCH",
    headers: restHeaders(svc.key),
    body: JSON.stringify({
      x_url: posted.url,
      x_posted_on: row.eaten_on,
      x_posted_at: new Date().toISOString(),
      x_excerpt: text.split("\n")[0].slice(0, 120),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!upd.ok) {
    // 投稿は成功しているので、書き戻し失敗は警告にとどめてURLは返す。
    console.error("X投稿後の書き戻し失敗:", upd.status, await upd.text().catch(() => ""));
    return NextResponse.json({
      ok: true,
      x_url: posted.url,
      warning: "投稿はできましたが、記録への書き戻しに失敗しました",
    });
  }

  return NextResponse.json({ ok: true, x_url: posted.url, media: mediaIds.length });
}
