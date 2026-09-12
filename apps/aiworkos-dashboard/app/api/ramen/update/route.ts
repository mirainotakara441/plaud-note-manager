import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { captureAuthorized, isSafePhotoPath, RAMEN_BUCKET } from "@/lib/ramen";

// 既に記録した一杯を、後から手で直す口。
//
// 引き受けるのは3つだけ:
//   score        … 自分の点数（0.0〜5.0）。食べログに付けた点と同じ列を使う。
//   memo         … その場の一言（写真から思い出して足す場面がある）。
//   add_photos   … 写真の後付け。/api/ramen/photo で上げたパスを追記する。
//   remove_photo … 1枚だけ外す。Storageの実体も消す。
//
// 起票（/api/ramen/capture）と分けているのは、起票は「店の前で数秒」、
// こちらは「後から机で直す」で、求められる速さと壊し方が違うため。
// 店名・日付・杯番号は触らない（食べログ取り込みと衝突すると突合が崩れる）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 手元に置ける枚数。Xへ出るのは先頭4枚（post-x の MAX_MEDIA）だが、
// 記録としては1杯あたりもう少し残せるようにしておく。
const MAX_PHOTOS_PER_LOG = 12;

type Body = {
  id?: number | string;
  score?: number | string | null;
  memo?: string | null;
  add_photos?: string[];
  remove_photo?: string;
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

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが読めませんでした" }, { status: 400 });
  }

  const id = parseInt(String(body.id ?? ""), 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  // 点数。空文字・null は「点数を消す」。数値は 0.0〜5.0 に収め、小数1桁へ丸める
  // （0.1刻みで入れる前提。0.05 のような値が入ると平均点の桁が揺れて読めなくなる）。
  if ("score" in body) {
    const raw = body.score;
    if (raw === null || raw === "" || raw === undefined) {
      patch.score = null;
    } else {
      const n = typeof raw === "number" ? raw : parseFloat(String(raw));
      if (!Number.isFinite(n) || n < 0 || n > 5) {
        return NextResponse.json(
          { error: "点数は0.0〜5.0で入れてください" },
          { status: 400 }
        );
      }
      patch.score = Math.round(n * 10) / 10;
    }
  }

  if ("memo" in body) {
    const memo = (body.memo ?? "").trim();
    patch.memo = memo === "" ? null : memo;
  }

  const adding = Array.isArray(body.add_photos) ? body.add_photos : [];
  const removing = body.remove_photo?.trim() ?? "";

  for (const p of adding) {
    if (!isSafePhotoPath(p)) {
      return NextResponse.json({ error: "写真のパスが不正です" }, { status: 400 });
    }
  }
  if (removing !== "" && !isSafePhotoPath(removing)) {
    return NextResponse.json({ error: "写真のパスが不正です" }, { status: 400 });
  }

  const touchesPhotos = adding.length > 0 || removing !== "";
  if (Object.keys(patch).length === 0 && !touchesPhotos) {
    return NextResponse.json({ error: "変更する内容がありません" }, { status: 400 });
  }

  // 写真を触るときだけ現在の並びを読む。配列を丸ごと入れ替える方式なので、
  // 読まずに書くと他の端末から足した1枚を消してしまう。
  if (touchesPhotos) {
    const getRes = await fetch(
      `${c.url}/rest/v1/ramen_logs?select=id,photo_urls&id=eq.${id}`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!getRes.ok) {
      return NextResponse.json({ error: "対象の取得に失敗しました" }, { status: 502 });
    }
    const row = (await getRes.json())[0];
    if (!row) return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });

    const current: string[] = Array.isArray(row.photo_urls) ? row.photo_urls : [];
    let next = current;

    if (removing !== "") {
      if (!current.includes(removing)) {
        return NextResponse.json(
          { error: "その写真はこの一杯に付いていません" },
          { status: 400 }
        );
      }
      next = next.filter((p) => p !== removing);
    }

    if (adding.length > 0) {
      // 同じパスは二度並べない（送信をやり直した時に同じ写真が2枚に見えるのを防ぐ）
      const fresh = adding.filter((p) => !next.includes(p));
      if (next.length + fresh.length > MAX_PHOTOS_PER_LOG) {
        return NextResponse.json(
          { error: `写真は1杯あたり${MAX_PHOTOS_PER_LOG}枚までです（今${next.length}枚）` },
          { status: 400 }
        );
      }
      next = [...next, ...fresh];
    }

    patch.photo_urls = next;
  }

  const res = await fetch(`${c.url}/rest/v1/ramen_logs?id=eq.${id}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("ramen update 失敗:", res.status, detail);
    return NextResponse.json(
      { error: `更新に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;
  if (!saved) return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });

  // 行を書き換えたあとに実体を消す。先に消すと、更新に失敗した時点で
  // 「行は写真を指しているのに実体が無い」状態が残る。
  if (removing !== "") {
    try {
      await fetch(`${c.url}/storage/v1/object/${RAMEN_BUCKET}`, {
        method: "DELETE",
        headers: restHeaders(c.key),
        body: JSON.stringify({ prefixes: [removing] }),
      });
    } catch (err) {
      // 実体が残っても行からは外れている。ここで止めると外せなくなる。
      console.error("ramen update: 写真の削除に失敗", err);
    }
  }

  return NextResponse.json({
    ok: true,
    id: saved.id,
    score: saved.score ?? null,
    photos: Array.isArray(saved.photo_urls) ? saved.photo_urls.length : 0,
  });
}
