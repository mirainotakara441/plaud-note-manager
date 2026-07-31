import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

// 一行日記の登録状況（直近N日分）を返す読み取り専用API。
// /diary ページを開いた時点で「過去何日ぶん登録済みか」を一目で分かるようにするため、
// Notion APIより速くレート制限も無い Supabase memory_chunks(source_type=日記) の
// event_date を判定に使う（依頼の指定どおり）。
//
// 注意: memory_chunks は RLS で anon の SELECT を許可していない（ポリシー無し＝
// anonは常に0件）ため、他の読み取り箇所（app/api/cron/daily-todo/route.ts、
// lib/organizations.ts）と同じく serviceCreds() を使う。anonCreds() だと
// 常に空配列が返り、実際は登録済みでも全日「未」表示になってしまう
// （2026-07-31 確認: pg_policies に memory_chunks 向けの行が無いことをSupabase側で確認済み）。

export const dynamic = "force-dynamic";

type StatusEntry = {
  date: string;
  registered: boolean;
  isToday: boolean;
};

type StatusResponse = {
  today: string;
  days: number;
  entries: StatusEntry[];
  latestDate: string | null;
  staleDays: number | null;
  error?: string;
};

const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;

// 日付文字列（YYYY-MM-DD）に対して日数を加減算する。UTC正午基準で計算し、
// ローカルタイムゾーンの影響で日付がずれることを避ける（app/api/home-stats/route.ts
// の jstMondayOf と同じ考え方）。
function addDaysUTC(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// today を含む直近n日ぶんの日付を古い→新しい順で返す。
function lastNDates(todayStr: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(addDaysUTC(todayStr, -i));
  }
  return out;
}

// 日付文字列同士の差分日数（app/api/cron/daily-todo/route.ts の daysBetween と同じ）。
function daysBetween(laterDateStr: string, earlierDateStr: string): number {
  const later = new Date(`${laterDateStr}T00:00:00Z`).getTime();
  const earlier = new Date(`${earlierDateStr}T00:00:00Z`).getTime();
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

function parseDays(req: NextRequest): number {
  const raw = Number(req.nextUrl.searchParams.get("days"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DAYS;
  return Math.min(Math.floor(raw), MAX_DAYS);
}

export async function GET(req: NextRequest) {
  const service = serviceCreds();
  if (!service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  const days = parseDays(req);
  const today = toJstDateString(new Date().toISOString());
  const dateList = lastNDates(today, days);

  // 表示ウィンドウ外の途絶検知（例: 直近が2週間前で表示は1週間分だけ、というケースでも
  // 「滞っている」ことは分かるようにしたい）のため、日数指定より少し多めに取得する。
  const fetchLimit = Math.max(days + 14, 60);

  try {
    const res = await fetch(
      `${service.url}/rest/v1/memory_chunks?select=event_date&source_type=eq.${encodeURIComponent(
        "日記"
      )}&event_date=not.is.null&order=event_date.desc&limit=${fetchLimit}`,
      { headers: restHeaders(service.key), cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`memory_chunks取得失敗 ${res.status}: ${detail.slice(0, 200)}`);
    }
    const rows: { event_date: string | null }[] = await res.json();
    const dateSet = new Set(rows.map((r) => r.event_date).filter((d): d is string => !!d));
    const latestDate = rows[0]?.event_date ?? null;

    const entries: StatusEntry[] = dateList.map((d) => ({
      date: d,
      registered: dateSet.has(d),
      isToday: d === today,
    }));

    const staleDays = latestDate ? daysBetween(today, latestDate) : null;

    const body: StatusResponse = { today, days, entries, latestDate, staleDays };
    return NextResponse.json(body);
  } catch (error) {
    console.error("GET /api/diary/status:", error);
    return NextResponse.json({ error: "登録状況の取得に失敗しました" }, { status: 502 });
  }
}
