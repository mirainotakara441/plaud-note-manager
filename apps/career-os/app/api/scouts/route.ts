import { NextRequest, NextResponse } from "next/server";

import { DbNotConfiguredError, select, update } from "@/lib/db";
import type { CareerRecruiter, CareerScout, ReplyStatus, ScoutWithRecruiter } from "@/lib/types";

// スカウト受信箱の読み取り（GET）と返信ステータスの更新（PATCH）。
//
// GET /api/scouts?filter=pending|all
// PATCH /api/scouts  body: { id, reply_status, note? }
//
// この画面の目的は「返信漏れを潰すこと」なので、並び順が仕様の中心。
// 未返信を先頭に、受信が古いもの（＝放置日数が長いもの）から順に並べる。

export const dynamic = "force-dynamic";

/** 一度に読む上限。受信箱を全部見るための画面なので多めに取る。 */
const LIMIT = 200;

const REPLY_STATUSES: ReplyStatus[] = ["pending", "replied", "declined", "ignored"];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * スカウトに担当ヘッドハンターを結合する。
 *
 * PostgREST の埋め込み（`select=*,career_recruiters(...)`）は外部キー制約に依存し、
 * 無ければ 400 で落ちる。ここは落ちないことを優先し、別クエリで引いて突き合わせる。
 * （app/api/home-stats/route.ts にも同じ意図の関数がある。片方だけ直さないこと。）
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

/**
 * 並べ替え。
 *   1. 未返信（pending）を必ず先頭へ
 *   2. 未返信の中は受信が古い順（経過日数の降順）＝放置が長いものほど上
 *   3. 返信済み等は新しい順（履歴として見るだけなので）
 * 受信日時が無いものは各グループの最後に置く。
 */
function sortForInbox(rows: ScoutWithRecruiter[]): ScoutWithRecruiter[] {
  return [...rows].sort((a, b) => {
    const aPending = a.reply_status === "pending" ? 0 : 1;
    const bPending = b.reply_status === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;

    const at = a.received_at ? Date.parse(a.received_at) : NaN;
    const bt = b.received_at ? Date.parse(b.received_at) : NaN;
    const aOk = Number.isFinite(at);
    const bOk = Number.isFinite(bt);
    if (!aOk && !bOk) return 0;
    if (!aOk) return 1;
    if (!bOk) return -1;

    return aPending === 0 ? at - bt : bt - at;
  });
}

function fail(err: unknown, fallback: string) {
  console.error("/api/scouts:", err);
  if (err instanceof DbNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  const message = err instanceof Error ? err.message : fallback;
  return NextResponse.json({ error: message }, { status: 500 });
}

export type ScoutsResponse = {
  rows: ScoutWithRecruiter[];
  /** 未返信の件数。フィルタが「全部」でも常に全体の未返信数を返す。 */
  pending: number;
};

export async function GET(req: NextRequest) {
  const onlyPending = req.nextUrl.searchParams.get("filter") !== "all";
  const filter = onlyPending ? "&reply_status=eq.pending" : "";

  try {
    const raw = await select<CareerScout>(
      "career_scouts",
      `select=*&order=received_at.desc.nullslast&limit=${LIMIT}${filter}`
    );
    const rows = sortForInbox(await attachRecruiters(raw));
    const pending = onlyPending
      ? rows.length
      : rows.filter((r) => r.reply_status === "pending").length;

    const body: ScoutsResponse = { rows, pending };
    return NextResponse.json(body);
  } catch (err) {
    return fail(err, "スカウトの取得に失敗しました");
  }
}

export async function PATCH(req: NextRequest) {
  let body: { id?: unknown; reply_status?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("PATCH /api/scouts: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  // 更新対象は必ず id で1件に絞る。
  const id = typeof body.id === "string" ? body.id : "";
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "スカウトIDが指定されていないか、形式が不正です" },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.reply_status !== undefined) {
    if (
      typeof body.reply_status !== "string" ||
      !REPLY_STATUSES.includes(body.reply_status as ReplyStatus)
    ) {
      return NextResponse.json({ error: "返信ステータスの値が不正です" }, { status: 400 });
    }
    patch.reply_status = body.reply_status;
    // 「返信した」を押した時刻を返信日時として残す。取り消したら消す。
    patch.replied_at = body.reply_status === "replied" ? new Date().toISOString() : null;
  }

  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== "string") {
      return NextResponse.json({ error: "メモの形式が不正です" }, { status: 400 });
    }
    const trimmed = typeof body.note === "string" ? body.note.slice(0, 4000).trim() : "";
    patch.note = trimmed === "" ? null : trimmed;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "更新する項目がありません" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  try {
    const rows = await update<CareerScout>("career_scouts", `id=eq.${id}`, patch);
    if (rows.length === 0) {
      return NextResponse.json({ error: "該当するスカウトが見つかりませんでした" }, { status: 404 });
    }
    return NextResponse.json({ row: rows[0] });
  } catch (err) {
    return fail(err, "スカウトの更新に失敗しました");
  }
}
