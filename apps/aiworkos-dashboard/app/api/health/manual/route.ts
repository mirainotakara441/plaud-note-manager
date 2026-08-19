import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";

// 手入力の健康記録（睡眠・朝の散歩・出張）。
//
// なぜ手入力か:
//   iPhone の Health Auto Export では睡眠データが取れないことが確定している。
//   散歩・出張はそもそも Apple Health に無い概念。効率は悪いが「データとして残す」
//   ことを優先し、この3つだけ手で入れる。
//
// なぜ新テーブルを作らないか:
//   health_metrics は (day, metric, value, unit, source) の汎用テーブルで、
//   metric を足すだけで新しい指標を持てる設計になっている。専用テーブルを作ると
//   /health の集計・取り込み状況の一覧が二重管理になるので、既存テーブルに寄せる。
//   自動取得ぶんとの区別は source='manual' で付ける。
//
// 二重登録の防止:
//   health_metrics には UNIQUE (metric, day, source) 制約が既にあるので、
//   PostgREST の on_conflict=metric,day,source + Prefer: resolution=merge-duplicates
//   でそのまま upsert できる。同じ日に何度押しても行は増えない。
//
// キーの使い分け:
//   health_metrics のRLSは authenticated ロールにしかSELECTを許していないため、
//   読み取りも書き込みも service role キーが要る（このファイルはサーバー側でのみ動く）。

export const dynamic = "force-dynamic";

const TABLE = "health_metrics";
// 自動取得ぶん（Apple Health / HealthPlanet / カロミル …）と区別するための印。
// route.ts は Next.js が export を検査する（GET/POST/dynamic 等以外を export すると
// 型エラーになる）ので、共有したい値でもここから export はしない。
const MANUAL_SOURCE = "manual";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 手入力で扱う metric の定義。ここに無いものは受け付けない
// （health_metrics は自動取り込みと同じテーブルなので、手入力APIから
//   step_count 等の自動取得ぶんを書き換えられないようにホワイトリストで閉じる）。
const MANUAL_METRICS = {
  // 睡眠時間。小数可（6.5時間など）
  sleep_hours: { unit: "時間", min: 0.5, max: 24, label: "睡眠時間" },
  // 朝の散歩をしたか。やった日だけ 1 を入れ、やらなかった日は行を作らない
  morning_walk: { unit: "回", min: 1, max: 1, label: "朝の散歩" },
  // 出張したか。同上
  business_trip: { unit: "日", min: 1, max: 1, label: "出張" },
} as const;

type ManualMetric = keyof typeof MANUAL_METRICS;

const MANUAL_METRIC_KEYS = Object.keys(MANUAL_METRICS) as ManualMetric[];

function isManualMetric(v: unknown): v is ManualMetric {
  return typeof v === "string" && MANUAL_METRIC_KEYS.includes(v as ManualMetric);
}

function inList(): string {
  return `in.(${MANUAL_METRIC_KEYS.join(",")})`;
}

/** 期間内の手入力ぶんを返す。入力済みかどうかを画面で出すために使う。 */
export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const params = [
    "select=day,metric,value,unit,updated_at",
    `metric=${inList()}`,
    `source=eq.${MANUAL_SOURCE}`,
    "order=day.desc",
    "limit=2000",
  ];
  if (from && DAY_RE.test(from)) params.push(`day=gte.${from}`);
  if (to && DAY_RE.test(to)) params.push(`day=lte.${to}`);

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.join("&")}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("手入力記録の取得に失敗:", res.status, t.slice(0, 200));
    return NextResponse.json({ error: "手入力記録の取得に失敗しました" }, { status: 502 });
  }
  const rows: { day: string; metric: string; value: number | null }[] = await res.json();

  // 画面が扱いやすいよう { "2026-08-03": { sleep_hours: 6.5, morning_walk: 1 } } の形に畳む
  const byDay: Record<string, Partial<Record<ManualMetric, number>>> = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isManualMetric(r.metric) || r.value == null) continue;
    (byDay[r.day] ??= {})[r.metric] = Number(r.value);
  }
  return NextResponse.json({ entries: byDay });
}

// 1件の登録・更新・取り消し。
//   { day, metric, value }        … 登録/更新（upsert。同じ日は必ず1行）
//   { day, metric, value: null }  … その日のその記録を消す（トグルOFF）
export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const day = body?.day;
  const metric = body?.metric;

  if (typeof day !== "string" || !DAY_RE.test(day)) {
    return NextResponse.json({ error: "日付の指定が不正です" }, { status: 400 });
  }
  if (!isManualMetric(metric)) {
    return NextResponse.json({ error: "指標の指定が不正です" }, { status: 400 });
  }

  // 未来の日付は事故のもとなので閉じる（前日ぶんを翌朝入れる運用は過去日なので通る）
  const todayStr = toJstDateString(new Date().toISOString());
  if (day > todayStr) {
    return NextResponse.json({ error: "未来の日付には記録できません" }, { status: 400 });
  }

  const where =
    `day=eq.${day}` +
    `&metric=eq.${encodeURIComponent(metric)}` +
    `&source=eq.${MANUAL_SOURCE}`;

  // 取り消し（散歩・出張のトグルOFF、睡眠の記録削除）
  if (body?.value === null) {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?${where}`, {
      method: "DELETE",
      headers: restHeaders(c.key),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `取り消しに失敗 ${res.status}: ${t.slice(0, 200)}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, day, metric, value: null });
  }

  const spec = MANUAL_METRICS[metric];
  const value = Number(body?.value);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return NextResponse.json(
      { error: `${spec.label}は ${spec.min}〜${spec.max} の範囲で入れてください` },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?on_conflict=metric,day,source`, {
    method: "POST",
    headers: restHeaders(c.key, {
      // 既存の UNIQUE (metric, day, source) に当たったら UPDATE に倒す＝同じ日に二重登録されない
      Prefer: "resolution=merge-duplicates,return=representation",
    }),
    body: JSON.stringify({
      day,
      metric,
      value,
      unit: spec.unit,
      source: MANUAL_SOURCE,
      // どこから入れたかを残しておく（後から手入力の経路を追えるように）
      extra: { entered_via: "health-page" },
      updated_at: now,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `保存に失敗 ${res.status}: ${t.slice(0, 200)}` },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, day, metric, value });
}
