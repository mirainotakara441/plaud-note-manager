import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { isSafePhotoPath, FAMILY_BUCKET } from "@/lib/family";
import { familyAuthorized } from "@/lib/familyAuth";
import { toJstDateString } from "@/lib/date";

// お出かけ1件の登録・更新・削除。
// 写真は先に /api/family/photo へ上げてバケット内パスをもらい、
// その配列を photo_paths として渡す（ラーメンの起票と同じ流れ）。

export const dynamic = "force-dynamic";

type Body = {
  id?: number | string;
  happened_on?: string;
  title?: string;
  place?: string;
  place_kind?: string;
  area?: string;
  members?: string[];
  memo?: string;
  highlight?: string;
  stars?: number | string | null;
  cost?: number | string | null;
  photo_paths?: string[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function cleanPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is string => typeof p === "string" && isSafePhotoPath(p));
}

const MAX_COST = 10_000_000;

// stars・cost は未入力なら null で通すが、値が入っているのに範囲外・非数値なら
// 黙って null に落とさずエラーを返す（入力ミスに気づけないと評価・出費の記録が壊れる）。
function parseStars(v: unknown): { value: number | null } | { error: string } {
  if (v == null || v === "") return { value: null };
  const n = toInt(v);
  if (n == null || n < 1 || n > 5) {
    return { error: "評価（★）は1〜5の整数で入力してください" };
  }
  return { value: n };
}

function parseCost(v: unknown): { value: number | null } | { error: string } {
  if (v == null || v === "") return { value: null };
  const n = toInt(v);
  if (n == null || n < 0 || n > MAX_COST) {
    return { error: `費用は0〜${MAX_COST.toLocaleString("ja-JP")}円の範囲で入力してください` };
  }
  return { value: n };
}

function buildRow(body: Body) {
  const title = body.title?.trim();
  if (!title) return { error: "タイトル（何をしたか）は必須です" as const };

  const happenedOn =
    body.happened_on && DAY_RE.test(body.happened_on)
      ? body.happened_on
      : toJstDateString(new Date().toISOString());

  const starsResult = parseStars(body.stars);
  if ("error" in starsResult) return { error: starsResult.error };

  const costResult = parseCost(body.cost);
  if ("error" in costResult) return { error: costResult.error };

  return {
    row: {
      happened_on: happenedOn,
      title,
      place: body.place?.trim() || null,
      place_kind: body.place_kind?.trim() || null,
      area: body.area?.trim() || null,
      members: Array.isArray(body.members)
        ? body.members.filter((m): m is string => typeof m === "string" && m.trim() !== "")
        : [],
      memo: body.memo?.trim() || null,
      highlight: body.highlight?.trim() || null,
      stars: starsResult.value,
      cost: costResult.value,
      photo_paths: cleanPaths(body.photo_paths),
    },
  };
}

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

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが読めませんでした" }, { status: 400 });
  }

  const built = buildRow(body);
  if ("error" in built) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  const id = toInt(body.id);

  // id付きなら更新（写真の追加もここを通る）、無ければ新規。
  const url = id
    ? `${c.url}/rest/v1/family_logs?id=eq.${id}`
    : `${c.url}/rest/v1/family_logs`;

  const res = await fetch(url, {
    method: id ? "PATCH" : "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(
      id
        ? { ...built.row, updated_at: new Date().toISOString() }
        : { ...built.row, source: req.headers.get("authorization") ? "shortcut" : "web" }
    ),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("family capture 失敗:", res.status, detail);
    return NextResponse.json(
      { error: `記録に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;
  if (id && !saved) {
    return NextResponse.json({ error: "対象の記録が見つかりませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id: saved?.id ?? id, item: saved });
}

// 間違えて登録した1件を消す。写真もバケットから一緒に消す
// （残しておいても参照する行が無く、後から見分けがつかないため）。
export async function DELETE(req: NextRequest) {
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

  const id = toInt(new URL(req.url).searchParams.get("id"));
  if (!id) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/family_logs?id=eq.${id}`, {
    method: "DELETE",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `削除に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  const removed = Array.isArray(rows) ? rows[0] : rows;
  if (!removed) {
    return NextResponse.json({ error: "対象の記録が見つかりませんでした" }, { status: 404 });
  }

  for (const path of cleanPaths(removed.photo_paths)) {
    await fetch(`${c.url}/storage/v1/object/${FAMILY_BUCKET}/${path}`, {
      method: "DELETE",
      headers: { apikey: c.key, Authorization: `Bearer ${c.key}` },
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, id });
}
