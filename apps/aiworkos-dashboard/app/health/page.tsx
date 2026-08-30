"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  average,
  BarChart,
  ChartTitle,
  fmtDay,
  HEALTH_COLORS,
  LineChart,
  StatTile,
  type DayMarks,
  type Point,
} from "./charts";
import {
  ManualEntryCard,
  todayLocal,
  type ManualEntries,
  type ManualMetric,
} from "./manualEntry";
import { IngestAlertBanner, IngestStatusSection, type StatusResponse } from "./ingestStatus";
import { PhotoImportCard } from "./photoImport";
import { ConditionsCard, type Condition } from "./conditions";

// 健康ダッシュボード（体重・体脂肪率・歩数・摂取カロリー・歩行の質の推移）。
// データは /api/health（Supabase Edge Function `health-dashboard-data` 経由・読み取り専用）。
// 集計・書き込みは iPhone(Health Auto Export) → ingest-health Function 側で完結しており、
// このページは既存の health_metrics / health_daily_summary には一切手を加えない。
//
// 追加で読み書きするもの（いずれも app/api/health/ 配下）:
//   /api/health/manual … 睡眠・朝の散歩・出張の手入力（health_metrics の source='manual'）
//   /api/health/status … 取り込み状況（どの指標が・いつ・どこから入っているか）
//   /api/health/ramen  … ramen_logs の読み取り専用（食べた日の印・平均の比較に使う）
//   /api/health/photo-steps … 歩数計アプリのスクショから歩数を入れる（source='photo'）
//   /api/health/conditions  … 体調の記録（health_conditions。期間つきなので別テーブル）
//
// 並びの意図: 医師から1日6,000歩を求められているので、歩数を体重より先に置いている。
// 手入力カードはさらにその上（毎日いちばん触るものが最初に来る）。

type DayRow = {
  day: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  /** 筋肉量。体組成計の写真からしか入らない（自動連携に項目が無い）。 */
  muscle_kg: number | null;
  bmi: number | null;
  steps: number | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  /** 塩分相当量(g)。写真はそのまま、Apple Health の sodium(mg) は換算済み。 */
  salt_g: number | null;
  walking_speed_kmh: number | null;
  walking_step_length_cm: number | null;
};

type ApiResponse = {
  from?: string;
  to?: string;
  days?: DayRow[];
  error?: string;
};

type RamenLog = { eaten_on: string; shop: string | null; menu: string | null; score: number | null };

const RANGE_OPTIONS = [
  { key: 30, label: "30日" },
  { key: 90, label: "90日" },
  { key: 180, label: "180日" },
] as const;

/** 平均を比べるのに最低限ほしい日数。これを下回る側があるうちは判断材料にしない。 */
const MIN_DAYS_FOR_COMPARISON = 5;

function toPoints(days: DayRow[], key: keyof DayRow): Point[] {
  return days.map((d) => ({ day: d.day, value: (d[key] as number | null) ?? null }));
}

function addDaysLocal(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate()
  ).padStart(2, "0")}`;
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
  // 目標保存の失敗は goalError に分ける。ページ全体の error に混ぜると
  // 描画条件（!error）が落ちて画面が真っ白になるため、目標カード内だけに出す。
  const [goalError, setGoalError] = useState<string | null>(null);
  // 手入力（睡眠・朝の散歩・出張）
  const [manual, setManual] = useState<ManualEntries>({});
  const [manualError, setManualError] = useState<string | null>(null);
  // 取り込み状況
  const [status, setStatus] = useState<StatusResponse | null>(null);
  // ラーメン（読み取り専用）
  const [ramenLogs, setRamenLogs] = useState<RamenLog[]>([]);
  // 体調の記録（発熱・診断名など）
  const [conditions, setConditions] = useState<Condition[]>([]);
  // 付随データ（手入力・ラーメン・体調）の取得失敗フラグ。
  // 失敗を空データで上書きすると「まだ記録がありません」に化けて、
  // 既存の記録が消えたように見えるため、失敗は失敗として表示する。
  const [subError, setSubError] = useState<{ manual: boolean; ramen: boolean; conditions: boolean }>({
    manual: false,
    ramen: false,
    conditions: false,
  });

  const statusRef = useRef<HTMLDivElement>(null);

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
    setGoalError(null);
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
      setGoalError("目標の保存に失敗しました。通信を確認してもう一度お試しください");
    } finally {
      setSavingGoal(false);
    }
  }

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      // 日付は端末のローカル日付で切る。UTCで切ると、日本時間の朝は
      // 「今日」がまだ来ておらず当日ぶんがグラフから落ちる。
      const to = todayLocal();
      const from = addDaysLocal(to, -(days - 1));

      const res = await fetch(`/api/health?from=${from}&to=${to}`, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || json.error) {
        setError(json.error ?? "取得に失敗しました");
        setData(null);
      } else {
        setData(json);
      }

      // 手入力・ラーメンは同じ期間で取る。落ちても本体は出す。
      // 失敗時は空で上書きしない（前回の表示を保持し、失敗フラグだけ立てる）。
      fetch(`/api/health/manual?from=${from}&to=${to}`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((j) => {
          setManual(j?.entries ?? {});
          setSubError((p) => ({ ...p, manual: false }));
        })
        .catch(() => setSubError((p) => ({ ...p, manual: true })));
      fetch(`/api/health/ramen?from=${from}&to=${to}`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((j) => {
          setRamenLogs(Array.isArray(j?.logs) ? j.logs : []);
          setSubError((p) => ({ ...p, ramen: false }));
        })
        .catch(() => setSubError((p) => ({ ...p, ramen: true })));
      fetch(`/api/health/conditions?from=${from}&to=${to}`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((j) => {
          setConditions(Array.isArray(j?.items) ? j.items : []);
          setSubError((p) => ({ ...p, conditions: false }));
        })
        .catch(() => setSubError((p) => ({ ...p, conditions: true })));
    } catch {
      setError("通信エラーが発生しました");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/health/status", { cache: "no-store" });
      setStatus(await res.json());
    } catch {
      setStatus({ error: "取り込み状況を取得できませんでした。" });
    }
  }, []);

  // 手入力の保存。押した瞬間に画面へ反映し（楽観更新）、失敗したら元に戻す。
  // 毎日続けてもらうために、通信の待ち時間を体感させないことを優先する。
  const saveManual = useCallback(
    async (day: string, metric: ManualMetric, value: number | null): Promise<boolean> => {
      setManualError(null);
      const before = manual;
      setManual((prev) => {
        const next = { ...prev, [day]: { ...prev[day] } };
        if (value == null) delete next[day][metric];
        else next[day][metric] = value;
        return next;
      });
      try {
        const res = await fetch("/api/health/manual", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ day, metric, value }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error(j?.error ?? "保存に失敗しました");
        }
        return true;
      } catch (e) {
        setManual(before);
        setManualError(e instanceof Error ? e.message : "保存に失敗しました");
        return false;
      }
    },
    [manual]
  );

  useEffect(() => {
    load(rangeDays);
  }, [rangeDays, load]);

  useEffect(() => {
    loadGoals();
    loadStatus();
  }, [loadGoals, loadStatus]);

  const days = useMemo(() => data?.days ?? [], [data]);

  const weightPoints = useMemo(() => toPoints(days, "weight_kg"), [days]);
  const bodyFatPoints = useMemo(() => toPoints(days, "body_fat_pct"), [days]);
  const stepsPoints = useMemo(() => toPoints(days, "steps"), [days]);
  const kcalPoints = useMemo(() => toPoints(days, "kcal"), [days]);
  const walkingSpeedPoints = useMemo(() => toPoints(days, "walking_speed_kmh"), [days]);

  // 手入力の睡眠を、他のグラフと同じ日付軸の点に並べ直す
  const sleepPoints = useMemo<Point[]>(
    () => days.map((d) => ({ day: d.day, value: manual[d.day]?.sleep_hours ?? null })),
    [days, manual]
  );
  const sleepRecorded = sleepPoints.filter((p) => p.value != null).length;

  // 今日を起点にした直近7日ぶんの睡眠。期間切替（90日など）とは独立に必ず1週間を出す。
  // 1週間ぶんをスクリーンショットで撮ってエージェントに渡す使い方をするため、
  // グラフの棒だけでなく「何時間」を数字で読める形にしておく。
  const sleepWeek = useMemo(() => {
    const today = todayLocal();
    const [y, m, d] = today.split("-").map(Number);
    const out: { day: string; label: string; weekday: string; hours: number | null }[] = [];
    for (let i = 6; i >= 0; i -= 1) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - i);
      const key = dt.toISOString().slice(0, 10);
      out.push({
        day: key,
        label: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`,
        weekday: ["日", "月", "火", "水", "木", "金", "土"][dt.getUTCDay()],
        hours: manual[key]?.sleep_hours ?? null,
      });
    }
    return out;
  }, [manual]);

  const sleepWeekAvg = useMemo(() => {
    const vals = sleepWeek.map((d) => d.hours).filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }, [sleepWeek]);
  const walkDays = useMemo(
    () => days.filter((d) => manual[d.day]?.morning_walk != null).length,
    [days, manual]
  );
  const tripDays = useMemo(
    () => days.filter((d) => manual[d.day]?.business_trip != null).length,
    [days, manual]
  );

  // 直近値・直近7日平均（KPI用）
  const latestWeight = [...weightPoints].reverse().find((p) => p.value != null)?.value ?? null;
  const latestBodyFat = [...bodyFatPoints].reverse().find((p) => p.value != null)?.value ?? null;
  const last7Steps = average(stepsPoints.slice(-7).map((p) => p.value));
  const last7Kcal = average(kcalPoints.slice(-7).map((p) => p.value));
  const avgWalkSpeed = average(walkingSpeedPoints.map((p) => p.value));

  // 週ごとの平均歩数（月〜日）。直近8週ぶんを新しい順に。
  const stepsByWeek = useMemo(() => weeklyAverages(stepsPoints).slice(0, 8), [stepsPoints]);
  const stepsGoal = goals.steps ?? null;
  // 週ごとの棒の物差し。目標線を同じ物差しの上に置くため、目標値も最大値に含める。
  const stepsWeekMax = stepsByWeek.reduce(
    (a, w) => Math.max(a, w.avg),
    stepsGoal ?? 0
  );

  // 6,000歩の達成状況。分母は「歩数が記録されている日」だけにする
  // （記録が無い日を未達に数えると、連携が止まっているときに達成率が実態より下がる）。
  const stepsAchievement = useMemo(() => {
    if (stepsGoal == null) return null;
    const withData = stepsPoints.filter((p) => p.value != null) as { day: string; value: number }[];
    if (withData.length === 0) return null;
    const hit = withData.filter((p) => p.value >= stepsGoal).length;
    return {
      hit,
      total: withData.length,
      pct: (hit / withData.length) * 100,
      avg: withData.reduce((a, p) => a + p.value, 0) / withData.length,
    };
  }, [stepsPoints, stepsGoal]);

  // 歩数そのものの取り込みに気になる点があるときの注意書き。
  // 達成率・平均は、元の記録が怪しい期間を含んでいると簡単に実態とずれる。
  // 数字だけ大きく出して読み違えさせないよう、同じ画面の中で必ず添える。
  const stepsDataNotes = useMemo(() => {
    const m = status?.metrics?.find((x) => x.metric === "step_count");
    return m && m.severity === "alert" ? m.notes : null;
  }, [status]);

  // 体調を崩していた日。歩数の達成率をそのまま読むと「サボった日」に見えるが、
  // 熱で寝込んでいた日はそもそも歩けない。数字の隣に事実として置いておく。
  const sickDays = useMemo(() => {
    if (days.length === 0 || conditions.length === 0) return { count: 0, labels: [] as string[] };
    const from = days[0].day;
    const to = days[days.length - 1].day;
    const set = new Set<string>();
    const labels: string[] = [];
    for (const c of conditions) {
      const start = c.start_day < from ? from : c.start_day;
      const end = c.end_day == null || c.end_day > to ? to : c.end_day;
      if (start > end) continue;
      for (let d = start; d <= end; ) {
        set.add(d);
        const [y, m, dd] = d.split("-").map(Number);
        const nx = new Date(y, m - 1, dd + 1);
        d = `${nx.getFullYear()}-${String(nx.getMonth() + 1).padStart(2, "0")}-${String(
          nx.getDate()
        ).padStart(2, "0")}`;
      }
      labels.push(
        `${fmtDay(c.start_day)}〜${c.end_day ? fmtDay(c.end_day) : "（続いている）"} ${c.title}`
      );
    }
    return { count: set.size, labels };
  }, [days, conditions]);

  // 体重の目標との差。目標未設定なら null。
  const weightGoal = goals.weight_kg ?? null;
  const weightGap =
    weightGoal != null && latestWeight != null ? latestWeight - weightGoal : null;
  const avgStepLength = average(toPoints(days, "walking_step_length_cm").map((p) => p.value));

  // ── ラーメンと健康 ──────────────────────────────────────────────
  // 見せ方を2つに絞った理由:
  //   (1) 摂取カロリー・体重のグラフに「食べた日」の印を出す
  //       … その日に何があったかを、既にあるグラフの上でそのまま読めるのがいちばん軽い。
  //   (2) 食べた日と食べなかった日で「同じ日の平均」を並べる
  //       … 因果は出せないが「その日どうだったか」の事実は出せる。
  //   体重は平均の比較から外している。体重はその日の食事より前の期間の積み上げで動くので、
  //   「食べた日の体重平均」を並べても意味のある比較にならないため（印だけ出す）。
  const ramenDaySet = useMemo(() => new Set(ramenLogs.map((l) => l.eaten_on)), [ramenLogs]);
  const ramenMarks: DayMarks = useMemo(
    () => ({ days: ramenDaySet, color: HEALTH_COLORS.ramen, label: "ラーメンを食べた日" }),
    [ramenDaySet]
  );

  // ラーメンの記録が付いている最後の日。これより後は「食べていない」のか
  // 「まだ記録していない」のか区別できないので、比較の対象から外す。
  const ramenLastDay = useMemo(
    () => ramenLogs.reduce((a, l) => (l.eaten_on > a ? l.eaten_on : a), ""),
    [ramenLogs]
  );

  const ramenCompare = useMemo(() => {
    if (!ramenLastDay) return null;
    const rows = days.filter((d) => d.day <= ramenLastDay);
    const pick = (list: DayRow[], key: "kcal" | "steps") =>
      average(list.map((d) => d[key]));
    const ate = rows.filter((d) => ramenDaySet.has(d.day));
    const not = rows.filter((d) => !ramenDaySet.has(d.day));
    const count = (list: DayRow[], key: "kcal" | "steps") =>
      list.filter((d) => d[key] != null).length;
    return {
      until: ramenLastDay,
      ate: {
        days: ate.length,
        kcal: pick(ate, "kcal"),
        kcalDays: count(ate, "kcal"),
        steps: pick(ate, "steps"),
        stepsDays: count(ate, "steps"),
      },
      not: {
        days: not.length,
        kcal: pick(not, "kcal"),
        kcalDays: count(not, "kcal"),
        steps: pick(not, "steps"),
        stepsDays: count(not, "steps"),
      },
    };
  }, [days, ramenDaySet, ramenLastDay]);

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
              体重・体脂肪率・歩数・摂取カロリー・睡眠・歩行の質を日次で確認
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
          onClick={() => {
            load(rangeDays);
            loadStatus();
          }}
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
              sub={stepsGoal != null ? `目標 ${stepsGoal.toLocaleString()}歩` : undefined}
              color={HEALTH_COLORS.steps}
            />
            <StatTile
              label="摂取kcal(7日平均)"
              value={last7Kcal != null ? Math.round(last7Kcal).toLocaleString() : "—"}
              color={HEALTH_COLORS.kcal}
            />
          </div>

          {/* 取り込みの気になる点。歩数の達成率などを読む前に目に入る位置に置く。 */}
          <IngestAlertBanner
            status={status}
            onJump={() => statusRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          />

          {kcalGapNote && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              ⚠️ {kcalGapNote}
            </p>
          )}

          {/* 付随データの取得失敗。「まだ記録がありません」と読み違えさせない */}
          {(subError.manual || subError.ramen || subError.conditions) && (
            <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">
              {[
                subError.manual && "手入力（睡眠・散歩・出張）",
                subError.ramen && "ラーメン",
                subError.conditions && "体調",
              ]
                .filter(Boolean)
                .join("・")}
              の記録を取得できませんでした（記録が消えたわけではありません）。↻で再読み込みできます。
            </p>
          )}

          {/* 手入力（睡眠・朝の散歩・出張）。毎日いちばん触るのでいちばん上。 */}
          <ManualEntryCard entries={manual} onSave={saveManual} error={manualError} />

          {/* 歩数。医師から1日6,000歩を求められているので、体重より前に置く。 */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.steps}
              title="歩数の推移"
              hint={
                stepsGoal != null
                  ? `目標 ${stepsGoal.toLocaleString()}歩（破線）／達成した日は濃い棒`
                  : `直近7日平均 ${last7Steps != null ? Math.round(last7Steps).toLocaleString() : "—"}歩`
              }
            />

            {stepsDataNotes && (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-semibold text-amber-900">
                  下の達成率・平均は、そのまま受け取らないでください
                </p>
                <ul className="mt-1 space-y-0.5">
                  {stepsDataNotes.map((n, i) => (
                    <li key={i} className="text-xs leading-relaxed text-amber-900">
                      ・{n}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs leading-relaxed text-amber-800">
                  記録されている値をそのまま集計しているので、この期間の達成率は実際に歩いた量と一致しません。
                </p>
              </div>
            )}

            {/* 体調を崩していた日があるなら、達成率の前に事実として置く。 */}
            {sickDays.count > 0 && (
              <div className="mb-3 rounded-xl bg-rose-50 px-3 py-2">
                <p className="text-xs font-semibold text-rose-900">
                  この期間に体調を崩した日が{sickDays.count}日あります
                </p>
                {sickDays.labels.map((l, i) => (
                  <p key={i} className="mt-0.5 text-xs text-rose-800">
                    ・{l}
                  </p>
                ))}
                <p className="mt-1 text-xs leading-relaxed text-rose-700">
                  寝込んでいた日は歩けないので、下の達成率はその日数ぶん下がります。
                </p>
              </div>
            )}

            {stepsAchievement && stepsGoal != null && (
              <div className="mb-3 grid grid-cols-3 gap-2">
                <StatTile
                  label={`${stepsGoal.toLocaleString()}歩 達成`}
                  value={`${stepsAchievement.hit}日`}
                  sub={`記録のある${stepsAchievement.total}日中`}
                  color={HEALTH_COLORS.steps}
                />
                <StatTile
                  label="達成率"
                  value={`${Math.round(stepsAchievement.pct)}%`}
                  sub="この期間"
                />
                <StatTile
                  label="期間平均"
                  value={`${Math.round(stepsAchievement.avg).toLocaleString()}歩`}
                  sub={
                    stepsAchievement.avg >= stepsGoal
                      ? "目標以上"
                      : `目標まで ${Math.round(stepsGoal - stepsAchievement.avg).toLocaleString()}歩`
                  }
                />
              </div>
            )}

            <BarChart
              points={stepsPoints}
              color={HEALTH_COLORS.steps}
              unit="歩"
              goal={stepsGoal}
              goalLabel="目標"
            />

            {/* 週ごとの平均歩数（月〜日）。日報録の週次と同じ週の切り方に揃えている。 */}
            {stepsByWeek.length > 0 && (
              <div className="mt-5 border-t border-gray-100 pt-4">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold text-gray-500">週ごとの平均歩数</h3>
                  <span className="text-[0.6875rem] text-gray-400">
                    月〜日{stepsGoal != null ? `／縦線が目標 ${stepsGoal.toLocaleString()}歩` : ""}
                  </span>
                </div>
                <ul className="space-y-2">
                  {stepsByWeek.map((w) => {
                    const achieved = stepsGoal != null && w.avg >= stepsGoal;
                    return (
                      <li key={w.weekStart} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 text-sm tabular-nums text-gray-500">
                          {weekRangeLabel(w.weekStart)}
                        </span>
                        <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${Math.max(
                                stepsWeekMax > 0 ? (w.avg / stepsWeekMax) * 100 : 0,
                                2
                              )}%`,
                              background: HEALTH_COLORS.steps,
                              // 目標に届いた週だけ濃く。棒の長さだけでは線を越えたか読み取りにくい。
                              opacity: stepsGoal == null || achieved ? 1 : 0.35,
                            }}
                          />
                          {/* 6,000歩のライン */}
                          {stepsGoal != null && stepsWeekMax > 0 && (
                            <span
                              className="absolute top-0 h-full w-px"
                              style={{
                                left: `${Math.min(100, (stepsGoal / stepsWeekMax) * 100)}%`,
                                background: "#d4537e",
                              }}
                            />
                          )}
                        </span>
                        <span
                          className={`w-24 shrink-0 text-right text-sm font-medium tabular-nums ${
                            stepsGoal == null ? "text-gray-700" : achieved ? "text-emerald-700" : "text-gray-500"
                          }`}
                        >
                          {Math.round(w.avg).toLocaleString()}歩
                        </span>
                        {/* 日数が7日に満たない週は平均の重みが違うので、正直に出す */}
                        <span className="w-10 shrink-0 text-right text-[0.6875rem] tabular-nums text-gray-400">
                          {w.days}日
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* 写メから歩数を入れる。連携が止まった期間を後から埋めるための入口。 */}
            <PhotoImportCard
              kind="steps"
              title="写メから歩数を入れる"
              hint="歩数計アプリの一覧画面を撮って送ると、日付ごとに読み取ります"
              today={todayLocal()}
              onSaved={() => {
                load(rangeDays);
                loadStatus();
              }}
            />
          </Section>

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
              {goalError && (
                <p className="basis-full rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
                  {goalError}
                </p>
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

            {/* 写メから体重・体脂肪率・筋肉量を入れる。HealthPlanetの連携が飛んだ日を後から埋める。 */}
            <PhotoImportCard
              kind="weight"
              title="写メから体重・体脂肪率・筋肉量を入れる"
              hint="体組成計アプリの一覧画面を撮って送ると、日付ごとに読み取ります"
              today={todayLocal()}
              onSaved={() => {
                load(rangeDays);
                loadStatus();
              }}
            />
          </Section>

          {/* 食事。体重の推移と睡眠時間の推移の間に置く（体重の増減と食べた量を続けて見るため） */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.kcal}
              title="食事の推移"
              hint="摂取カロリー。7日移動平均（太線）／実測（薄線）"
            />
            <LineChart
              points={kcalPoints}
              color={HEALTH_COLORS.kcal}
              maWindow={7}
              unit="kcal"
              valueFormat={(v) => Math.round(v).toLocaleString()}
            />

            {/* 直近7日のPFCと塩分。カロリーだけでは中身が分からないので並べる。
                件数も出す——記録が2日しかない週の平均を、7日の平均と同じ顔で
                出すと読み違える。 */}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "たんぱく質", key: "protein_g" as const, unit: "g", digits: 1 },
                { label: "脂質", key: "fat_g" as const, unit: "g", digits: 1 },
                { label: "炭水化物", key: "carbs_g" as const, unit: "g", digits: 1 },
                { label: "塩分", key: "salt_g" as const, unit: "g", digits: 2 },
              ].map((m) => {
                const vals = days
                  .slice(-7)
                  .map((d) => d[m.key])
                  .filter((v): v is number => v != null);
                const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                return (
                  <div key={m.key} className="rounded-xl bg-gray-50 px-3 py-2">
                    <p className="text-xs text-gray-500">{m.label}</p>
                    <p className="text-base font-bold tabular-nums text-gray-900">
                      {avg == null ? "—" : `${avg.toFixed(m.digits)}${m.unit}`}
                    </p>
                    <p className="text-[0.6875rem] text-gray-400">
                      直近7日 {vals.length ? `${vals.length}日ぶんの平均` : "記録なし"}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* カロミルの日次サマリを撮って入れる。画面に日付が出ないので日付を選ばせる。 */}
            <PhotoImportCard
              kind="meal"
              title="写メから食事を入れる"
              hint="カロミルの1日ぶんの合計画面を撮って送ると、カロリー・PFC・塩分を読み取ります"
              today={todayLocal()}
              undated
              onSaved={() => {
                load(rangeDays);
                loadStatus();
              }}
            />
          </Section>

          {/* 睡眠（手入力） */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.sleep}
              title="睡眠時間の推移"
              hint="手入力ぶんのみ"
            />

            {/* 今日起点の直近7日。上の期間切替に関係なく必ず1週間を出す。
                ここを1枚撮ってエージェントへ渡す使い方をするので、7列に詰めず
                1日1行にして日付・曜日・時間が確実に読み取れる大きさにしている。 */}
            <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-sm font-semibold text-gray-800">
                  直近7日（{sleepWeek[0]?.label}〜{sleepWeek[6]?.label}）
                </span>
                <span className="text-xs text-gray-500">
                  平均 {sleepWeekAvg != null ? `${sleepWeekAvg.toFixed(1)}時間` : "—"}
                </span>
              </div>
              <div className="divide-y divide-gray-100 overflow-hidden rounded-lg bg-white">
                {sleepWeek.map((d, i) => (
                  <div
                    key={d.day}
                    className={`flex items-center justify-between px-3 py-2 ${
                      i === 6 ? "bg-indigo-50" : ""
                    }`}
                  >
                    <span className="text-sm text-gray-600">
                      {d.label}
                      <span className="ml-1 text-gray-400">（{d.weekday}）</span>
                      {i === 6 && (
                        <span className="ml-2 text-xs font-medium text-indigo-600">今日</span>
                      )}
                    </span>
                    {d.hours == null ? (
                      <span className="text-sm text-gray-300">未記録</span>
                    ) : (
                      <span className="text-base font-bold text-gray-900">
                        {d.hours.toFixed(1)}
                        <span className="ml-0.5 text-xs font-normal text-gray-500">時間</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {sleepRecorded > 0 ? (
              <>
                <BarChart
                  points={sleepPoints}
                  color={HEALTH_COLORS.sleep}
                  unit="時間"
                  valueFormat={(v) => v.toFixed(1)}
                  height={120}
                />
                <p className="mt-2 text-xs text-gray-500">
                  この期間の記録：{sleepRecorded}日ぶん（平均{" "}
                  {average(sleepPoints.map((p) => p.value))?.toFixed(1) ?? "—"}時間）
                </p>
              </>
            ) : (
              <p className="py-4 text-center text-sm text-gray-400">
                まだ記録がありません。上の「記録をつける」から入れてください。
              </p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatTile label="朝の散歩" value={`${walkDays}日`} sub={`直近${days.length}日で`} />
              <StatTile label="出張" value={`${tripDays}日`} sub={`直近${days.length}日で`} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              iPhoneのHealth Auto Exportでは睡眠データが取得できないため、この3つは手入力で貯めています
              （health_metrics の source=&quot;manual&quot;）。
            </p>
          </Section>

          {/* 体調の記録（発熱・診断名・違った検査） */}
          <ConditionsCard
            items={conditions}
            today={todayLocal()}
            onChanged={() => load(rangeDays)}
          />

          {/* 摂取カロリーと体重の関係（ラーメンの印つき） */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.kcal}
              title="摂取カロリーと体重"
              hint="同じ期間で上下に並べて表示"
            />
            <p className="mb-3 text-xs leading-relaxed text-gray-500">
              上：摂取カロリー（kcal／日）・下：体重（kg）。同じ日付軸で並べているので、食べた量と体重の動きを見比べられます。
              軸の下の
              <span
                className="mx-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: HEALTH_COLORS.ramen }}
              />
              はラーメンを食べた日（この期間で {ramenDaySet.size}日）。
            </p>
            <BarChart points={kcalPoints} color={HEALTH_COLORS.kcal} unit="kcal" marks={ramenMarks} />
            <div className="mt-2">
              <LineChart
                points={weightPoints}
                color={HEALTH_COLORS.weight}
                unit="kg"
                valueFormat={(v) => v.toFixed(1)}
                height={130}
                marks={ramenMarks}
              />
            </div>
          </Section>

          {/* ラーメンを食べた日／食べなかった日 */}
          <Section>
            <ChartTitle
              color={HEALTH_COLORS.ramen}
              title="ラーメンを食べた日と、食べなかった日"
              hint="同じ日の平均を並べただけ"
            />
            {!ramenCompare || ramenCompare.ate.days === 0 ? (
              <p className="py-3 text-sm text-gray-400">
                この期間にラーメンの記録がありません。
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[22rem] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="py-1.5 pr-3 font-medium"> </th>
                        <th className="py-1.5 pr-3 text-right font-medium">食べた日</th>
                        <th className="py-1.5 text-right font-medium">食べなかった日</th>
                      </tr>
                    </thead>
                    <tbody className="text-gray-700">
                      <tr className="border-b border-gray-100">
                        <td className="py-2 pr-3 text-gray-500">日数</td>
                        <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                          {ramenCompare.ate.days}日
                        </td>
                        <td className="py-2 text-right font-semibold tabular-nums">
                          {ramenCompare.not.days}日
                        </td>
                      </tr>
                      <CompareRow
                        label="摂取カロリー"
                        unit="kcal"
                        a={ramenCompare.ate.kcal}
                        aDays={ramenCompare.ate.kcalDays}
                        b={ramenCompare.not.kcal}
                        bDays={ramenCompare.not.kcalDays}
                      />
                      <CompareRow
                        label="歩数"
                        unit="歩"
                        a={ramenCompare.ate.steps}
                        aDays={ramenCompare.ate.stepsDays}
                        b={ramenCompare.not.steps}
                        bDays={ramenCompare.not.stepsDays}
                      />
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-gray-500">
                  これは同じ日の平均を並べただけで、原因と結果を示すものではありません。ラーメンを食べる日は外出や
                  出張と重なりやすいなど、他の要素も一緒に動いています。
                  <br />
                  体重は平均の比較に入れていません。体重はその日の食事ではなく、それ以前の期間の積み上げで動くため、
                  「食べた日の体重平均」を並べても比較として成り立たないからです（上のグラフに印だけ出しています）。
                  <br />
                  集計は {fmtDay(ramenCompare.until)} まで。それ以降はラーメンの記録が付いていないため、
                  「食べていない」のか「まだ記録していない」のか区別できないので対象外にしています。
                  {stepsDataNotes && (
                    <>
                      <br />
                      歩数の平均は、上の「歩数の推移」に出している取り込みの注意がそのまま当てはまります。
                    </>
                  )}
                </p>
              </>
            )}
            {/* ラーメン記録の本体ページへの導線 */}
            <p className="mt-3 text-sm">
              <Link href="/ramen" className="font-semibold text-indigo-600 active:opacity-70">
                🍜 ラーメンページへ →
              </Link>
            </p>
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

          {/* 取り込み状況 */}
          <div ref={statusRef} className="scroll-mt-4">
            <IngestStatusSection status={status} />
          </div>

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
                <table className="w-full min-w-[40rem] text-left text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-3 font-medium">日付</th>
                      <th className="py-1.5 pr-3 font-medium">体重</th>
                      <th className="py-1.5 pr-3 font-medium">体脂肪率</th>
                      <th className="py-1.5 pr-3 font-medium">歩数</th>
                      <th className="py-1.5 pr-3 font-medium">摂取kcal</th>
                      <th className="py-1.5 pr-3 font-medium">睡眠</th>
                      <th className="py-1.5 pr-3 font-medium">散歩/出張</th>
                      <th className="py-1.5 pr-3 font-medium">ラーメン</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days
                      .slice(-30)
                      .reverse()
                      .map((d) => {
                        const m = manual[d.day];
                        return (
                          <tr key={d.day} className="border-b border-gray-100 text-gray-700">
                            <td className="py-1.5 pr-3 tabular-nums">{fmtDay(d.day)}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{d.weight_kg ?? "—"}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{d.body_fat_pct ?? "—"}</td>
                            <td
                              className={`py-1.5 pr-3 tabular-nums ${
                                stepsGoal != null && d.steps != null && d.steps >= stepsGoal
                                  ? "font-semibold text-emerald-700"
                                  : ""
                              }`}
                            >
                              {d.steps?.toLocaleString() ?? "—"}
                            </td>
                            <td className="py-1.5 pr-3 tabular-nums">{d.kcal?.toLocaleString() ?? "—"}</td>
                            <td className="py-1.5 pr-3 tabular-nums">
                              {m?.sleep_hours != null ? `${m.sleep_hours}h` : "—"}
                            </td>
                            <td className="py-1.5 pr-3">
                              {m?.morning_walk != null ? "🚶" : ""}
                              {m?.business_trip != null ? "✈️" : ""}
                              {m?.morning_walk == null && m?.business_trip == null ? "—" : ""}
                            </td>
                            <td className="py-1.5 pr-3">{ramenDaySet.has(d.day) ? "🍜" : "—"}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <p className="mt-6 text-center text-xs text-gray-400">
            集計期間 {data?.from ? fmtDay(data.from) : ""} 〜 {data?.to ? fmtDay(data.to) : ""}
            <br />
            体重・体脂肪率・BMIはHealthPlanet優先／栄養はカロミル優先／歩数はApple Health優先で集計（health_range_summary）。
            <br />
            ラーメンは ramen_logs を読むだけで、この画面から書き換えることはありません。
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

/**
 * 平均の比較1行。どちらかの母数が小さいうちは数字を出さず
 * 「まだ判断できません」と正直に出す（少ない日数の平均は簡単にひっくり返るため）。
 */
function CompareRow({
  label,
  unit,
  a,
  aDays,
  b,
  bDays,
}: {
  label: string;
  unit: string;
  a: number | null;
  aDays: number;
  b: number | null;
  bDays: number;
}) {
  const enough =
    a != null && b != null && aDays >= MIN_DAYS_FOR_COMPARISON && bDays >= MIN_DAYS_FOR_COMPARISON;
  return (
    <tr className="border-b border-gray-100">
      <td className="py-2 pr-3 text-gray-500">{label}の平均</td>
      {enough ? (
        <>
          <td className="py-2 pr-3 text-right font-semibold tabular-nums">
            {Math.round(a).toLocaleString()}
            {unit}
            <span className="ml-1 block text-[0.6875rem] font-normal text-gray-400">{aDays}日</span>
          </td>
          <td className="py-2 text-right font-semibold tabular-nums">
            {Math.round(b).toLocaleString()}
            {unit}
            <span className="ml-1 block text-[0.6875rem] font-normal text-gray-400">{bDays}日</span>
          </td>
        </>
      ) : (
        <td colSpan={2} className="py-2 text-right text-xs text-gray-400">
          記録のある日が少なく（{aDays}日 / {bDays}日）、まだ判断できません
        </td>
      )}
    </tr>
  );
}
