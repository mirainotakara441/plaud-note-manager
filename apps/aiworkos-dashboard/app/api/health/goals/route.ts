import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 健康指標の目標値（health_goals）。吉井さんが画面から設定する。
// 目標は本人が決めるものなので、既定値をこちらで勝手に入れないこと。
// 読み取りは anonキー、書き込みは service role キー（既存APIと同じ流儀）。

export const dynamic = "force-dynamic";

const TABLE = "health_goals";

// DBのCHECK制約と揃えること。ここに足すだけでは書き込みが400で落ちる。
const METRICS = ["weight_kg", "body_fat_pct", "steps", "kcal"] as const;
type Metric = (typeof METRICS)[number];

function isMetric(v: unknown): v is Metric {
  return typeof v === "string" && (METRICS as readonly string[]).includes(v);
}

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?select=metric,target,updated_at`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    // 目標は補助表示。取れなくてもページ本体は出したいので空で返す。
    return NextResponse.json({ goals: {} });
  }
  const rows: { metric: string; target: number; updated_at: string }[] = await res.json();
  const goals: Record<string, number> = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    goals[r.metric] = Number(r.target);
  }
  return NextResponse.json({ goals });
}

// 目標の設定・更新。target に null を渡すと目標を取り消す。
export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const metric = body?.metric;
  if (!isMetric(metric)) {
    return NextResponse.json({ error: "指標の指定が不正です" }, { status: 400 });
  }

  // 目標の取り消し
  if (body?.target === null) {
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?metric=eq.${encodeURIComponent(metric)}`,
      { method: "DELETE", headers: restHeaders(c.key) }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `取り消しに失敗 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, metric, target: null });
  }

  const target = Number(body?.target);
  if (!Number.isFinite(target) || target <= 0) {
    return NextResponse.json({ error: "目標値は正の数で入れてください" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?on_conflict=metric`, {
    method: "POST",
    headers: restHeaders(c.key, {
      Prefer: "resolution=merge-duplicates,return=representation",
    }),
    body: JSON.stringify({ metric, target, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json(
      { error: `保存に失敗 ${res.status}: ${t.slice(0, 200)}` },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, metric, target });
}
