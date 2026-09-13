import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { isLlmConfigured, llmErrorMessage, llmErrorStatus, DEFAULT_MODEL } from "@/lib/llm";
import { jstToday } from "@/lib/advisor/types";
import { collectMaterials, renderMaterials, tooThin } from "@/lib/nightAdvisor/collect";
import { think } from "@/lib/nightAdvisor/think";

// 夜間参謀の実行口。設計: docs/night-advisor-design.md
//
// ■ どこから叩かれるか
//   本番は Mac の launchd（毎晩23:00・ジョブ名 yakan-sanbo）から
//   ローカルの Next.js を叩く。★Vercel 経由にしない★
//   Vercel Hobby の maxDuration は60秒で、領域横断で読んで考える処理は収まらない。
//   収めようとすると思考を切るか材料を削ることになり、どちらも出来を落とす。
//   既に thinking:false を明示している箇所がリポジトリに7つあるのが、その前例。
//
// ■ 3つのモード（設計 §7 の関門をコードで表現している）
//   preview … 材料を集めるだけ。LLMを呼ばず、渡す予定のテキストをそのまま返す
//   dry     … 集めて考えるが、DBには書かない（既定）
//   save    … 考えた結果を insights へ保存する
//
//   既定を dry にしているのは意図的。いきなり毎晩保存を始めると、質の悪い示唆が
//   溜まって insights 自体が信用されなくなり、後から立て直せない。
//   3晩ぶん dry で出して吉井さんと線を決めてから、launchd に save で登録する。

export const dynamic = "force-dynamic";
// ローカル実行が前提なので Vercel の上限は効かないが、
// 万一 Vercel 側に置かれたときに黙って切れないよう明示しておく。
export const maxDuration = 300;

const COOKIE_NAME = "aiworkos_auth";
const TABLE = "insights";

// launchd（CRON_SECRET）と、ブラウザからの手動実行（合言葉cookie）の両方を許す。
// notion-sync と同じ形。手動で試せないと、関門2・3（目視確認と3晩ぶんの試行）が回せない。
async function authorized(req: NextRequest): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && req.headers.get("authorization") === `Bearer ${cronSecret}`) {
    return true;
  }
  const passphrase = process.env.APP_PASSPHRASE;
  if (passphrase && passphrase.trim() !== "") {
    const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
    if (constantTimeEqual(cookie, await cookieValueFor(passphrase))) return true;
  }
  return false;
}

type Mode = "preview" | "dry" | "save";

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const mode: Mode =
    body?.mode === "preview" || body?.mode === "save" ? body.mode : "dry";
  // 日付を指定できるようにしておく。過去の晩を再現して出来を比べたいときに要る。
  const today =
    typeof body?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
      ? body.today
      : jstToday(new Date());

  const startedAt = Date.now();

  try {
    const materials = await collectMaterials(c, today);

    const counts = {
      日記: materials.diaries.length,
      会議: materials.meetings.length,
      週報: materials.weekly.length,
      健康: materials.health.length,
      日々ToDo: materials.actions.length,
      戦略ToDo: materials.todos.length,
      振り返り: materials.retros.length,
      過去の示唆: materials.pastInsights.length,
      相談: materials.asks.length,
    };

    if (mode === "preview") {
      const rendered = renderMaterials(materials);
      return NextResponse.json({
        mode,
        today,
        counts,
        failed: materials.failed,
        chars: rendered.length,
        thin: tooThin(materials),
        materials: rendered,
        ms: Date.now() - startedAt,
      });
    }

    const thin = tooThin(materials);
    if (thin) {
      return NextResponse.json({ mode, today, counts, error: thin }, { status: 400 });
    }

    if (!isLlmConfigured()) {
      return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
    }

    const result = await think(materials);

    if (mode === "dry") {
      return NextResponse.json({
        mode,
        today,
        counts,
        failed: materials.failed,
        model: DEFAULT_MODEL,
        ...result,
        ms: Date.now() - startedAt,
      });
    }

    // ---- save ----------------------------------------------------------
    // 同じ日に2回走らせたときに二重に積まないよう、その日のぶんを入れ替える。
    // 示唆そのものはやり直しが効くが、人の判断（verdict）は失いたくない。
    // まだ判断が付いていない行だけを消す。
    const del = await fetch(
      `${c.url}/rest/v1/${TABLE}?generated_on=eq.${today}&verdict=is.null`,
      { method: "DELETE", headers: restHeaders(c.key) }
    );
    if (!del.ok) {
      const detail = await del.text().catch(() => "");
      throw new Error(`当日分の入れ替えに失敗しました（${del.status}）${detail.slice(0, 200)}`);
    }

    const rows = result.insights.map((i) => ({
      generated_on: today,
      kind: i.kind,
      title: i.title,
      body: i.body,
      evidence: i.evidence ?? [],
      related_orgs: i.related_orgs ?? [],
      // 空文字は「新規」の意味。uuid列にはnullで入れる。
      continues_id: i.continues_id && i.continues_id.length > 20 ? i.continues_id : null,
      model: DEFAULT_MODEL,
    }));

    if (rows.length > 0) {
      const ins = await fetch(`${c.url}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: restHeaders(c.key, { Prefer: "return=minimal" }),
        body: JSON.stringify(rows),
      });
      if (!ins.ok) {
        const detail = await ins.text().catch(() => "");
        throw new Error(`示唆の保存に失敗しました（${ins.status}）${detail.slice(0, 200)}`);
      }
    }

    // 成功の心拍を打つ。止まったことに気づけるようにする（lib/advisor/watchlist.ts が見る）。
    // 失敗側（kind:"fail" と exit_code）は launchd のラッパーが打つ——終了コードを
    // 知っているのはあちらなので。ここは「走って最後まで通った」ことだけを記録する。
    // service_health 用の record_heartbeat とは別物なので取り違えないこと。
    await fetch(`${c.url}/rest/v1/rpc/record_job_heartbeats`, {
      method: "POST",
      headers: restHeaders(c.key),
      body: JSON.stringify({
        events: [
          {
            job: "yakan-sanbo",
            at: new Date().toISOString(),
            kind: "ok",
            note: `示唆${rows.length}件`,
          },
        ],
      }),
    }).catch(() => {});

    return NextResponse.json({
      mode,
      today,
      counts,
      failed: materials.failed,
      model: DEFAULT_MODEL,
      saved: rows.length,
      note: result.note,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("夜間参謀:", err);
    return NextResponse.json(
      { error: llmErrorMessage(err, err instanceof Error ? err.message : "夜間参謀の実行に失敗しました") },
      { status: llmErrorStatus(err) }
    );
  }
}

// 画面（ホームの参謀カード）が読む口。既定はその日のぶん。
export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const url = new URL(req.url);
  const day = url.searchParams.get("day");
  const today = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : jstToday(new Date());

  try {
    // その日のぶんが無ければ、直近で出ている日のぶんを出す。
    // Macを閉じていて夜間参謀が走らなかった朝に、カードが空になるのを避けるため
    // （空だと「示唆が無い」のか「走らなかった」のか区別できない）。
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=*&generated_on=lte.${today}` +
        `&order=generated_on.desc,created_at.asc&limit=20`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      // insights 表がまだ無い環境では静かに空を返す（カードを出さないだけ）。
      return NextResponse.json({ day: null, insights: [], available: false });
    }
    const all = (await res.json()) as { generated_on: string }[];
    const latest = all[0]?.generated_on ?? null;
    return NextResponse.json({
      day: latest,
      stale: latest ? latest < today : false,
      insights: all.filter((r) => r.generated_on === latest),
      available: true,
    });
  } catch {
    return NextResponse.json({ day: null, insights: [], available: false });
  }
}

// 人の判断を記録する。採用/見送り/的外れ の3ボタン。
// ここが自己改善の燃料になる——翌晩の参謀がこの判断と理由を読む。
export async function PATCH(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id : "";
  const verdict = body?.verdict;
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  if (verdict !== null && !["adopted", "deferred", "off_target"].includes(verdict)) {
    return NextResponse.json({ error: "verdictが不正です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      verdict,
      verdict_at: verdict ? new Date().toISOString() : null,
      verdict_note: typeof body?.note === "string" ? body.note.slice(0, 500) : null,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `保存に失敗しました（${res.status}）${detail.slice(0, 200)}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
