import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders, type Creds } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

// ホームの「鮮度の盤面」の中身。読み取り専用。
//
// データの出どころは Supabase の code_session_snapshots だけ。セッションの実体は
// 吉井さんのMacの中にあり、Vercelからは読めない。ローカルの進捗（しんちょく）が
// 毎晩22:30に走査してここへupsertした行を、そのまま読んで返す。
//
// 出す/出さないの線引き:
//   ・進捗率(%)やスコアは出さない。セッションに「完了」の定義が無く、測れない。
//     出せるのは経過日数（鮮度）と止まり方（中断）だけ。
//   ・「昨日から動いた本数」は、前日ちょうどのスナップショットがある日だけ出す。
//     2日前としか比べられないのに「昨日から」と書いたらそれは嘘になる。
//   ・今日のスナップショットが無い日は、古い行を今日の状態として出さない。
//     snapshot_date をそのまま返し、画面側で「最終取得 MM/DD」と言わせる。
//   ・セッション名には案件名がそのまま入るので、service role でサーバー側からのみ読む。
//
// 画面からの操作（PATCH）は code_session_prefs に書く。code_session_snapshots へ
// 直接書いてはいけない——あちらは毎晩の走査が (snapshot_date, session_id) で upsert し直す
// ので、盤面から消したつもりが翌朝には戻る。prefs は日付を持たないので走査と衝突しない。

export const dynamic = "force-dynamic";

const PREFS_TABLE = "code_session_prefs";

type PrefRow = { session_id: string; hidden: boolean; pinned: boolean | null };

type Row = {
  snapshot_date: string;
  session_id: string;
  title: string;
  cwd_label: string;
  last_activity_at: string | null;
  days_idle: number | string | null;
  is_pinned: boolean;
  is_archived: boolean;
  is_stalled: boolean;
  last_event: string;
};

export type BoardSession = {
  id: string;
  title: string;
  place: string;
  /** 走査時点で最後に動いてからの日数。読めなかった場合は null。 */
  days_idle: number | null;
  last_activity_at: string | null;
  last_event: string;
  pinned: boolean;
  stalled: boolean;
};

export type BoardResponse = {
  /** JSTの今日。画面が「今日の盤面かどうか」を判定するために返す。 */
  today: string;
  /** 実際に読めたスナップショットの日付。1件も無ければ null。 */
  snapshot_date: string | null;
  sessions: BoardSession[];
  /** 前日ちょうどのスナップショットと比べて、最終更新が進んだ本数。比べられない日は null。 */
  moved_since_prev: number | null;
  /** 比較に使った前日の日付。null なら比較していない。 */
  prev_date: string | null;
  error?: string;
};

const COLUMNS =
  "snapshot_date,session_id,title,cwd_label,last_activity_at,days_idle,is_pinned,is_archived,is_stalled,last_event";

/**
 * 「中断」と呼ぶ範囲。進捗のレポート①と同じ窓にそろえてある。
 *
 * DBの is_stalled は「最後のイベントが未完了で終わっている」という事実だけを持つので、
 * 5ヶ月前に途中で投げたものにも立つ。それを毎朝「中断」として橙で数え続けると、
 * 手を戻せる範囲の中断が、戻すつもりのない古い残骸に埋もれる。
 *
 * 窓の外に出たものは中断として数えないだけで、盤面からは消えない。
 * いちばん薄い藍のマス＝放置として、そのまま面積に残る。
 */
const STALLED_WINDOW_DAYS = 14;

async function getRows(c: Creds, query: string): Promise<Row[]> {
  const res = await fetch(`${c.url}/rest/v1/code_session_snapshots?${query}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `code_session_snapshots取得失敗 ${res.status}: ${detail.slice(0, 200)}`
    );
  }
  return (await res.json()) as Row[];
}

/** YYYY-MM-DD の1日前。UTC 00:00 として解釈するのでTZでぶれない。 */
function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const today = toJstDateString(new Date().toISOString());

  try {
    const latest = await getRows(
      c,
      "select=snapshot_date&order=snapshot_date.desc&limit=1"
    );
    const snapshot_date: string | null = latest[0]?.snapshot_date ?? null;

    if (!snapshot_date) {
      const empty: BoardResponse = {
        today,
        snapshot_date: null,
        sessions: [],
        moved_since_prev: null,
        prev_date: null,
      };
      return NextResponse.json(empty);
    }

    const prevCandidate = dayBefore(snapshot_date);
    const rows = await getRows(
      c,
      `select=${COLUMNS}&snapshot_date=in.(${snapshot_date},${prevCandidate})&limit=2000`
    );

    const current = rows.filter((r) => r.snapshot_date === snapshot_date);
    const previous = rows.filter((r) => r.snapshot_date === prevCandidate);

    // 画面から付けた設定を重ねる。取れなくても盤面は出す（設定は付随情報）。
    const prefs = new Map<string, PrefRow>();
    try {
      const res = await fetch(
        `${c.url}/rest/v1/${PREFS_TABLE}?select=session_id,hidden,pinned&limit=5000`,
        { headers: restHeaders(c.key), cache: "no-store" }
      );
      if (res.ok) {
        for (const p of (await res.json()) as PrefRow[]) prefs.set(p.session_id, p);
      }
    } catch (err) {
      console.error("GET /api/code-sessions: prefs取得失敗", err);
    }

    // アーカイブ（走査側）と、画面から消したもの（prefs.hidden）は盤面に出さない。
    const sessions: BoardSession[] = current
      .filter((r) => !r.is_archived && !prefs.get(r.session_id)?.hidden)
      .map((r) => {
        const days_idle = toNumber(r.days_idle);
        return {
          id: r.session_id,
          title: r.title || "（無題）",
          place: r.cwd_label || "—",
          days_idle,
          last_activity_at: r.last_activity_at,
          last_event: r.last_event || "",
          // prefs.pinned が null なら走査結果に従う（画面で触っていないもの）。
          pinned: prefs.get(r.session_id)?.pinned ?? r.is_pinned,
          // 経過が読めないものは中断として数えない（判定できないものは判定しない）。
          stalled:
            r.is_stalled && days_idle !== null && days_idle <= STALLED_WINDOW_DAYS,
        };
      })
      .sort((a, b) => {
        const av = a.days_idle ?? Number.POSITIVE_INFINITY;
        const bv = b.days_idle ?? Number.POSITIVE_INFINITY;
        return av - bv || a.title.localeCompare(b.title, "ja");
      });

    // 前日ちょうどのスナップショットがある日だけ「昨日から動いた本数」を出す。
    // 進捗が1日走らなかった日は黙る（比べられないものを比べたことにしない）。
    let moved_since_prev: number | null = null;
    let prev_date: string | null = null;
    if (previous.length > 0) {
      prev_date = prevCandidate;
      const before = new Map(previous.map((r) => [r.session_id, r.last_activity_at]));
      moved_since_prev = current.filter((r) => {
        if (r.is_archived) return false;
        const was = before.get(r.session_id);
        if (was === undefined) return true; // 前日に無かった＝この1日で生まれた
        return (r.last_activity_at ?? "") > (was ?? "");
      }).length;
    }

    const body: BoardResponse = {
      today,
      snapshot_date,
      sessions,
      moved_since_prev,
      prev_date,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("GET /api/code-sessions: 取得エラー", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

// 盤面の手動設定。{ session_id, hidden?, pinned? }
//
// hidden=true は「盤面から消す」。セッションの実体（Macの中の会話）には一切触らない。
// 消したいのは見え方であって記録ではないので、行を削除せず hidden で伏せる
// （消し過ぎたときに戻せないと、盤面を触るのが怖くなる）。
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { session_id?: unknown; hidden?: unknown; pinned?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  if (!sessionId) {
    return NextResponse.json({ error: "session_id が必要です" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { session_id: sessionId, updated_at: new Date().toISOString() };
  if (typeof body.hidden === "boolean") patch.hidden = body.hidden;
  // pinned は null を「走査結果に従う」の意味で受け付ける。
  if (typeof body.pinned === "boolean" || body.pinned === null) patch.pinned = body.pinned;
  if (!("hidden" in patch) && !("pinned" in patch)) {
    return NextResponse.json({ error: "変更する項目がありません" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${c.url}/rest/v1/${PREFS_TABLE}?on_conflict=session_id`,
      {
        method: "POST",
        headers: restHeaders(c.key, { Prefer: "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify(patch),
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("PATCH /api/code-sessions: 保存失敗", res.status, detail.slice(0, 300));
      return NextResponse.json({ error: `保存失敗 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/code-sessions: 例外", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 502 });
  }
}
