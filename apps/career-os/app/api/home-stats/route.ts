import { NextResponse } from "next/server";

import { DbNotConfiguredError, count, select, selectOne } from "@/lib/db";
import type {
  CareerIngestRun,
  CareerJob,
  CareerRecruiter,
  CareerScout,
  ScoutWithRecruiter,
} from "@/lib/types";

// ホーム（作戦盤）用の集計API。読み取り専用で、書き込みは一切しない。
//
// 返すもの:
//   - 今週の数字4つ（新着求人・未返信スカウト・本命候補・気になる）
//   - 未返信で日数が経っているスカウト 上位3件
//   - 適合スコア上位の求人 3件
//   - 最終取込の実行記録（career_ingest_runs の最新）
//
// 設計方針: Promise.allSettled で個別に取り、1つ失敗しても他は出す。
// テーブルが空・取込がまだ・一部だけ落ちている、のどれでもホームが白くならないようにする。
// 失敗したものは errors[] に日本語で積み、UI側で控えめに出す。

export const dynamic = "force-dynamic";

/** 求人プレビューに必要な列だけ。ホームで全文は要らない。 */
export type HomeJobPreview = Pick<
  CareerJob,
  | "id"
  | "company"
  | "title"
  | "salary_min"
  | "salary_max"
  | "salary_text"
  | "location"
  | "source"
  | "status"
  | "fit_score"
  | "fit_summary"
>;

export type HomeStats = {
  counts: {
    /** 過去7日に初めて見つかった求人の件数 */
    new_jobs_7d: number;
    /** 未返信（reply_status=pending）のスカウト件数。0でないと目立たせる */
    pending_scouts: number;
    /** 適合スコア85以上＝本命候補 */
    top_fit: number;
    /** ステータスが「気になる」の求人 */
    interested: number;
  };
  /** 未返信スカウトのうち、受信が古い順に3件 */
  stale_scouts: ScoutWithRecruiter[];
  /** 適合スコアの高い順に3件 */
  top_jobs: HomeJobPreview[];
  last_ingest: {
    finished_at: string | null;
    started_at: string;
    new_jobs: number;
    new_scouts: number;
    error: string | null;
  } | null;
  /** 部分的に取得できなかった項目の日本語メッセージ */
  errors: string[];
};

const JOB_PREVIEW_COLUMNS =
  "id,company,title,salary_min,salary_max,salary_text,location,source,status,fit_score,fit_summary";

/**
 * スカウトに担当ヘッドハンターを結合する。
 *
 * PostgREST の埋め込み（`select=*,career_recruiters(...)`）は外部キー制約の有無に
 * 依存し、無い場合は 400 で落ちる。ここは「落ちない」ことを優先して、
 * recruiter_id を集めて別クエリで引き、JS側で突き合わせる。
 */
async function attachRecruiters(scouts: CareerScout[]): Promise<ScoutWithRecruiter[]> {
  const ids = Array.from(
    new Set(scouts.map((s) => s.recruiter_id).filter((v): v is string => typeof v === "string"))
  );
  if (ids.length === 0) {
    return scouts.map((s) => ({ ...s, recruiter: null }));
  }

  type Rec = Pick<CareerRecruiter, "id" | "name" | "company" | "rank">;
  const recruiters = await select<Rec>(
    "career_recruiters",
    `select=id,name,company,rank&id=in.(${ids.join(",")})`
  );
  const byId = new Map(recruiters.map((r) => [r.id, r]));
  return scouts.map((s) => ({
    ...s,
    recruiter: s.recruiter_id ? byId.get(s.recruiter_id) ?? null : null,
  }));
}

/** 7日前のISO日時。PostgREST の gte フィルタにそのまま渡せる形。 */
function sevenDaysAgoIso(): string {
  return new Date(Date.now() - 7 * 86_400_000).toISOString();
}

export async function GET() {
  const [
    newJobs,
    pendingScouts,
    topFit,
    interested,
    staleScouts,
    topJobs,
    lastIngest,
  ] = await Promise.allSettled([
    count("career_jobs", `first_seen_at=gte.${sevenDaysAgoIso()}`),
    count("career_scouts", "reply_status=eq.pending"),
    count("career_jobs", "fit_score=gte.85"),
    count("career_jobs", "status=eq.interested"),
    // 未返信のうち受信が古いもの＝放置日数が長いものから3件。
    // received_at が null の行は最後に回す（日数を出せないため）。
    select<CareerScout>(
      "career_scouts",
      "select=*&reply_status=eq.pending&order=received_at.asc.nullslast&limit=3"
    ).then(attachRecruiters),
    // 見送り・アーカイブ済みは作戦盤に出さない（もう判断が済んでいるため）。
    select<HomeJobPreview>(
      "career_jobs",
      `select=${JOB_PREVIEW_COLUMNS}&fit_score=not.is.null&status=not.in.(declined,archived)` +
        "&order=fit_score.desc.nullslast&limit=3"
    ),
    selectOne<CareerIngestRun>(
      "career_ingest_runs",
      "select=*&finished_at=not.is.null&order=finished_at.desc"
    ),
  ]);

  const errors: string[] = [];

  // 設定漏れ（Supabase未設定）だけは全項目が同じ理由で落ちるので、
  // 同じ文言が4つも5つも並ばないよう重複を潰してから積む。
  function unwrap<T>(r: PromiseSettledResult<T>, fallback: T, what: string): T {
    if (r.status === "fulfilled") return r.value;
    console.error(`GET /api/home-stats: ${what} の取得に失敗`, r.reason);
    const detail = r.reason instanceof Error ? r.reason.message : String(r.reason);
    const msg =
      r.reason instanceof DbNotConfiguredError ? detail : `${what}を取得できませんでした（${detail}）`;
    if (!errors.includes(msg)) errors.push(msg);
    return fallback;
  }

  const run = unwrap(lastIngest, null, "最終取込");

  const body: HomeStats = {
    counts: {
      new_jobs_7d: unwrap(newJobs, 0, "新着求人"),
      pending_scouts: unwrap(pendingScouts, 0, "未返信スカウト"),
      top_fit: unwrap(topFit, 0, "本命候補"),
      interested: unwrap(interested, 0, "気になる求人"),
    },
    stale_scouts: unwrap(staleScouts, [], "未返信スカウト一覧"),
    top_jobs: unwrap(topJobs, [], "適合スコア上位"),
    last_ingest: run
      ? {
          finished_at: run.finished_at,
          started_at: run.started_at,
          new_jobs: run.new_jobs,
          new_scouts: run.new_scouts,
          error: run.error,
        }
      : null,
    errors,
  };

  return NextResponse.json(body);
}
