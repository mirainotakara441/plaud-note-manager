import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// 健康週次レポート（/health の「週次レポート」）の保存と読み出し。
//
// ■ 日々の数値はここで扱わない
//   体重・食事・歩数は /api/health?from&to（Edge Function 経由）が返す。
//   ここが持つのは**人が入れたぶんだけ**——★評価・コメント・備考と、
//   確定した本文。数値と評価を1本のAPIに混ぜると、数値の取得が遅いときに
//   評価の保存まで巻き添えで落ちる。
//
// ■ 書きも読みも service role
//   health_weekly_reports は RLS 有効でポリシー0本。health_metrics と同じく
//   健康データは anon に開けていない。anon へ SELECT を許す誘惑があるが、
//   体重も食事も個人の機微情報なので、サーバー側でだけ触る。
//
//   GET            … 保存済みの週の一覧（週の選択肢に使う）
//   GET ?start=... … その週の保存済みレポート1件（無ければ report: null）
//   PUT            … { week_start, week_end, ratings, notes, body } を upsert
//   DELETE ?start= … 1週ぶん取り消し

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TABLE = "health_weekly_reports";
const COLUMNS = "id,week_start,week_end,ratings,notes,advice,body,created_at,updated_at";
/** 本文と備考の上限。画面のテキストエリアと合わせた常識的な上限。 */
const MAX_TEXT = 20000;

function missingEnv() {
  return NextResponse.json(
    { error: "サーバー設定エラー: 書き込み用のキーが設定されていません" },
    { status: 500 }
  );
}

export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return missingEnv();

  const start = req.nextUrl.searchParams.get("start");
  if (start && !DAY_RE.test(start)) {
    return NextResponse.json({ error: "週の開始日の形式が不正です" }, { status: 400 });
  }

  try {
    // 週を指定されたらその1件、指定が無ければ保存済みの週だけを一覧で返す。
    // 一覧に本文まで載せると、週が増えたときに無駄に重くなる。
    const path = start
      ? `${TABLE}?select=${COLUMNS}&week_start=eq.${start}`
      : `${TABLE}?select=week_start,week_end,updated_at&order=week_start.desc`;

    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      headers: restHeaders(c.key),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`週次レポートの取得に失敗しました（${res.status}）${detail.slice(0, 120)}`);
    }
    const rows = await res.json();
    return start
      ? NextResponse.json({ report: rows[0] ?? null })
      : NextResponse.json({ weeks: rows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return missingEnv();

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const b = (payload ?? {}) as Record<string, unknown>;
  const weekStart = typeof b.week_start === "string" ? b.week_start : "";
  const weekEnd = typeof b.week_end === "string" ? b.week_end : "";
  if (!DAY_RE.test(weekStart) || !DAY_RE.test(weekEnd)) {
    return NextResponse.json({ error: "週の範囲が不正です" }, { status: 400 });
  }
  if (weekEnd < weekStart) {
    return NextResponse.json({ error: "週の終わりが始まりより前になっています" }, { status: 400 });
  }

  // ratings は { 指標: { stars, comment } }。想定外の形なら丸ごと落とす
  // （画面から来る値しか入らないが、壊れた形をDBへ通すと読む側が毎回身構える）。
  const ratings: Record<string, { stars?: number; comment?: string }> = {};
  if (b.ratings && typeof b.ratings === "object") {
    for (const [k, v] of Object.entries(b.ratings as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      const stars = Number(r.stars);
      const comment = typeof r.comment === "string" ? r.comment.slice(0, 500) : "";
      const entry: { stars?: number; comment?: string } = {};
      if (Number.isInteger(stars) && stars >= 1 && stars <= 5) entry.stars = stars;
      if (comment.trim() !== "") entry.comment = comment;
      if (entry.stars || entry.comment) ratings[k.slice(0, 40)] = entry;
    }
  }

  const notes = typeof b.notes === "string" ? b.notes.slice(0, MAX_TEXT) : null;
  const advice = typeof b.advice === "string" ? b.advice.slice(0, MAX_TEXT) : null;
  const body = typeof b.body === "string" ? b.body.slice(0, MAX_TEXT) : null;

  try {
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?on_conflict=week_start&select=${COLUMNS}`,
      {
        method: "POST",
        headers: restHeaders(c.key, {
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify([
          {
            week_start: weekStart,
            week_end: weekEnd,
            ratings,
            notes,
            advice,
            body,
            updated_at: new Date().toISOString(),
          },
        ]),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`週次レポートの保存に失敗しました（${res.status}）${detail.slice(0, 160)}`);
    }
    const rows = await res.json();
    return NextResponse.json({ report: rows[0] ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存に失敗しました" },
      { status: 502 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return missingEnv();

  const start = req.nextUrl.searchParams.get("start");
  if (!start || !DAY_RE.test(start)) {
    return NextResponse.json({ error: "週の開始日が不正です" }, { status: 400 });
  }

  try {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?week_start=eq.${start}`, {
      method: "DELETE",
      headers: restHeaders(c.key),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`取り消しに失敗しました（${res.status}）${detail.slice(0, 120)}`);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取り消しに失敗しました" },
      { status: 502 }
    );
  }
}
