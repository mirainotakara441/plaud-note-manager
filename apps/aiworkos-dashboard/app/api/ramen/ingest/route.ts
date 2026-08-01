import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// 食べログの「行ったカレンダー」から吸い出した過去の口コミを一括で取り込む口。
//
// これは移行専用の裏口で、開発サーバーでしか開かない（本番では常に404）。
// 食べログ側のページから直接POSTするため CORS を許可しているが、
// localhost にしか存在しないので外から叩ける口にはならない。
// 取り込みが終わったらこのファイルごと消してよい。

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DEV = process.env.NODE_ENV !== "production";
const ORIGIN = "https://tabelog.com";

type Scraped = {
  r?: string; // 口コミID
  d: string; // 訪問日 YYYY-MM-DD
  s: string; // 店名
  g?: string; // "エリア / ジャンル"
  v?: string | null; // 何回目
  p?: string | null; // "夜の点数：4.0"
  tm?: string | null; // 昼 / 夜
  x?: string; // "4.0/3.0/3.0/3.0/-"
  t?: string | null; // タイトル
  b?: string | null; // 本文の頭
  u?: string | null; // 口コミURL（B番号#口コミID）
  su?: string | null; // 店舗URL
  ph?: number;
  pv?: boolean; // 非公開
};

function num(v: string | undefined | null): number | null {
  if (!v || v === "-") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// 「129杯目 …」「【128杯目】…」「121杯目③」「【125⑩】…」など表記が揺れる。
// 数字＋杯目 を第一候補にし、無ければ 【数字…】 の先頭数字を拾う。
// 丸数字は範囲指定（[①-⑳]）にしてはいけない。① は U+2460、】 は U+3011 で
// 範囲の内側に入ってしまい、ラベルに「】」以降が丸ごと混入する（実際に踏んだ）。
const MARK = "[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]";

function parseBowl(title: string | null | undefined): { no: number | null; label: string | null } {
  if (!title) return { no: null, label: null };
  const withUnit = title.match(new RegExp(`(\\d{1,3})\\s*杯目[ 　]*(${MARK})?`));
  if (withUnit) {
    return { no: parseInt(withUnit[1], 10), label: `${withUnit[1]}杯目${withUnit[2] ?? ""}` };
  }
  const bracket = title.match(new RegExp(`【[ 　]*(\\d{1,3})[ 　]*(${MARK})?[ 　]*】`));
  if (bracket) {
    return { no: parseInt(bracket[1], 10), label: `${bracket[1]}${bracket[2] ?? ""}` };
  }
  return { no: null, label: null };
}

// ラーメンかどうかは「杯目カウントに入れているか」で決まる（本人の数え方が正）。
// 杯目ラベルが無いものは、ジャンルにラーメン系が入っていても対象外にする。
// 行ったカレンダーは「（ジャンル/エリア）」の順で、全角カッコ・区切りに空白なし。
// レビュアートップの「エリア / ジャンル」とは順序が逆なので取り違えないこと。
function splitGenre(g: string | undefined): { area: string | null; genre: string | null } {
  if (!g) return { area: null, genre: null };
  const body = g.replace(/^[（(]/, "").replace(/[）)]$/, "").trim();
  const idx = body.indexOf("/");
  if (idx === -1) return { area: body || null, genre: null };
  return { genre: body.slice(0, idx).trim() || null, area: body.slice(idx + 1).trim() || null };
}

function toRow(x: Scraped) {
  const { area, genre } = splitGenre(x.g);
  const bowl = parseBowl(x.t);
  const dtl = (x.x ?? "").split("/");
  const scoreMatch = (x.p ?? "").match(/([\d.]+)\s*$/);

  return {
    tabelog_review_id: x.r ?? null,
    eaten_on: x.d,
    shop: x.s,
    area,
    genre,
    visit_count: x.v ? parseInt(x.v, 10) : null,
    bowl_no: bowl.no,
    bowl_label: bowl.label,
    is_ramen: bowl.no != null,
    score: scoreMatch ? num(scoreMatch[1]) : null,
    score_time: x.tm === "昼" || x.tm === "夜" ? x.tm : null,
    score_food: num(dtl[0]),
    score_service: num(dtl[1]),
    score_mood: num(dtl[2]),
    score_cp: num(dtl[3]),
    title: x.t ?? null,
    excerpt: x.b ?? null,
    photo_count: typeof x.ph === "number" ? x.ph : 0,
    tabelog_url: x.u ? `https://tabelog.com/rvwr/000776165/rvwdtl/${x.u}` : null,
    tabelog_shop_url: x.su ? `https://tabelog.com/${x.su}/` : null,
    note: x.pv ? "食べログ上は非公開の口コミ" : null,
    status: "posted",
    source: "import",
    date_precision: "day",
  };
}

export async function OPTIONS() {
  if (!DEV) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      // 公開サイト(https://tabelog.com)から localhost を叩くと Chrome の
      // Private Network Access に阻まれ、プリフライトが無言で固まる。これが解錠キー。
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    },
  });
}

export async function POST(req: NextRequest) {
  if (!DEV) return new NextResponse(null, { status: 404 });

  const c = serviceCreds();
  if (!c) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY が未設定です" }, { status: 500 });
  }

  let rows: Scraped[] = [];
  try {
    const body = await req.json();
    rows = Array.isArray(body?.rows) ? body.rows : [];
  } catch {
    return NextResponse.json({ error: "リクエストが読めませんでした" }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "rows が空です" }, { status: 400 });
  }

  const payload = rows.filter((r) => r && r.d && r.s).map(toRow);

  const res = await fetch(
    `${c.url}/rest/v1/ramen_logs?on_conflict=tabelog_review_id`,
    {
      method: "POST",
      headers: restHeaders(c.key, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(payload),
    }
  );

  const headers = { "Access-Control-Allow-Origin": ORIGIN };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("ramen ingest 失敗:", res.status, detail);
    return NextResponse.json(
      { error: `取り込み失敗（${res.status}）`, detail: detail.slice(0, 300) },
      { status: 502, headers }
    );
  }

  return NextResponse.json({ ok: true, count: payload.length }, { headers });
}
