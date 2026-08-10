import { NextRequest, NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";
import { captureAuthorized } from "@/lib/ramen";

// ラーメン（ライフOS側）：1行＝1杯（1訪問）の記録 ramen_logs を読む。
// 食べログ（mirainotakara）の口コミと X（@0kara1_man）の投稿を同じ行に束ねてあり、
// 「食べた → 食べログに書いた → Xに出した」までを1本の線で追える。
// 日報録・週報と同じく anonキーで Supabase PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "ramen_logs";

const COLUMNS = [
  "id",
  "eaten_on",
  "bowl_no",
  "bowl_label",
  "shop",
  "area",
  "genre",
  "visit_count",
  "menu",
  "price",
  "score",
  "score_time",
  "score_food",
  "score_service",
  "score_mood",
  "score_cp",
  "title",
  "excerpt",
  "photo_count",
  "tabelog_url",
  "tabelog_shop_url",
  "x_url",
  "x_posted_on",
  "x_excerpt",
  "is_ramen",
  "note",
  "stars",
  "status",
  "memo",
  "draft_tabelog",
  "draft_x",
  "photo_urls",
].join(",");

function creds() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

export async function GET() {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=${COLUMNS}&order=eaten_on.desc,bowl_no.desc,id.desc`,
    {
      headers: {
        apikey: c.anon,
        Authorization: `Bearer ${c.anon}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const items = await res.json();
  return NextResponse.json({ items });
}

// 1杯を削除する。
//
// 記録を始めたが写真の保存や下書き生成の途中で止まり、中身が半端なまま
// 残る行が出る（実際に id=224 / 230 がそうなった）。消せないと一覧の先頭に
// 居座り、通算杯数の勘定も狂って見える。
//
// Xへ投稿済みのものは既定では消さない。投稿だけ残って記録が消えると、
// 「Xに出したのに手元に無い」という一番たちの悪いズレになるため、
// 消すなら force を明示させる。写真はStorageからも消す（本文だけ消えて
// 生写真が残り続けるのは、消したつもりとして一番危ない）。
export async function DELETE(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const svc = serviceCreds();
  const c = creds();
  if (!svc || !c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const id = parseInt(sp.get("id") ?? "", 10);
  const force = sp.get("force") === "true";
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const getRes = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id,shop,x_url,photo_urls&id=eq.${id}`,
    { headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}` }, cache: "no-store" }
  );
  if (!getRes.ok) return NextResponse.json({ error: "対象の取得に失敗" }, { status: 502 });
  const row = (await getRes.json())[0];
  if (!row) return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });

  if (row.x_url && !force) {
    return NextResponse.json(
      { error: "この一杯はXへ投稿済みです。消すとXの投稿だけが残ります。", x_url: row.x_url },
      { status: 409 }
    );
  }

  // 写真を先に消す。行を先に消すとパスが分からなくなり、生写真が孤児として残る。
  const paths: string[] = Array.isArray(row.photo_urls) ? row.photo_urls : [];
  if (paths.length > 0) {
    try {
      await fetch(`${svc.url}/storage/v1/object/ramen-photos`, {
        method: "DELETE",
        headers: {
          apikey: svc.key,
          Authorization: `Bearer ${svc.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: paths }),
      });
    } catch (err) {
      // 写真が消せなくても行は消す。ここで止めると半端な行が消せなくなる
      console.error("DELETE /api/ramen: 写真の削除に失敗", err);
    }
  }

  const del = await fetch(`${svc.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "DELETE",
    headers: {
      apikey: svc.key,
      Authorization: `Bearer ${svc.key}`,
      Prefer: "return=representation",
    },
  });
  if (!del.ok) {
    const detail = await del.text().catch(() => "");
    return NextResponse.json({ error: `削除失敗 ${del.status}`, detail: detail.slice(0, 200) },
      { status: 502 });
  }
  const removed = await del.json();
  if (!Array.isArray(removed) || removed.length === 0) {
    return NextResponse.json({ error: "削除できませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: id, photos: paths.length });
}
