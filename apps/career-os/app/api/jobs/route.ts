import { NextRequest, NextResponse } from "next/server";

import { DbNotConfiguredError, count, select, update } from "@/lib/db";
import type { CareerJob, JobSource, JobStatus } from "@/lib/types";

// 求人一覧の読み取り（GET）とステータス・メモの更新（PATCH）。
//
// GET /api/jobs?sort=fit&status=all&source=all&salary_min=1000&q=SaaS&offset=0
// PATCH /api/jobs  body: { id, status?, note? }
//
// service role キーは lib/db.ts の中だけで使い、ブラウザには一切出さない。
// 認証は proxy.ts の合言葉ゲートに任せているので、ここでの追加認証は不要。

export const dynamic = "force-dynamic";

/** 1ページあたりの件数。件数が多くなるので「もっと読む」で継ぎ足す。 */
const PAGE_SIZE = 50;

const JOB_STATUSES: JobStatus[] = [
  "new",
  "interested",
  "casual",
  "applied",
  "screening",
  "final",
  "offer",
  "declined",
  "archived",
];

const JOB_SOURCES: JobSource[] = ["doda_x", "eight", "bizreach", "recruit", "other"];

/** 並べ替えの選択肢。UI の値とここのキーを一致させること。 */
const SORTS: Record<string, string> = {
  // 既定。未採点（null）は後ろへ回し、同点なら新しく見た順。
  fit: "fit_score.desc.nullslast,last_seen_at.desc",
  new: "first_seen_at.desc",
  salary: "salary_max.desc.nullslast,salary_min.desc.nullslast",
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * フリーワードから PostgREST のフィルタ構文で意味を持つ記号を落とす。
 *
 * `,` `(` `)` `"` `*` はフィルタの区切り・ワイルドカードとして解釈されるため、
 * そのまま渡すとクエリが壊れる（あるいは意図しない条件になる）。
 */
function sanitizeWord(raw: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/[,()"'*\\%&=]/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * 絞り込み条件を PostgREST のクエリ片（& 区切り）に組み立てる。
 * 一覧と件数カウントの両方で同じ条件を使うため、関数に切り出している。
 */
function buildFilters(sp: URLSearchParams): string {
  const parts: string[] = [];
  // OR で結ぶ条件グループ。2つ以上になったら and=(or(...),or(...)) で入れ子にする。
  const orGroups: string[] = [];

  const status = sp.get("status");
  if (status && status !== "all" && JOB_STATUSES.includes(status as JobStatus)) {
    parts.push(`status=eq.${status}`);
  }

  const source = sp.get("source");
  if (source && source !== "all" && JOB_SOURCES.includes(source as JobSource)) {
    parts.push(`source=eq.${source}`);
  }

  // 年収下限: 上限・下限のどちらかがこの額に届いていれば残す
  // （片方しか埋まっていない求人が多いため、AND にすると取りこぼす）。
  const salaryMin = Number(sp.get("salary_min"));
  if (Number.isFinite(salaryMin) && salaryMin > 0) {
    orGroups.push(`salary_max.gte.${salaryMin},salary_min.gte.${salaryMin}`);
  }

  const q = sanitizeWord(sp.get("q"));
  if (q !== "") {
    orGroups.push(`company.ilike.*${q}*,title.ilike.*${q}*`);
  }

  if (orGroups.length === 1) {
    parts.push(`or=(${orGroups[0]})`);
  } else if (orGroups.length > 1) {
    parts.push(`and=(${orGroups.map((g) => `or(${g})`).join(",")})`);
  }

  return parts.join("&");
}

function fail(err: unknown, fallback: string) {
  console.error("/api/jobs:", err);
  if (err instanceof DbNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  const message = err instanceof Error ? err.message : fallback;
  return NextResponse.json({ error: message }, { status: 500 });
}

export type JobsResponse = {
  rows: CareerJob[];
  /** 絞り込み後の総件数（「もっと読む」の残数表示に使う） */
  total: number;
  has_more: boolean;
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const sortKey = sp.get("sort") ?? "fit";
  const order = SORTS[sortKey] ?? SORTS.fit;

  const offsetRaw = Number(sp.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const filters = buildFilters(sp);
  const filterQuery = filters === "" ? "" : `&${filters}`;

  try {
    const [rows, total] = await Promise.all([
      select<CareerJob>(
        "career_jobs",
        `select=*&order=${order}&limit=${PAGE_SIZE}&offset=${offset}${filterQuery}`
      ),
      count("career_jobs", filters),
    ]);

    const body: JobsResponse = {
      rows,
      total,
      has_more: offset + rows.length < total,
    };
    return NextResponse.json(body);
  } catch (err) {
    return fail(err, "求人一覧の取得に失敗しました");
  }
}

export async function PATCH(req: NextRequest) {
  let body: { id?: unknown; status?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("PATCH /api/jobs: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  // 更新対象は必ず id で1件に絞る。id の形が uuid でなければここで弾く。
  const id = typeof body.id === "string" ? body.id : "";
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "求人IDが指定されていないか、形式が不正です" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !JOB_STATUSES.includes(body.status as JobStatus)) {
      return NextResponse.json({ error: "ステータスの値が不正です" }, { status: 400 });
    }
    patch.status = body.status;
  }

  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== "string") {
      return NextResponse.json({ error: "メモの形式が不正です" }, { status: 400 });
    }
    // 空文字は null に寄せる（「メモなし」の表現をDB側で1つに保つ）。
    const trimmed = typeof body.note === "string" ? body.note.slice(0, 4000).trim() : "";
    patch.note = trimmed === "" ? null : trimmed;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "更新する項目がありません" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  try {
    const rows = await update<CareerJob>("career_jobs", `id=eq.${id}`, patch);
    if (rows.length === 0) {
      return NextResponse.json({ error: "該当する求人が見つかりませんでした" }, { status: 404 });
    }
    return NextResponse.json({ row: rows[0] });
  } catch (err) {
    return fail(err, "求人の更新に失敗しました");
  }
}
