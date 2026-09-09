import { NextRequest, NextResponse } from "next/server";

import { AnthropicNotConfiguredError } from "@/lib/anthropic";
import { DbNotConfiguredError, select, selectOne, update } from "@/lib/db";
import { activeCriteria, scoreJob } from "@/lib/fit";
import type { CareerCriterion, CareerJob, FitResult } from "@/lib/types";

// 適合診断。判断軸の閲覧・重み変更（GET/PATCH）と、求人1件の深掘り再採点（POST）。
//
// GET   /api/fit          → 判断軸の一覧＋求人の選択肢
// PATCH /api/fit          → body: { id, weight?, active? }
// POST  /api/fit          → body: { job_id } で Opus 5 による深掘り再採点
//
// 深掘り再採点は Opus 5 を使うため 1〜2分かかることがある。
// Vercel の関数タイムアウト既定（10秒/60秒）では途中で切れるので上限を延ばす。
export const maxDuration = 120;

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 再採点する求人を選ぶプルダウン用。全文は要らないので最小限の列だけ。 */
export type FitJobOption = Pick<
  CareerJob,
  "id" | "company" | "title" | "fit_score" | "status" | "fit_scored_at"
>;

export type FitGetResponse = {
  criteria: CareerCriterion[];
  jobs: FitJobOption[];
};

export type FitPostResponse = {
  job: Pick<CareerJob, "id" | "company" | "title">;
  result: FitResult & { model: string };
};

function fail(err: unknown, fallback: string) {
  console.error("/api/fit:", err);
  if (err instanceof DbNotConfiguredError || err instanceof AnthropicNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  const message = err instanceof Error ? err.message : fallback;
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET() {
  try {
    const [criteria, jobs] = await Promise.all([
      // 無効化した軸も一覧には出す（重みを戻せるように）。並びは sort_order。
      select<CareerCriterion>("career_criteria", "select=*&order=sort_order.asc"),
      // 再採点の候補。判断が済んだもの（見送り・アーカイブ）は選択肢から外す。
      select<FitJobOption>(
        "career_jobs",
        "select=id,company,title,fit_score,status,fit_scored_at" +
          "&status=not.in.(declined,archived)&order=fit_score.desc.nullslast&limit=200"
      ),
    ]);
    const body: FitGetResponse = { criteria, jobs };
    return NextResponse.json(body);
  } catch (err) {
    return fail(err, "判断軸の取得に失敗しました");
  }
}

export async function PATCH(req: NextRequest) {
  let body: { id?: unknown; weight?: unknown; active?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("PATCH /api/fit: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  // 更新対象は必ず id で1件に絞る。
  const id = typeof body.id === "string" ? body.id : "";
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "判断軸のIDが指定されていないか、形式が不正です" },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.weight !== undefined) {
    const weight = Number(body.weight);
    // 重みは 1〜5。プロンプト側が「重み n/5」と書くので、この範囲を外れると採点が壊れる。
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
      return NextResponse.json({ error: "重みは1〜5の整数で指定してください" }, { status: 400 });
    }
    patch.weight = weight;
  }

  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      return NextResponse.json({ error: "有効／無効の値が不正です" }, { status: 400 });
    }
    patch.active = body.active;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "更新する項目がありません" }, { status: 400 });
  }

  try {
    // career_criteria に updated_at 列は無いので、ここでは付けない。
    const rows = await update<CareerCriterion>("career_criteria", `id=eq.${id}`, patch);
    if (rows.length === 0) {
      return NextResponse.json({ error: "該当する判断軸が見つかりませんでした" }, { status: 404 });
    }
    return NextResponse.json({ row: rows[0] });
  } catch (err) {
    return fail(err, "判断軸の更新に失敗しました");
  }
}

export async function POST(req: NextRequest) {
  let body: { job_id?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/fit: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json(
      { error: "再採点する求人が選ばれていないか、IDの形式が不正です" },
      { status: 400 }
    );
  }

  try {
    const job = await selectOne<CareerJob>("career_jobs", `select=*&id=eq.${jobId}`);
    if (!job) {
      return NextResponse.json({ error: "該当する求人が見つかりませんでした" }, { status: 404 });
    }

    const criteria = await activeCriteria();
    if (criteria.length === 0) {
      return NextResponse.json(
        { error: "有効な判断軸が1件もありません。上の判断軸を有効にしてから再採点してください" },
        { status: 400 }
      );
    }

    const result = await scoreJob(job, { deep: true, criteria });

    // 採点結果を求人に書き戻す。
    // breakdown（判断軸ごとの内訳）は career_jobs に列が無いため保存せず、
    // この画面での表示用にレスポンスだけで返す。
    await update<CareerJob>("career_jobs", `id=eq.${job.id}`, {
      fit_score: result.score,
      fit_summary: result.summary,
      fit_pros: result.pros,
      fit_cons: result.cons,
      fit_model: result.model,
      fit_scored_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const payload: FitPostResponse = {
      job: { id: job.id, company: job.company, title: job.title },
      result,
    };
    return NextResponse.json(payload);
  } catch (err) {
    return fail(err, "再採点に失敗しました");
  }
}
