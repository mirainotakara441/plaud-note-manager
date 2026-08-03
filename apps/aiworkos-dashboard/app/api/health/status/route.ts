import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// 取り込み状況（health_metrics に何が・いつ・どこから入っているか）。
//
// 目的:
//   Health Auto Export / HealthPlanet / カロミル からの取り込みが生きているかを
//   吉井さん自身がこの画面だけで確認できるようにする。グラフだけ見ていると
//   「値は出ているが中身が別物になっている」状態に気づけない。
//
// このAPIがやること / やらないこと:
//   やる   … 指標ごとの「最終取得日・取得元・直近の値」と、事実として言える異変
//            （何日も更新が無い／同じ指標の一部のソースだけ止まっている／
//              人の1日の値としてありえない範囲に入っている）を返す。
//   やらない… 原因の断定。「連携が切れた」「設定が変わった」等は、このデータだけでは
//            区別できないので書かない。判断材料（いつ・どのソースが・いくつ）だけ出す。
//
// health_metrics のRLSは authenticated 限定なので service role キーで読む。

export const dynamic = "force-dynamic";

const TABLE = "health_metrics";

/** 既定の観測窓。/health の最長レンジ（180日）より短いが、指標の生死判定には十分。 */
const DEFAULT_WINDOW_DAYS = 90;

// 「何日も更新が無い」の線引き。指標によって自然な間隔が違う（体組成計は毎日乗るが
// 栄養は食事を記録した日だけ）ので、断定せず段階で出す。
const STALE_WARN_DAYS = 3;
const STALE_ALERT_DAYS = 7;

// 同じ指標に複数のソースがある場合に、片方だけ止まっているとみなす日数差。
const SOURCE_DROP_GAP_DAYS = 7;

// 人の1日の値として、あきらかに範囲外と言い切れるものだけを入れる。
// 「少ない/多い」ではなく「1日の値として説明がつかない」レベルに限定する。
// ここに無い指標は値の妥当性を判定しない（判定できないものを判定しない）。
// 「1日ぶんの合計」であるはずの指標には下限を必ず置く。2026-08-03に見つけた
// 歩数の件（取り込み側が1日の合計でなく1サンプルあたりの平均を保存していて、
// 4,874歩の日が42.4として入っていた）は、この下限があったから気づけた。
// 同じ壊れ方をしても値そのものは残るので、止まった検知だけでは拾えない。
const PLAUSIBLE_RANGE: Record<string, { min: number; max: number; note: string }> = {
  step_count: { min: 500, max: 80000, note: "1日の合計歩数" },
  walking_running_distance: { min: 0.2, max: 60, note: "1日の合計移動距離(km)" },
  active_energy: { min: 100, max: 30000, note: "1日の活動エネルギー(kJ)" },
  basal_energy_burned: { min: 3000, max: 15000, note: "1日の基礎代謝(kJ)" },
  dietary_energy: { min: 400, max: 25000, note: "1日の摂取エネルギー(kJ)" },
  body_mass: { min: 30, max: 200, note: "体重(kg)" },
  weight_body_mass: { min: 30, max: 200, note: "体重(kg)" },
  body_fat_percentage: { min: 3, max: 60, note: "体脂肪率(%)" },
  body_mass_index: { min: 10, max: 60, note: "BMI" },
};

// 画面に出す日本語ラベル。ここに無い metric は生のキーをそのまま出す
// （新しい指標が増えても一覧から漏れないようにするため、ホワイトリストにはしない）。
const METRIC_LABELS: Record<string, string> = {
  step_count: "歩数",
  weight_body_mass: "体重(HealthPlanet)",
  body_mass: "体重(Apple Health)",
  body_fat_percentage: "体脂肪率",
  body_mass_index: "BMI",
  dietary_energy: "摂取エネルギー",
  active_energy: "活動エネルギー",
  basal_energy_burned: "基礎代謝",
  walking_running_distance: "歩行・走行距離",
  walking_speed: "歩行速度",
  walking_step_length: "歩幅",
  walking_asymmetry_percentage: "歩行の非対称性",
  walking_double_support_percentage: "両脚支持時間",
  flights_climbed: "上った階数",
  protein: "たんぱく質",
  total_fat: "脂質",
  carbohydrates: "炭水化物",
  fiber: "食物繊維",
  dietary_sugar: "糖類",
  sodium: "ナトリウム",
  sleep_hours: "睡眠時間（手入力）",
  morning_walk: "朝の散歩（手入力）",
  business_trip: "出張（手入力）",
};

// 手入力ぶんは「更新が無い＝入れていない日がある」だけで異常ではないので、
// 停滞アラートの対象から外す（一覧には出す）。
const MANUAL_SOURCE = "manual";

type Row = { day: string; metric: string; source: string; value: number | null };

type SourceStat = {
  source: string;
  lastDay: string;
  lastValue: number | null;
  count: number;
  /** 窓内の中央値。直近値だけだとブレるので水準の目安として添える */
  median: number | null;
  /** その指標全体の最終取得日から何日遅れているか */
  behindDays: number;
};

type MetricStat = {
  metric: string;
  label: string;
  unit: string | null;
  lastDay: string;
  lastValue: number | null;
  lastSource: string;
  staleDays: number;
  count: number;
  sources: SourceStat[];
  /** 事実として提示する気づき。原因は書かない */
  notes: string[];
  severity: "ok" | "warn" | "alert";
  manual: boolean;
};

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms = Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd);
  return Math.round(ms / 86400000);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 桁が大きい値は丸めて出す（43.4歩の「.4」に意味は無い） */
function tidy(v: number | null): number | null {
  if (v == null) return null;
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}

export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const rawDays = Number(req.nextUrl.searchParams.get("days"));
  const windowDays =
    Number.isFinite(rawDays) && rawDays >= 14 && rawDays <= 365 ? Math.floor(rawDays) : DEFAULT_WINDOW_DAYS;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1));
  const from = fromDate.toISOString().slice(0, 10);

  // 単位は指標ごとに固定なので、行ごとに持たず後で1件拾えば足りる。
  // 40指標 × 90日 ≒ 数千行。1画面ぶんの一覧を作るには十分軽い。
  const params = [
    "select=day,metric,source,value,unit",
    `day=gte.${from}`,
    "order=day.desc",
    "limit=20000",
  ];
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.join("&")}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("取り込み状況の取得に失敗:", res.status, t.slice(0, 200));
    return NextResponse.json({ error: "取り込み状況の取得に失敗しました" }, { status: 502 });
  }
  const rows: (Row & { unit: string | null })[] = await res.json();

  // metric > source の順に畳む
  const byMetric = new Map<
    string,
    { unit: string | null; bySource: Map<string, { days: string[]; values: number[] }> }
  >();
  for (const r of Array.isArray(rows) ? rows : []) {
    const m = byMetric.get(r.metric) ?? { unit: r.unit ?? null, bySource: new Map() };
    if (!m.unit && r.unit) m.unit = r.unit;
    const s = m.bySource.get(r.source) ?? { days: [], values: [] };
    s.days.push(r.day);
    if (r.value != null) s.values.push(Number(r.value));
    m.bySource.set(r.source, s);
    byMetric.set(r.metric, m);
  }

  const metrics: MetricStat[] = [];
  for (const [metric, m] of byMetric) {
    const sources: SourceStat[] = [];
    let lastDay = "";
    let lastSource = "";
    let lastValue: number | null = null;
    let count = 0;

    for (const [source, s] of m.bySource) {
      // day.desc で取っているので先頭が最新
      const sLastDay = s.days[0];
      const sLastValue = s.values.length ? s.values[0] : null;
      count += s.days.length;
      sources.push({
        source,
        lastDay: sLastDay,
        lastValue: tidy(sLastValue),
        count: s.days.length,
        median: tidy(median(s.values)),
        behindDays: 0, // 全体の最終日が決まってから埋める
      });
      if (!lastDay || sLastDay > lastDay) {
        lastDay = sLastDay;
        lastSource = source;
        lastValue = sLastValue;
      }
    }

    for (const s of sources) s.behindDays = daysBetween(lastDay, s.lastDay);
    sources.sort((a, b) => (a.lastDay < b.lastDay ? 1 : a.lastDay > b.lastDay ? -1 : 0));

    const staleDays = daysBetween(todayStr, lastDay);
    const manual = m.bySource.has(MANUAL_SOURCE) && m.bySource.size === 1;

    const notes: string[] = [];
    let severity: MetricStat["severity"] = "ok";

    // (1) 更新が止まっている（手入力は「入れていないだけ」なので対象外）
    if (!manual) {
      if (staleDays >= STALE_ALERT_DAYS) {
        notes.push(`${staleDays}日間、新しいデータが入っていません（最終 ${lastDay}）。`);
        severity = "alert";
      } else if (staleDays >= STALE_WARN_DAYS) {
        notes.push(`${staleDays}日間、新しいデータが入っていません（最終 ${lastDay}）。`);
        severity = "warn";
      }
    }

    // (2) 同じ指標のうち、一部のソースだけ止まっている。
    //     ここが今回いちばん効く検出。値は出ているので折れ線は途切れないが、
    //     中身の出どころが入れ替わっている状態を事実として拾う。
    for (const s of sources) {
      if (s.behindDays >= SOURCE_DROP_GAP_DAYS) {
        notes.push(
          `「${s.source}」由来のデータが ${s.lastDay} 以降入っていません（他のソースの記録は ${lastDay} まで続いています）。`
        );
        severity = "alert";
      }
    }

    // (3) 人の1日の値として説明のつかない範囲に入っている
    const range = PLAUSIBLE_RANGE[metric];
    if (range && lastValue != null && (lastValue < range.min || lastValue > range.max)) {
      notes.push(
        `直近の値 ${tidy(lastValue)} は、${range.note}として想定される範囲（${range.min}〜${range.max}）の外にあります。`
      );
      severity = "alert";
    }

    metrics.push({
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      unit: m.unit,
      lastDay,
      lastValue: tidy(lastValue),
      lastSource,
      staleDays,
      count,
      sources,
      notes,
      severity,
      manual,
    });
  }

  // 気になるものを先頭に。同じ深刻度なら、指摘が多い＝手掛かりが多いものを先に出す
  // （歩数のように「ソースが入れ替わった」と「値が範囲外」が同時に立つものを埋もれさせない）。
  // それも同じなら最終取得が古い順。
  const rank = { alert: 0, warn: 1, ok: 2 } as const;
  metrics.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      b.notes.length - a.notes.length ||
      b.staleDays - a.staleDays
  );

  return NextResponse.json({
    from,
    to: todayStr,
    windowDays,
    metrics,
    summary: {
      total: metrics.length,
      alert: metrics.filter((m) => m.severity === "alert").length,
      warn: metrics.filter((m) => m.severity === "warn").length,
    },
    // 画面側で言い回しを揃えるための注記。原因の断定はここでもしない。
    disclaimer:
      "この一覧は health_metrics に入っている記録の事実だけを出しています。原因（書き出し設定・端末側の状態など）はここでは判定していません。",
  });
}
