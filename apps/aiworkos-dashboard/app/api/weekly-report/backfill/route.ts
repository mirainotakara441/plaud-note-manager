import { NextRequest, NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// 週報を記憶層へ載せる仕組み（2026-08-22）を入れる前に登録済みの週報を、
// あとから memory_chunks(source_type=週報) へ運ぶための一回きりの窓口。
//
// 本体の登録経路（POST /api/weekly-report）と同じ source_id / 本文の組み立てを使う。
// 何度叩いても増殖しない（purge → store の順で入れ替えるため）が、埋め込み生成に
// 時間がかかるので週単位で刻んで実行する。
//
// 使い方: POST /api/weekly-report/backfill { "week": "2026-08-17" }
//         week 省略時は、記憶層にまだ無い週を古い順に1つだけ処理して残数を返す。

export const maxDuration = 60;
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  week_start: string;
  category: string;
  organization: string | null;
  summary: string | null;
  insight: string | null;
  tactic: string | null;
};

function memoryPrefix(id: string): string {
  return `weekly_report:${id}`;
}

function rowToMemoryText(r: Row): string {
  const head = `【${r.week_start}週／${r.category}${r.organization ? `／${r.organization}` : ""}】`;
  const parts = [head];
  if (r.summary) parts.push(`■動き\n${r.summary}`);
  if (r.insight) parts.push(`■反応・示唆\n${r.insight}`);
  if (r.tactic) parts.push(`■次アクション\n${r.tactic}`);
  return parts.join("\n\n");
}

async function storeRow(anon: { url: string; key: string }, r: Row): Promise<boolean> {
  const prefix = memoryPrefix(r.id);
  try {
    await fetch(`${anon.url}/functions/v1/purge-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id_prefix: prefix }),
      cache: "no-store",
    });
    const res = await fetch(`${anon.url}/functions/v1/store-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "週報",
        source_id: `${prefix}:1`,
        organization: r.organization,
        title: `${r.week_start}週｜${r.category}${r.organization ? `｜${r.organization}` : ""}`,
        content: rowToMemoryText(r),
        event_date: r.week_start,
        metadata: {
          種別: "週報",
          カテゴリ: r.category,
          週: r.week_start,
          ...(r.organization ? { 団体: r.organization } : {}),
        },
      }),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === "stored";
  } catch (err) {
    console.error("backfill: 記憶層保存に失敗", err);
    return false;
  }
}

export async function POST(req: NextRequest) {
  const anon = anonCreds();
  if (!anon) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { week?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // 本文なしでの呼び出しを許す（未処理の週を1つ進める用途）。
  }
  const week = typeof body.week === "string" ? body.week.trim() : "";

  // 記憶層に既にある週を調べる（何度叩いても無駄打ちしないため）。
  const doneRes = await fetch(
    `${anon.url}/rest/v1/memory_chunks?select=event_date&source_type=eq.${encodeURIComponent("週報")}`,
    { headers: restHeaders(anon.key), cache: "no-store" }
  );
  if (!doneRes.ok) {
    const detail = await doneRes.text().catch(() => "");
    return NextResponse.json(
      { error: `記憶層の確認に失敗 ${doneRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const doneWeeks = new Set(
    ((await doneRes.json()) as { event_date: string | null }[])
      .map((r) => r.event_date)
      .filter((d): d is string => !!d)
  );

  const allRes = await fetch(
    `${anon.url}/rest/v1/weekly_reports?select=id,week_start,category,organization,summary,insight,tactic&order=week_start.asc`,
    { headers: restHeaders(anon.key), cache: "no-store" }
  );
  if (!allRes.ok) {
    const detail = await allRes.text().catch(() => "");
    return NextResponse.json(
      { error: `週報の取得に失敗 ${allRes.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const all: Row[] = await allRes.json();

  const pendingWeeks = Array.from(new Set(all.map((r) => r.week_start))).filter(
    (w) => !doneWeeks.has(w)
  );

  const target = week || pendingWeeks[0];
  if (!target) {
    return NextResponse.json({ done: true, remaining: 0, message: "未処理の週はありません" });
  }

  const rows = all.filter((r) => r.week_start === target);
  if (rows.length === 0) {
    return NextResponse.json({ error: `${target} 週の週報がありません` }, { status: 404 });
  }

  const results = await Promise.all(rows.map((r) => storeRow(anon, r)));
  const stored = results.filter(Boolean).length;

  return NextResponse.json({
    week: target,
    total: rows.length,
    stored,
    failed: rows.length - stored,
    remaining: pendingWeeks.filter((w) => w !== target).length,
  });
}
