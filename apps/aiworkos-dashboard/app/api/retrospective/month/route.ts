import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { documentKey } from "@/lib/organizations";

// 「その月に何をしたか」を、書いた振り返りではなく**残っている記録**から組む。
//
// 月次の振り返りは月末に書くもので、書いていない月は空になる。だが記録そのものは
// 毎日溜まっている（週報・会議・成果物・日記）。振り返りを書くときも、読み返すときも、
// 要るのは「その月に実際に何があったか」なので、そちらを機械的に集めて返す。
//
// 生成AIは使わない。ここは事実を並べる場所で、要約はしない
// （月報ドラフト /monthly-report が既にAIで書く役をやっている。二重に持たない）。

export const dynamic = "force-dynamic";

type WeeklyRow = {
  week_start: string;
  category: string;
  organization: string | null;
  summary: string | null;
  insight: string | null;
  tactic: string | null;
};

type ChunkRow = {
  source_type: string;
  title: string;
  organization: string | null;
  event_date: string | null;
};

export type MonthActivity = {
  month: string; // YYYY-MM
  start: string;
  end: string;
  weekly: WeeklyRow[];
  /** カテゴリー別の件数。多い順。 */
  byCategory: { category: string; count: number }[];
  /** その月に動いた団体。週報・会議・成果物のどれかに出てきたもの。 */
  organizations: { name: string; weeks: number; meetings: number; deliverables: number }[];
  counts: { weekly: number; meetings: number; deliverables: number; diaries: number };
  /** 宿題（tactic）が書かれた行。次の月に持ち越す材料。 */
  tactics: { organization: string | null; tactic: string }[];
};

/** その月の末日。月をまたぐ計算をここ1か所に閉じる。 */
function monthRange(month: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const start = `${m[1]}-${m[2]}-01`;
  // 翌月0日＝当月末日。UTCで組むのでタイムゾーンでずれない。
  const endDate = new Date(Date.UTC(y, mo, 0));
  return { start, end: endDate.toISOString().slice(0, 10) };
}

export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const month = new URL(req.url).searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) {
    return NextResponse.json({ error: "monthは YYYY-MM で指定してください" }, { status: 400 });
  }
  const { start, end } = range;

  try {
    // 週報は「その週の月曜」で持っている。月内に始まる週を対象にする
    // （月をまたぐ週は始まった側の月に数える。1つの週を2つの月で二重に数えない）。
    const [weeklyRes, chunkRes] = await Promise.all([
      fetch(
        `${c.url}/rest/v1/weekly_reports?select=week_start,category,organization,summary,insight,tactic` +
          `&week_start=gte.${start}&week_start=lte.${end}&order=week_start.asc,category.asc&limit=500`,
        { headers: restHeaders(c.key), cache: "no-store" }
      ),
      fetch(
        `${c.url}/rest/v1/memory_chunks?select=source_type,title,organization,event_date` +
          `&event_date=gte.${start}&event_date=lte.${end}&limit=3000`,
        { headers: restHeaders(c.key), cache: "no-store" }
      ),
    ]);

    const weekly: WeeklyRow[] = weeklyRes.ok ? await weeklyRes.json() : [];
    const chunks: ChunkRow[] = chunkRes.ok ? await chunkRes.json() : [];

    // 会議・成果物はチャンク単位で入っている（1会議＝複数行）。文書に束ねて実数にする。
    //
    // 以前は title.split("｜")[0] だけで束ねており、日付も団体も見ていなかった。
    // そのため別の日の同名会議が1件に潰れ（会議で40件の取りこぼし）、逆に
    // チャンク接尾辞が残る成果物は1チャンク＝1文書に化けて過大計上していた。
    // 束ね方は lib/organizations.ts の documentKey() に集約してある
    // （groupMeetings / groupDeliverables と同じ stripChunkSuffix を使う）。
    const uniqTitles = (type: string) =>
      new Set(chunks.filter((r) => r.source_type === type).map(documentKey));

    const byCategory = Object.entries(
      weekly.reduce<Record<string, number>>((acc, r) => {
        acc[r.category] = (acc[r.category] ?? 0) + 1;
        return acc;
      }, {})
    )
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    // 団体ごとの登場回数。週報の週数・会議数・成果物数を並べる。
    const orgs = new Map<string, { weeks: Set<string>; meetings: Set<string>; deliverables: Set<string> }>();
    const touch = (name: string) => {
      if (!orgs.has(name)) {
        orgs.set(name, { weeks: new Set(), meetings: new Set(), deliverables: new Set() });
      }
      return orgs.get(name)!;
    };
    for (const r of weekly) {
      if (r.organization) touch(r.organization).weeks.add(r.week_start);
    }
    for (const r of chunks) {
      if (!r.organization) continue;
      const base = documentKey(r);
      if (r.source_type === "会議") touch(r.organization).meetings.add(base);
      if (r.source_type === "成果物") touch(r.organization).deliverables.add(base);
    }

    const organizations = Array.from(orgs.entries())
      .map(([name, v]) => ({
        name,
        weeks: v.weeks.size,
        meetings: v.meetings.size,
        deliverables: v.deliverables.size,
      }))
      .sort(
        (a, b) =>
          b.weeks + b.meetings + b.deliverables - (a.weeks + a.meetings + a.deliverables) ||
          a.name.localeCompare(b.name, "ja")
      );

    const body: MonthActivity = {
      month,
      start,
      end,
      weekly,
      byCategory,
      organizations,
      counts: {
        weekly: weekly.length,
        meetings: uniqTitles("会議").size,
        deliverables: uniqTitles("成果物").size,
        diaries: uniqTitles("日記").size,
      },
      tactics: weekly
        .filter((r) => r.tactic && r.tactic.trim() !== "")
        .map((r) => ({ organization: r.organization, tactic: r.tactic! })),
    };

    return NextResponse.json(body);
  } catch (err) {
    console.error("GET /api/retrospective/month: 取得エラー", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 502 });
  }
}
