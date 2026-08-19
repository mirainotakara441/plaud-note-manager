import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { runAdvisor } from "@/lib/advisor";
import { jstToday } from "@/lib/advisor/types";
import { isValidCalendarDate } from "@/lib/date";

// ホームの「今朝の気づき」の中身。
//
// 参謀は気づいたことを言うだけで、何も直さない・何も消さない
// （何を直すかは吉井さんが決める。勝手に直すと、直したこと自体に気づけない）。
//
// ただし「見た・消した・いつまでにやる」という人の判断は残す必要がある。
// 気づき本体は毎朝その場で作り直される計算結果なので、判断だけを
// advisor_finding_state に置き、読み出すときに重ねる。
//
// health_metrics など authenticated 限定のテーブルを読むため service role で動く。
// このファイルはサーバー側でのみ実行される（キーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const STATE = "advisor_finding_state";

type StateRow = {
  finding_id: string;
  dismissed_at: string | null;
  due_date: string | null;
};

export async function GET(req: NextRequest) {
  const creds = serviceCreds();
  if (!creds) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  // ?all=true で非表示にしたものも返す（「消したものを見る」用）。
  const showAll = new URL(req.url).searchParams.get("all") === "true";

  const now = new Date();
  try {
    const result = await runAdvisor({ creds, today: jstToday(now), now });

    const state = new Map<string, StateRow>();
    try {
      const res = await fetch(
        `${creds.url}/rest/v1/${STATE}?select=finding_id,dismissed_at,due_date&limit=2000`,
        { headers: restHeaders(creds.key), cache: "no-store" }
      );
      if (res.ok) {
        for (const row of (await res.json()) as StateRow[]) state.set(row.finding_id, row);
      }
    } catch (err) {
      // 手入れが読めなくても気づき自体は出す（付随情報なので本体を止めない）。
      console.error("advisor: 手入れの取得に失敗", err);
    }

    const withState = result.findings.map((f) => {
      const s = state.get(f.id);
      return {
        ...f,
        dismissed: !!s?.dismissed_at,
        due_date: s?.due_date ?? null,
      };
    });

    const visible = showAll ? withState : withState.filter((f) => !f.dismissed);

    return NextResponse.json({
      ...result,
      findings: visible,
      counts: {
        alert: visible.filter((f) => f.severity === "alert").length,
        warn: visible.filter((f) => f.severity === "warn").length,
        info: visible.filter((f) => f.severity === "info").length,
      },
      /** 非表示にしている件数。0でなければ画面に「消したものがある」と出す。 */
      dismissedCount: withState.filter((f) => f.dismissed).length,
    });
  } catch (err) {
    // runAdvisor は検知器ごとの失敗を握るので、ここに来るのは想定外の事故だけ。
    console.error("advisor: 実行に失敗", err);
    return NextResponse.json({ error: "気づきの取得に失敗しました" }, { status: 502 });
  }
}

// 気づき1件への手入れ。{ id, dismissed?, due_date? }
//
// due_date は null を「納期なし」として明示的に受ける（未指定＝変更しない、と区別する）。
export async function PATCH(req: NextRequest) {
  const creds = serviceCreds();
  if (!creds) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { id?: unknown; dismissed?: unknown; due_date?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const patch: Record<string, unknown> = {
    finding_id: id,
    updated_at: new Date().toISOString(),
  };
  if (typeof body.dismissed === "boolean") {
    patch.dismissed_at = body.dismissed ? new Date().toISOString() : null;
  }
  const isDay = (v: unknown): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && isValidCalendarDate(v);
  if (body.due_date === null) {
    patch.due_date = null;
  } else if (body.due_date !== undefined) {
    if (!isDay(body.due_date)) {
      return NextResponse.json({ error: "期限の日付が不正です" }, { status: 400 });
    }
    patch.due_date = body.due_date;
  }

  if (!("dismissed_at" in patch) && !("due_date" in patch)) {
    return NextResponse.json({ error: "変更する項目がありません" }, { status: 400 });
  }

  try {
    const res = await fetch(`${creds.url}/rest/v1/${STATE}?on_conflict=finding_id`, {
      method: "POST",
      headers: restHeaders(creds.key, {
        Prefer: "resolution=merge-duplicates,return=representation",
      }),
      body: JSON.stringify(patch),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("advisor: 手入れの保存に失敗", res.status, detail.slice(0, 300));
      return NextResponse.json({ error: `保存失敗 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("advisor: 手入れの保存で例外", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 502 });
  }
}
