"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  average,
  BarChart,
  ChartTitle,
  fmtDay,
  HEALTH_COLORS,
  LineChart,
  StatTile,
  type Point,
} from "./charts";

// 健康ダッシュボード（体重・体脂肪率・歩数・摂取カロリー・歩行の質の推移）。
// データは /api/health（Supabase Edge Function `health-dashboard-data` 経由・読み取り専用）。
// 集計・書き込みは iPhone(Health Auto Export) → ingest-health Function 側で完結しており、
// このページは既存の health_metrics / health_daily_summary には一切手を加えない。

type DayRow = {
  day: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  bmi: number | null;
  steps: number | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  walking_speed_kmh: number | null;
  walking_step_length_cm: number | null;
};

type ApiResponse = {
  from?: string;
  to?: string;
  days?: DayRow[];
  error?: string;
};

const RANGE_OPTIONS = [
  { key: 30, label: "30日" },
  { key: 90, label: "90日" },
  { key: 180, label: "180日" },
] as const;

function toPoints(days: DayRow[], key: keyof DayRow): Point[] {
  return days.map((d) => ({ day: d.day, value: (d[key] as number | null) ?? null }));
}

// 日次の点を「月曜はじまりの週」ごとにまとめて平均を出す。
// 日報録の週次稼働時間と同じ週の切り方（月〜日）に揃えている。
function weeklyAverages(points: Point[]): {
  weekStart: string;
  avg: number;
  days: number;
}[] {
  const buckets = new Map<string, number[]>();
  for (const p of points) {
    if (p.value == null) continue;
    const [y, m, d] = p.day.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const back = (dt.getDay() + 6) % 7; // 月曜=0 になるよう補正
    const monday = new Date(y, m - 1, d - back);
    const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(
      monday.getDate()
    ).padStart(2, "0")}`;
    const arr = buckets.get(key) ?? [];
    arr.push(p.value);
    buckets.set(key, arr);
  }
  return Array.from(buckets.entries())
    .map(([weekStart, vals]) => ({
      weekStart,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      days: vals.length,
    }))
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
}

// 「7/27〜8/2」の形にする（月曜〜日曜）
function weekRangeLabel(monday: string) {
  const [y, m, d] = monday.split("-").map(Number);
  const sun = new Date(y, m - 1, d + 6);
  return `${m}/${d}〜${sun.getMonth() + 1}/${sun.getDate()}`;
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {children}
    </section>
  );
}

export default function HealthPage() {
  const [rangeDays, setRangeDays] = useState<number>(90);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  // 目標値（health_goals）。吉井さんが自分で入れるもので、既定値は持たせない。
  const [goals, setGoals] = useState<Record<string, number>>({});
  const [goalDraft, setGoalDraft] = useState<string>("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);

  const loadGoals = useCallback(async () => {
    try {
      const res = await fetch("/api/health/goals", { cache: "no-store" });
      const json = await res.json();
      setGoals(json?.goals ?? {});
    } catch {
      // 目標は補助表示なので、取れなくてもページは出す
      setGoals({});
    }
  }, []);

  async function saveWeightGoal(target: number | null) {
    setSavingGoal(true);
    try {
      const res = await fetch("/api/health/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metric: "weight_kg", target }),
      });
      if (!res.ok) throw new Error();
      await loadGoals();
      setEditingGoal(false);
    } catch {
      setError("目標の保存に失敗しました");
    } finally {
      setSavingGoal(false);
    }
  }

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const to = new Date().toISOString().slice(0, 10);
      const fromDate = new Date();
      fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
      const from = fromDate.toISOString().slice(0, 10);

      const res = await fetch(`/api/health?from=${from}&to=${to}`, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || json.error) {
        setError(json.error ?? "取得に失敗しました");
        setData(null);
      } else {
        setData(json);
      }
    } catch {
      setError("通信エラーが発生しました");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(rangeDays);
  }, [rangeDays, load]);

  useEffect(() => {
    loadGoals();
  }, [loadGoals]);

  const days = useMemo(() => data?.days ?? [], [data]);

  const weightPoints = useMemo(() => toPoints(days, "weight_kg"), [days]);
  const bodyFatPoints = useMemo(() => toPoints(days, "body_fat_pct"), [days]);
  const stepsPoints = useMemo(() => toPoints(days, "steps"), [days]);
  const kcalPoints = useMemo(() => toPoints(days, "kcal"), [days]);
  const walkingSpeedPoints = useMemo(() => toPoints(days, "walking_speed_kmh"), [days]);

  // 直近値・直近7日平均（KPI用）
  const latestWeight = [...weightPoints].reverse().find((p) => p.value != null)?.value ?? null;
  const latestBodyFat = [...bodyFatPoints].reverse().find((p) => p.value != null)?.value ?? null;
  const last7Steps = average(stepsPoints.slice(-7).map((p) => p.value));
  const last7Kcal = average(kcalPoints.slice(-7).map((p) => p.value));
  const avgWalkSpeed = average(walkingSpeedPoints.map((p) => p.value));

  // 週ごとの平均歩数（月〜日）。直近8週ぶんを新しい順に。
  const stepsByWeek = useMemo(() => weeklyAverages(stepsPoints).slice(0, 8), [stepsPoints]);
  const stepsWeekMax = stepsByWeek.reduce((a, w) => Math.max(a, w.avg), 0);

  // 体重の目標との差。目標未設定なら null。
  const weightGoal = goals.weight_kg ?? null;
  const weightGap =
    weightGoal != null && latestWeight != null ? latestWeight - weightGoal : null;
  const avgStepLength = average(toPoints(days, "walking_step_length_cm").map((p) => p.value));

  // カロミル欠測期間の告知（連続30日以上のkcal欠測があれば表示）
  const kcalGapNote = useMemo(() => {
    const values = kcalPoints.map((p) => p.value);
    const runs: { start: number; end: number }[] = [];
    let runStart = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i] == null) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        runs.push({ start: runStart, end: i - 1 });
        runStart = -1;
      }
    }
    if (runStart !== -1) runs.push({ start: runStart, end: values.length - 1 });

    const longest = runs.reduce<{ start: number; end: number } | null>((acc, r) => {
      const len = r.end - r.start;
      const accLen = acc ? acc.end - acc.start : -1;
      return len > accLen ? r : acc;
    }, null);

    if (!longest || longest.end - longest.start < 20) return null;
    const startDay = kcalPoints[longest.start]?.day;
    const endDay = kcalPoints[longest.end]?.day;
    if (!startDay || !endDay) return null;
    return `カロミル連携の欠測期間（${fmtDay(startDay)}〜${fmtDay(endDay)}）はグラフ上「データなし」として扱っています。`;
  }, [kcalPoints]);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">健康推移</h1>
            <p className="mt-1 text-sm text-gray-500">
              体重・体脂肪率・歩数・摂取カロリー・歩行の質を日次で確認
            </p>
          </div>
        </div>
      </header>

      {/* 期間切り替え */}
      <div className="mb-4 flex gap-2">
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setRangeDays(o.key)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
              rangeDays === o.key ? "bg-indigo-600 text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"
            }`}
          >
            {o.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => load(rangeDays)}
          className="ml-auto rounded-full px-3 py-1 text-sm text-gray-400 ring-1 ring-gray-200 active:scale-95"
          aria-label="再読み込み"
        >
          ↻
        </button>
      </div>

      {loading && !data && (
        <div className="flex flex-col items-center gap-3 py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
          <p className="text-sm text-gray-500">読み込み中…</p>
        </div>
      )}

      {error && (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}

      {!loading && !error && days.length > 0 && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label="体重"
              value={latestWeight != null ? `${latestWeight}kg` : "—"}
              color={HEALTH_COLORS.weight}
            />
            <StatTile
              label="体脂肪率"
              value={latestBodyFat != null ? `${latestBodyFat}%` : "—"}
              color={HEALTH_COLORS.bodyFat}
            />
            <StatTile
              label="歩数(7日平均)"
              value={last7Steps != null ? Math.round(last7Steps).toLocaleString() : "—"}
              color={HEALTH_COLORS.steps}
            />
            <StatTile
              label="摂取kcal(7日平均)"
              value={last7Kcal != null ? Math.round(last7Kcal).toLocaleString() : "—"}
              color={HEALTH_COLORS.kcal}
            />
          </div>

          {kcalGapNote && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              ⚠️ {kcalGapNote}
            </p>
          )}

          {/* 体重・体脂肪率 */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.weight}
              title="体重の推移"
              hint={
                weightGoal != null
                  ? `7日移動平均（太線）／実測（薄線）／目標 ${weightGoal}kg（破線）`
                  : "7日移動平均（太線）／実測（薄線）"
              }
            />
            <LineChart
              points={weightPoints}
              color={HEALTH_COLORS.weight}
              maWindow={7}
              unit="kg"
              valueFormat={(v) => v.toFixed(1)}
              goal={weightGoal}
            />

            {/* 目標体重。値は吉井さんが入れるもので、こちらで既定値は置かない。 */}
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-gray-50 px-3 py-2">
              {!editingGoal ? (
                <>
                  <span className="text-sm text-gray-500">目標体重</span>
                  <span className="text-sm font-bold text-gray-900">
                    {weightGoal != null ? `${weightGoal}kg` : "未設定"}
                  </span>
                  {weightGap != null && (
                    <span
                      className={`text-sm font-medium ${
                        weightGap > 0 ? "text-rose-600" : "text-emerald-600"
                      }`}
                    >
                      {weightGap > 0
                        ? `あと −${weightGap.toFixed(1)}kg`
                        : `達成 +${Math.abs(weightGap).toFixed(1)}kg`}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setGoalDraft(weightGoal != null ? String(weightGoal) : "");
                      setEditingGoal(true);
                    }}
                    className="ml-auto text-sm font-medium text-indigo-600 active:opacity-70"
                  >
                    {weightGoal != null ? "変更" : "設定する"}
                  </button>
                </>
              ) : (
                <>
                  <label className="text-sm text-gray-500" htmlFor="weight-goal">
                    目標体重
                  </label>
                  <input
                    id="weight-goal"
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={goalDraft}
                    onChange={(e) => setGoalDraft(e.target.value)}
                    placeholder="例 68.0"
                    className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-base text-gray-900 focus:border-indigo-500 focus:outline-none"
                  />
                  <span className="text-sm text-gray-500">kg</span>
                  <button
                    type="button"
                    disabled={savingGoal || !goalDraft.trim()}
                    onClick={() => saveWeightGoal(Number(goalDraft))}
                    className="rounded-lg bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-40 active:scale-95"
                  >
                    {savingGoal ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingGoal(false)}
                    className="text-sm text-gray-500 active:opacity-70"
                  >
                    取消
                  </button>
                  {weightGoal != null && (
                    <button
                      type="button"
                      disabled={savingGoal}
                      onClick={() => saveWeightGoal(null)}
                      className="ml-auto text-sm text-rose-600 active:opacity-70"
                    >
                      目標を消す
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="mt-5 border-t border-gray-100 pt-4">
              <ChartTitle color={HEALTH_COLORS.bodyFat} title="体脂肪率の推移" hint="7日移動平均（太線）" />
              <LineChart
                points={bodyFatPoints}
                color={HEALTH_COLORS.bodyFat}
                maWindow={7}
                unit="%"
                valueFormat={(v) => v.toFixed(1)}
              />
            </div>
          </Section>

          {/* 歩数 */}
          <Section>
            <ChartTitle color={HEALTH_COLORS.steps} title="歩数の推移" hint={`直近7日平均 ${last7Steps != null ? Math.round(last7Steps).toLocaleString() : "—"}歩`} />
            <BarChart points={stepsPoints} color={HEALTH_COLORS.steps} unit="歩" />

            {/* 週ごとの平均歩数（月〜日）。日報録の週次と同じ週の切り方に揃えている。 */}
            {stepsByWeek.length > 0 && (
              <div className="mt-5 border-t border-gray-100 pt-4">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold text-gray-500">週ごとの平均歩数</h3>
                  <span className="text-[0.6875rem] text-gray-400">月〜日</span>
                </div>
                <ul className="space-y-2">
                  {stepsByWeek.map((w) => (
                    <li key={w.weekStart} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-sm tabular-nums text-gray-500">
                        {weekRangeLabel(w.weekStart)}
                      </span>
                      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.max(
                              stepsWeekMax > 0 ? (w.avg / stepsWeekMax) * 100 : 0,
                              2
                            )}%`,
                            background: HEALTH_COLORS.steps,
                          }}
                        />
                      </span>
                      <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums text-gray-700">
                        {Math.round(w.avg).toLocaleString()}歩
                      </span>
                      {/* 日数が7日に満たない週は平均の重みが違うので、正直に出す */}
                      <span className="w-10 shrink-0 text-right text-[0.6875rem] tabular-nums text-gray-400">
                        {w.days}日
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {/* 摂取カロリーと体重の関係 */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.kcal}
              title="摂取カロリーと体重"
              hint="同じ期間で上下に並べて表示"
            />
            <p className="mb-3 text-xs leading-relaxed text-gray-500">
              上：摂取カロリー（kcal／日）・下：体重（kg）。同じ日付軸で並べているので、食べた量と体重の動きを見比べられます。
            </p>
            <BarChart points={kcalPoints} color={HEALTH_COLORS.kcal} unit="kcal" />
            <div className="mt-2">
              <LineChart
                points={weightPoints}
                color={HEALTH_COLORS.weight}
                unit="kg"
                valueFormat={(v) => v.toFixed(1)}
                height={130}
              />
            </div>
          </Section>

          {/* 歩行の質 */}
          <Section>
            <ChartTitle color={HEALTH_COLORS.walking} title="歩行速度の推移" hint="km/h" />
            <LineChart
              points={walkingSpeedPoints}
              color={HEALTH_COLORS.walking}
              unit="km/h"
              valueFormat={(v) => v.toFixed(2)}
            />
            {avgStepLength != null && (
              <p className="mt-2 text-xs text-gray-400">
                期間平均の歩幅：{avgStepLength.toFixed(1)}cm（歩行速度の期間平均：
                {avgWalkSpeed != null ? avgWalkSpeed.toFixed(2) : "—"}km/h）
              </p>
            )}
          </Section>

          {/* テーブル表示（アクセシビリティ用のフォールバック） */}
          <Section>
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              className="flex w-full items-center justify-between text-sm font-semibold text-gray-700"
            >
              表形式で見る（直近{Math.min(30, days.length)}日）
              <span className="text-gray-400">{showTable ? "▲" : "▼"}</span>
            </button>
            {showTable && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-3 font-medium">日付</th>
                      <th className="py-1.5 pr-3 font-medium">体重</th>
                      <th className="py-1.5 pr-3 font-medium">体脂肪率</th>
                      <th className="py-1.5 pr-3 font-medium">歩数</th>
                      <th className="py-1.5 pr-3 font-medium">摂取kcal</th>
                      <th className="py-1.5 pr-3 font-medium">歩行速度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days
                      .slice(-30)
                      .reverse()
                      .map((d) => (
                        <tr key={d.day} className="border-b border-gray-100 text-gray-700">
                          <td className="py-1.5 pr-3 tabular-nums">{fmtDay(d.day)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{d.weight_kg ?? "—"}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{d.body_fat_pct ?? "—"}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{d.steps?.toLocaleString() ?? "—"}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{d.kcal?.toLocaleString() ?? "—"}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{d.walking_speed_kmh ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <p className="mt-6 text-center text-xs text-gray-400">
            集計期間 {data?.from ? fmtDay(data.from) : ""} 〜 {data?.to ? fmtDay(data.to) : ""}
            <br />
            体重・体脂肪率・BMIはHealthPlanet優先／栄養はカロミル優先／歩数はApple Health優先で集計（health_range_summary）。
          </p>
        </>
      )}

      {!loading && !error && days.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-400">データがありません。</p>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}
