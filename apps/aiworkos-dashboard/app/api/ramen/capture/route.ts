import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { captureAuthorized } from "@/lib/ramen";
import { toJstDateString } from "@/lib/date";

// 一杯の起票。iPhoneショートカット（Bearer: RAMEN_CAPTURE_SECRET）と
// サイトの入力フォーム（合言葉cookie）の両方から同じ口を叩く。
// ここでは文章生成をしない。店の前で叩いて数秒で終わることを優先し、
// 生成は /api/ramen/draft に分ける（ショートカット実行が生成待ちで固まらないように）。

export const dynamic = "force-dynamic";

type Body = {
  shop?: string;
  memo?: string;
  menu?: string;
  price?: number | string | null;
  eaten_on?: string;
  bowl_no?: number | string | null;
  visit_count?: number | string | null;
  area?: string;
  genre?: string;
  is_ramen?: boolean;
  photo_urls?: string[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

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

  const shop = body.shop?.trim();
  if (!shop) {
    return NextResponse.json({ error: "店名は必須です" }, { status: 400 });
  }

  // 日付は基本その日。ショートカットから明示されたときだけ従う。
  const eatenOn =
    body.eaten_on && DAY_RE.test(body.eaten_on)
      ? body.eaten_on
      : toJstDateString(new Date().toISOString());

  const bowlNo = toInt(body.bowl_no);
  const isRamen = body.is_ramen ?? true;

  const row = {
    eaten_on: eatenOn,
    shop,
    memo: body.memo?.trim() || null,
    menu: body.menu?.trim() || null,
    price: toInt(body.price),
    area: body.area?.trim() || null,
    genre: body.genre?.trim() || null,
    visit_count: toInt(body.visit_count),
    bowl_no: isRamen ? bowlNo : null,
    bowl_label: isRamen && bowlNo != null ? `${bowlNo}杯目` : null,
    is_ramen: isRamen,
    photo_urls: Array.isArray(body.photo_urls) ? body.photo_urls : [],
    status: "captured",
    source: req.headers.get("authorization") ? "shortcut" : "web",
  };

  const res = await fetch(`${c.url}/rest/v1/ramen_logs`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("ramen capture 失敗:", res.status, detail);
    return NextResponse.json(
      { error: `記録に失敗しました（${res.status}）`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const rows = await res.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;
  return NextResponse.json({ ok: true, id: saved?.id, eaten_on: eatenOn, shop });
}
