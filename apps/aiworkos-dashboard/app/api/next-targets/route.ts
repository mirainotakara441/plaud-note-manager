import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// ホームの「🎯 次に攻める相手」。/status の「次に攻める団体」から、いま手を
// 付けるべき上位だけを軽く返す。
//
// このOSの目的は成約で、ホームは「今日どの相手に何をするか」から始まるべき。
// 機能の棚だけ並んでいると、攻める相手を思い出す作業が毎回スクロールになる。
// フル版（対象外にする・全一覧）は /status に残し、ここは抜粋。
//
// 並び順の正（2026-08-10に★を導入）:
//   ① ★の多い順（★3が最優先）
//   ② ★が同じなら、提案がまだの相手を先に
//   ③ それも同じなら、接点が空いている順 → 接点が古い順
//
// 機械的な指標（提案の有無・最終接点）より★を先に見るのが肝。データ上は
// 手つかずでも、いま攻める相手かどうかを決められるのは吉井さんだけで、
// ★はその意思表示だから。★が無い間だけ、機械の判断が前に出る。

export const dynamic = "force-dynamic";

const PRIORITY = "org_priority";

type OrgStatus = {
  name: string;
  meetings: number;
  last_meeting: string | null;
  has_proposal: boolean;
  has_refine: boolean;
};

export type NextTarget = {
  name: string;
  meetings: number;
  last_meeting: string | null;
  has_proposal: boolean;
  /** 最終接点から30日超。/status の「間が空いている」と同じ線。 */
  stale: boolean;
  /** 1..3。0＝未設定。 */
  stars: number;
};

const STALE_DAYS = 30;
const LIMIT = 5;

async function loadPriority(c: { url: string; key: string }): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(`${c.url}/rest/v1/${PRIORITY}?select=org_name,stars&limit=2000`, {
      headers: restHeaders(c.key),
      cache: "no-store",
    });
    if (res.ok) {
      for (const r of (await res.json()) as { org_name: string; stars: number }[]) {
        map.set(r.org_name, r.stars);
      }
    }
  } catch (err) {
    // ★が読めなくても一覧は出す（付随情報で本体を止めない）。
    console.error("GET /api/next-targets: 優先順位の取得に失敗", err);
  }
  return map;
}

export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  // ?all=true で全件返す（優先順位を付ける画面用）。既定はホーム用の抜粋。
  const showAll = new URL(req.url).searchParams.get("all") === "true";

  try {
    const [res, priority] = await Promise.all([
      fetch(`${c.url}/rest/v1/rpc/dashboard_stats`, {
        method: "POST",
        headers: {
          apikey: c.key,
          Authorization: `Bearer ${c.key}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        cache: "no-store",
      }),
      loadPriority(c),
    ]);
    if (!res.ok) {
      return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
    }
    const stats = await res.json();
    const rows: OrgStatus[] = Array.isArray(stats?.org_status) ? stats.org_status : [];

    const now = Date.now();
    const isStale = (last: string | null) => {
      if (!last) return false; // 接点が無いのは「間が空いた」とは別の状態
      const t = new Date(last).getTime();
      return Number.isFinite(t) && now - t > STALE_DAYS * 24 * 3600 * 1000;
    };

    const all: NextTarget[] = rows
      .map((o) => ({
        name: o.name,
        meetings: o.meetings,
        last_meeting: o.last_meeting,
        has_proposal: o.has_proposal,
        stale: isStale(o.last_meeting),
        stars: priority.get(o.name) ?? 0,
      }))
      .sort((a, b) => {
        if (a.stars !== b.stars) return b.stars - a.stars; // ★3が先頭
        if (a.has_proposal !== b.has_proposal) return a.has_proposal ? 1 : -1;
        if (a.stale !== b.stale) return a.stale ? -1 : 1;
        return (a.last_meeting ?? "9999") < (b.last_meeting ?? "9999") ? -1 : 1;
      });

    return NextResponse.json({
      targets: showAll ? all : all.slice(0, LIMIT),
      total: all.length,
      starred: all.filter((t) => t.stars > 0).length,
    });
  } catch (err) {
    console.error("GET /api/next-targets: 取得エラー", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 502 });
  }
}

// ★の設定。{ name, stars }（0 で解除）
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { name?: unknown; stars?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const stars = typeof body.stars === "number" ? Math.round(body.stars) : NaN;
  if (!name) return NextResponse.json({ error: "団体名が必要です" }, { status: 400 });
  if (!Number.isFinite(stars) || stars < 0 || stars > 3) {
    return NextResponse.json({ error: "★は0〜3で指定してください" }, { status: 400 });
  }

  try {
    // 0 は「未設定に戻す」。1〜3のCHECK制約があるので行ごと消す
    // （0を保存できるようにすると「★0」と「未設定」の2つの無印ができてしまう）。
    if (stars === 0) {
      const del = await fetch(
        `${c.url}/rest/v1/${PRIORITY}?org_name=eq.${encodeURIComponent(name)}`,
        { method: "DELETE", headers: restHeaders(c.key), cache: "no-store" }
      );
      if (!del.ok) {
        return NextResponse.json({ error: `解除に失敗 ${del.status}` }, { status: 502 });
      }
      return NextResponse.json({ ok: true, stars: 0 });
    }

    const res = await fetch(`${c.url}/rest/v1/${PRIORITY}?on_conflict=org_name`, {
      method: "POST",
      headers: restHeaders(c.key, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        org_name: name,
        stars,
        updated_at: new Date().toISOString(),
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("PATCH /api/next-targets: 保存失敗", res.status, detail.slice(0, 300));
      return NextResponse.json({ error: `保存失敗 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, stars });
  } catch (err) {
    console.error("PATCH /api/next-targets: 例外", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 502 });
  }
}
