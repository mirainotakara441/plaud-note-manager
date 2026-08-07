import { NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";

// ホームの「🎯 次に攻める相手」。/status の「次に攻める団体」から、いま手を
// 付けるべき上位だけを軽く返す。
//
// このOSの目的は成約で、ホームは「今日どの相手に何をするか」から始まるべき。
// 機能の棚だけ並んでいると、攻める相手を思い出す作業が毎回スクロールになる。
// フル版（対象外にする・全一覧）は /status に残し、ここは読み取り専用の抜粋。
//
// 並べ方は /status と同じ思想：提案がまだの団体を先に、次に接点が古い順。
// 「攻めるべき」の定義を2か所で別々に育てない（食い違うと信用されなくなる）。

export const dynamic = "force-dynamic";

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
};

const STALE_DAYS = 30;
const LIMIT = 3;

export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  try {
    const res = await fetch(`${c.url}/rest/v1/rpc/dashboard_stats`, {
      method: "POST",
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });
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

    const targets: NextTarget[] = rows
      .map((o) => ({
        name: o.name,
        meetings: o.meetings,
        last_meeting: o.last_meeting,
        has_proposal: o.has_proposal,
        stale: isStale(o.last_meeting),
      }))
      .sort((a, b) => {
        // 提案がまだ → 間が空いている → 接点が古い順。
        if (a.has_proposal !== b.has_proposal) return a.has_proposal ? 1 : -1;
        if (a.stale !== b.stale) return a.stale ? -1 : 1;
        return (a.last_meeting ?? "9999") < (b.last_meeting ?? "9999") ? -1 : 1;
      })
      .slice(0, LIMIT);

    return NextResponse.json({ targets, total: rows.length });
  } catch (err) {
    console.error("GET /api/next-targets: 取得エラー", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 502 });
  }
}
