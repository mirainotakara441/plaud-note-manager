import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// AI発信者ウォッチ。/news の右カラムのカードと /news/creators が読む。
//
// 毎朝6時にMac上のClaudeが16名のXアカウントを読み、x-creators-put.py が
// x_creator_runs / x_creator_posts へ書く。ここは読むだけ。
//
// 書き込み口をここに作っていないのは X監視ダイジェスト（x-digest）と同じ理由
// （Xはログイン必須でサーバから取りに行けない。ローカルのスクリプトが直接
// Supabaseへ入れる方が経路が1本で済む）。
//
// x-digest と違って過去の日も見られる（?date=YYYY-MM-DD）。「あの日の勝ち投稿は
// どう書かれていたか」を後から読み返す用途があるため。前後ナビ用に直近30日ぶんの
// 日付も返す。
//
// 「まだ一度も走っていない」「走ったが見られなかった」「走って0件だった」を
// 区別して返す。ここを潰すと、右カラムが毎朝空でも故障に見えなくなる。

export const dynamic = "force-dynamic";

type AccountRow = {
  handle: string;
  display_name: string;
  url: string;
  category: string;
  focus: string | null;
  followers: number | null;
  active: boolean;
};

type RunRow = {
  digest_date: string;
  collected_at: string;
  statuses: Record<string, string> | null;
  headline: string | null;
  trend: string | null;
  lesson: string | null;
  win_pattern: string | null;
  note: string | null;
};

type PostRow = {
  handle: string;
  sort_order: number;
  posted_at: string | null;
  body: string;
  summary: string | null;
  url: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  pattern: string | null;
  why_it_works: string | null;
};

export type CreatorAccount = {
  handle: string;
  displayName: string;
  url: string;
  category: string;
  focus: string | null;
  followers: number | null;
  active: boolean;
};

export type CreatorPost = {
  handle: string;
  sortOrder: number;
  postedAt: string | null;
  body: string;
  summary: string | null;
  url: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  pattern: string | null;
  whyItWorks: string | null;
};

export type CreatorsResponse = {
  /** 一度も収集していなければ null */
  digestDate: string | null;
  collectedAt: string | null;
  statuses: Record<string, string>;
  headline: string | null;
  trend: string | null;
  lesson: string | null;
  winPattern: string | null;
  note: string | null;
  accounts: CreatorAccount[];
  posts: CreatorPost[];
  /** 直近30日ぶんの digest_date（降順）。前後ナビ用 */
  dates: string[];
  error?: string;
};

const EMPTY: CreatorsResponse = {
  digestDate: null,
  collectedAt: null,
  statuses: {},
  headline: null,
  trend: null,
  lesson: null,
  winPattern: null,
  note: null,
  accounts: [],
  posts: [],
  dates: [],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ ...EMPTY, error: "Supabase未設定" }, { status: 500 });

  const wanted = new URL(req.url).searchParams.get("date");
  if (wanted && !DATE_RE.test(wanted)) {
    return NextResponse.json({ ...EMPTY, error: "date は YYYY-MM-DD で指定してください" }, { status: 400 });
  }

  try {
    const h = { headers: restHeaders(c.key), cache: "no-store" as const };

    // 監視対象の一覧と、前後ナビ用の日付はどの日を見ていても同じなので先に取る。
    // 一覧は active=false も返す（過去日の投稿に「今は外した人」が混ざるため、
    // 表示名を引けないと handle の生文字が出る）。
    const [accRes, dateRes] = await Promise.all([
      fetch(
        `${c.url}/rest/v1/x_creator_accounts?select=handle,display_name,url,category,focus,followers,active` +
          `&order=active.desc,added_on.asc,handle.asc`,
        h
      ),
      fetch(`${c.url}/rest/v1/x_creator_runs?select=digest_date&order=digest_date.desc&limit=30`, h),
    ]);
    if (!accRes.ok) {
      return NextResponse.json({ ...EMPTY, error: `取得失敗 ${accRes.status}` }, { status: 502 });
    }
    if (!dateRes.ok) {
      return NextResponse.json({ ...EMPTY, error: `取得失敗 ${dateRes.status}` }, { status: 502 });
    }
    const accRows: AccountRow[] = await accRes.json();
    const dates = ((await dateRes.json()) as { digest_date: string }[]).map((r) => r.digest_date);
    const accounts: CreatorAccount[] = accRows.map((a) => ({
      handle: a.handle,
      displayName: a.display_name,
      url: a.url,
      category: a.category,
      focus: a.focus,
      followers: a.followers,
      active: a.active,
    }));

    // 指定日があればその日、無ければ最新の1回ぶん
    const runRes = await fetch(
      `${c.url}/rest/v1/x_creator_runs?select=digest_date,collected_at,statuses,headline,trend,lesson,win_pattern,note` +
        (wanted ? `&digest_date=eq.${wanted}` : `&order=digest_date.desc`) +
        `&limit=1`,
      h
    );
    if (!runRes.ok) {
      return NextResponse.json({ ...EMPTY, error: `取得失敗 ${runRes.status}` }, { status: 502 });
    }
    const runs: RunRow[] = await runRes.json();
    const run = runs[0];
    // 一度も走っていない／その日は走っていない。accounts と dates は返して、
    // 画面が「誰を見張る予定か」「どの日なら見られるか」を出せるようにする
    if (!run) return NextResponse.json({ ...EMPTY, accounts, dates });

    const postRes = await fetch(
      `${c.url}/rest/v1/x_creator_posts` +
        `?select=handle,sort_order,posted_at,body,summary,url,likes,reposts,replies,pattern,why_it_works` +
        `&digest_date=eq.${run.digest_date}&order=handle.asc,sort_order.asc`,
      h
    );
    if (!postRes.ok) {
      return NextResponse.json({ ...EMPTY, error: `取得失敗 ${postRes.status}` }, { status: 502 });
    }
    const postRows: PostRow[] = await postRes.json();

    return NextResponse.json({
      digestDate: run.digest_date,
      collectedAt: run.collected_at,
      statuses: run.statuses ?? {},
      headline: run.headline,
      trend: run.trend,
      lesson: run.lesson,
      winPattern: run.win_pattern,
      note: run.note,
      accounts,
      posts: postRows.map((p) => ({
        handle: p.handle,
        sortOrder: p.sort_order,
        postedAt: p.posted_at,
        body: p.body,
        summary: p.summary,
        url: p.url,
        likes: p.likes,
        reposts: p.reposts,
        replies: p.replies,
        pattern: p.pattern,
        whyItWorks: p.why_it_works,
      })),
      dates,
    } satisfies CreatorsResponse);
  } catch (err) {
    console.error("GET /api/news/creators: 取得エラー", err);
    return NextResponse.json({ ...EMPTY, error: "取得に失敗しました" }, { status: 502 });
  }
}
