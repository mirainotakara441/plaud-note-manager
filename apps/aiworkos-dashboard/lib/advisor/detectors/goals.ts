// 検知器：立てた目標が、今どうなっているか。
//
// いちばん先に出す分野。判断軸①「健康は全ての土台」に直結するのに、
// 目標を立てた後に見に行かなければ立てたことすら忘れる。
//
// ここでいちばん大事なのは「達成できていない」より先に
// 「そもそも測れる状態になっていない」を言うこと。2026-08-03に見つけた歩数の件
// （取り込みが1日の合計でなく1サンプルあたりの平均を保存していて、実測4,874歩の日が
//  42.4として入っていた）は、値が入っているぶん折れ線は途切れず、
//  達成率だけ見ていると「歩けていない日が続いている」と読み違える。

import { callRpc, getRows } from "../client";
import type { Ctx, Detector, Finding } from "../types";
import { daysAgo, shortDate } from "../types";

/** 目標の見方をそろえる期間。週の凸凹をならすため2週間。 */
const WINDOW_DAYS = 14;

/**
 * 1日の歩数としてありえる下限。/api/health/status の PLAUSIBLE_RANGE と同じ値。
 * これを下回る日ばかりなら、歩けていないのではなく値そのものが歩数になっていない。
 */
const STEPS_MIN_PLAUSIBLE = 500;

/** 睡眠時間がこれを下回る日が続いているなら、事実として出す。 */
const SLEEP_SHORT_HOURS = 6;

type DayRow = { day: string; steps: number | null; weight_kg: string | number | null };
type Goal = { metric: string; target: string | number };

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function run(ctx: Ctx): Promise<Finding[]> {
  const findings: Finding[] = [];
  const from = daysAgo(ctx.today, WINDOW_DAYS - 1);

  const goals = await getRows<Goal>(ctx, "health_goals?select=metric,target");
  const goalMap = new Map(goals.map((g) => [g.metric, Number(g.target)]));

  const days = await callRpc<DayRow>(ctx, "health_range_summary", {
    from_day: from,
    to_day: ctx.today,
  });

  // --- 歩数の目標 ---
  const stepsGoal = goalMap.get("steps");
  if (stepsGoal != null && Number.isFinite(stepsGoal)) {
    const values = days.map((d) => d.steps).filter((v): v is number => v != null);
    const med = median(values);

    if (values.length === 0) {
      findings.push({
        id: "goal:steps:nodata",
        area: "目標",
        severity: "alert",
        title: `${stepsGoal.toLocaleString()}歩の目標に対して、歩数が1日も入っていません`,
        facts: [`${from} 以降の${WINDOW_DAYS}日間で記録ゼロ`],
        href: "/health",
        hrefLabel: "取り込み状況を見る",
      });
    } else if (med != null && med < STEPS_MIN_PLAUSIBLE) {
      // ここが今回の肝。「達成できていない」ではなく「測れていない」と言う。
      findings.push({
        id: "goal:steps:implausible",
        area: "目標",
        severity: "alert",
        title: `${stepsGoal.toLocaleString()}歩の目標が、まだ測れる状態になっていません`,
        facts: [
          `直近${WINDOW_DAYS}日の歩数の中央値が ${Math.round(med)}。1日の合計歩数として説明のつく値ではありません`,
          `記録がある日は${values.length}日ありますが、値そのものが歩数になっていません`,
          "達成率はこの値では計算しても意味がないので出していません",
        ],
        href: "/health",
        hrefLabel: "取り込み状況を見る",
      });
    } else {
      const hit = values.filter((v) => v >= stepsGoal).length;
      const pct = Math.round((hit / values.length) * 100);
      findings.push({
        id: "goal:steps:progress",
        area: "目標",
        severity: pct < 50 ? "warn" : "info",
        title: `${stepsGoal.toLocaleString()}歩の達成は直近${values.length}日中${hit}日（${pct}%）`,
        facts: [
          `中央値 ${Math.round(med ?? 0).toLocaleString()}歩`,
          `${from} 〜 ${ctx.today} を見ています`,
        ],
        href: "/health",
        hrefLabel: "推移を見る",
      });
    }
  }

  // --- 体重の目標 ---
  const weightGoal = goalMap.get("weight_kg");
  if (weightGoal != null && Number.isFinite(weightGoal)) {
    const weighed = days
      .map((d) => ({ day: d.day, kg: d.weight_kg == null ? null : Number(d.weight_kg) }))
      .filter((d): d is { day: string; kg: number } => d.kg != null);
    const latest = weighed[weighed.length - 1];
    if (latest) {
      const diff = latest.kg - weightGoal;
      findings.push({
        id: "goal:weight",
        area: "目標",
        severity: "info",
        title:
          diff > 0
            ? `体重は目標${weightGoal}kgまであと${diff.toFixed(1)}kg`
            : `体重は目標${weightGoal}kgを${Math.abs(diff).toFixed(1)}kg下回っています`,
        facts: [
          `直近は ${shortDate(latest.day)} の ${latest.kg.toFixed(1)}kg`,
          `直近${WINDOW_DAYS}日で${weighed.length}日ぶん記録があります`,
        ],
        href: "/health",
        hrefLabel: "推移を見る",
      });
    }
  }

  // --- 睡眠（目標は置いていないが、事実として短い日が続くなら言う） ---
  // 手入力ぶんだけを見る。Ouraは連携していないので自動では入らない。
  const sleep = await getRows<{ day: string; value: string | number | null }>(
    ctx,
    `health_metrics?select=day,value&metric=eq.sleep_hours&source=eq.manual` +
      `&day=gte.${from}&order=day.asc&limit=100`
  );
  const hours = sleep
    .map((s) => (s.value == null ? null : Number(s.value)))
    .filter((v): v is number => v != null);
  if (hours.length >= 3) {
    const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
    if (avg < SLEEP_SHORT_HOURS) {
      const shortest = Math.min(...hours);
      const shortestDay = sleep.find((s) => Number(s.value) === shortest)?.day;
      findings.push({
        id: "sleep:short",
        area: "目標",
        severity: "warn",
        title: `記録した睡眠の平均が${avg.toFixed(1)}時間です`,
        facts: [
          `直近${WINDOW_DAYS}日で記録があるのは${hours.length}日`,
          shortestDay
            ? `いちばん短いのは ${shortDate(shortestDay)} の${shortest.toFixed(1)}時間`
            : `いちばん短い日で${shortest.toFixed(1)}時間`,
          `${SLEEP_SHORT_HOURS}時間を下回る平均が続いたら出すようにしています`,
        ],
        href: "/health",
        hrefLabel: "睡眠を入力する",
      });
    }
  }

  return findings;
}

export const goalsDetector: Detector = { name: "目標の現在地", run };
