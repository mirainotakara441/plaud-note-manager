"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Claude利用時間の週ごとの推移。
//
// ホームの作戦盤にある4枚のうち、この「今週のClaude利用時間」だけが飛び先を
// 持っていなかった。合計だけ見えても、増えたのか減ったのかは前の週と並べないと
// 分からない。ここは並べて見るための画面。
//
// 元データ（claude_usage_daily）は launchd の1時間ごとの集計が書いている。
// これが黙って止まると、画面上は「0h」と「本当に使っていない」が同じ見え方に
// なるため、最終更新日の古さを最初に言う。

type WeekRow = {
  week_start: string;
  week_end: string;
  hours: number;
  days_logged: number;
  avg_per_logged_day: number;
  peak_hours: number;
  peak_date: string | null;
  is_current_week: boolean;
  before_measurement: boolean;
};

type DayRow = { work_date: string; hours: number; note: string | null };

type Payload = {
  today: string;
  weeks: WeekRow[];
  days: DayRow[];
  total: number;
  range_weeks: number;
  week_choices: number[];
  last_data_date: string | null;
  first_data_date: string | null;
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];

function md(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${m}/${d}`;
}

function weekdayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 2つの日付の差（日数）。どちらも YYYY-MM-DD。 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** 「8/17〜8/23」。年は跨いだときだけ足す。 */
function weekLabel(w: WeekRow): string {
  const sameYear = w.week_start.slice(0, 4) === w.week_end.slice(0, 4);
  return sameYear
    ? `${md(w.week_start)}〜${md(w.week_end)}`
    : `${w.week_start.slice(0, 4)}/${md(w.week_start)}〜${w.week_end.slice(0, 4)}/${md(w.week_end)}`;
}

export default function ClaudeUsagePage() {
  const [weeks, setWeeks] = useState(8);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (w: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/claude-usage?weeks=${w}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `取得失敗 ${res.status}`);
      setData(json as Payload);
    } catch (e) {
      // ★空データを入れて「記録がありません」に見せない。失敗は失敗として出す。
      setError(e instanceof Error ? e.message : "取得に失敗しました");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(weeks);
  }, [load, weeks]);

  const rows = data?.weeks ?? [];
  const maxHours = rows.reduce((a, w) => Math.max(a, w.hours), 0);

  // 今週と前週。今週はまだ途中なので「前週比」は出さず、並べて見せるだけにする
  // （週の途中で赤字が出ても意味が無い）。
  const current = rows.find((w) => w.is_current_week) ?? null;
  const previous = current ? rows[rows.indexOf(current) + 1] ?? null : null;

  // 今週を除いた完了済みの週での平均。今週を混ぜると必ず低く出る。
  const finished = rows.filter((w) => !w.is_current_week && w.days_logged > 0);
  const avgFinished =
    finished.length > 0
      ? Math.round((finished.reduce((s, w) => s + w.hours, 0) / finished.length) * 10) / 10
      : null;

  // 元データの古さ。1日ぶんの遅れは集計の間隔で普通に起きるので、2日以上で言う。
  const staleDays =
    data?.last_data_date && data?.today ? daysBetween(data.last_data_date, data.today) : null;
  const isStale = staleDays != null && staleDays >= 2;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">Claude利用時間</h1>
        <p className="mt-1 text-sm text-gray-500">
          週ごと（月〜日）の合計。15分以上あいたら休憩として切った実測値。
        </p>
      </header>

      {/* 元データが止まっているときは、数字より先にそれを言う。
          「0h」を見て使っていないと誤解するのが一番まずい。 */}
      {isStale && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <span className="font-bold">元データが{staleDays}日ぶん止まっています</span>
          <span className="block text-xs">
            最終記録は{data?.last_data_date}。集計（launchd の com.aiworkos.claude-usage）が
            動いているか確認してください。
          </span>
        </div>
      )}

      {/* 期間切替 */}
      <div className="mb-4 flex gap-2">
        {(data?.week_choices ?? [4, 8, 12, 26]).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWeeks(w)}
            className={`min-h-[40px] flex-1 rounded-xl border px-3 text-sm font-bold transition active:scale-95 ${
              weeks === w
                ? "border-indigo-600 bg-indigo-600 text-white"
                : "border-gray-300 bg-white text-gray-600"
            }`}
          >
            {w}週
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl border border-gray-200 bg-gray-100" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-3 text-sm text-rose-700">
          <p className="font-bold">取得できませんでした</p>
          <p className="mt-0.5 text-xs">{error}</p>
          <button
            type="button"
            onClick={() => void load(weeks)}
            className="mt-2 w-full rounded-xl border border-rose-300 bg-white py-2 text-sm font-bold text-rose-700 transition active:bg-rose-100"
          >
            再読み込み
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* 要約3枚 */}
          <div className="mb-5 grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-bold text-gray-500">今週</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{current?.hours ?? 0}h</p>
              <p className="mt-0.5 text-xs text-gray-400">
                {current && current.days_logged > 0 ? `${current.days_logged}日ぶん` : "まだ記録なし"}
              </p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-bold text-gray-500">前の週</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{previous?.hours ?? 0}h</p>
              <p className="mt-0.5 text-xs text-gray-400">確定値</p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-bold text-gray-500">週の平均</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">
                {avgFinished != null ? `${avgFinished}h` : "—"}
              </p>
              <p className="mt-0.5 text-xs text-gray-400">今週を除く{finished.length}週</p>
            </div>
          </div>

          {/* 週ごとの棒 */}
          <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold text-gray-500">週ごとの合計</h2>
              <span className="text-[0.6875rem] text-gray-400">月〜日</span>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-gray-400">この期間の記録はまだありません。</p>
            ) : (
              <ul className="space-y-2.5">
                {rows.map((w) => (
                  <li key={w.week_start} className="flex items-center gap-2">
                    <span className="w-[5.5rem] shrink-0 text-sm tabular-nums text-gray-500">
                      {weekLabel(w)}
                    </span>
                    <span className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100">
                      {/* 計測開始前の週に棒は引かない。0hの棒を引くと
                          「使わなかった週」と見分けがつかなくなる。 */}
                      {!w.before_measurement && (
                        <span
                          className="block h-full rounded-full bg-indigo-500"
                          style={{
                            width: `${maxHours > 0 ? Math.max((w.hours / maxHours) * 100, 2) : 2}%`,
                            // 今週はまだ途中で、確定した週と同じ濃さで並べると
                            // 「落ちこんだ週」に見えてしまう。薄くして区別する。
                            opacity: w.is_current_week ? 0.45 : 1,
                          }}
                        />
                      )}
                    </span>
                    <span
                      className={`w-14 shrink-0 text-right tabular-nums ${
                        w.before_measurement
                          ? "text-xs text-gray-400"
                          : "text-sm font-bold text-gray-900"
                      }`}
                    >
                      {w.before_measurement ? "未計測" : `${w.hours}h`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {current && (
              <p className="mt-3 border-t border-gray-100 pt-2.5 text-xs text-gray-400">
                薄い棒が今週（{weekLabel(current)}）。まだ途中なので確定値ではありません。
                {rows.some((w) => w.before_measurement) && data.first_data_date && (
                  <>　「未計測」は集計を始める前の週です（開始：{data.first_data_date}）。</>
                )}
              </p>
            )}
          </section>

          {/* 週ごとの内訳 */}
          {rows.some((w) => w.days_logged > 0) && (
            <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-bold text-gray-500">週ごとの内訳</h2>
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="w-full min-w-[26rem] text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                      <th className="pb-2 pr-2 font-bold">週</th>
                      <th className="pb-2 pr-2 text-right font-bold">合計</th>
                      <th className="pb-2 pr-2 text-right font-bold">触れた日</th>
                      <th className="pb-2 pr-2 text-right font-bold">1日平均</th>
                      <th className="pb-2 text-right font-bold">最長の日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w) => (
                      <tr key={w.week_start} className="border-b border-gray-100 last:border-0">
                        <td className="py-2 pr-2 tabular-nums text-gray-600">
                          {weekLabel(w)}
                          {w.is_current_week && (
                            <span className="ml-1 rounded bg-indigo-50 px-1 text-[0.625rem] font-bold text-indigo-600">
                              今週
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right font-bold tabular-nums text-gray-900">
                          {w.before_measurement ? (
                            <span className="text-xs font-normal text-gray-400">未計測</span>
                          ) : (
                            `${w.hours}h`
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-gray-600">
                          {w.before_measurement ? "—" : `${w.days_logged}日`}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-gray-600">
                          {w.days_logged > 0 ? `${w.avg_per_logged_day}h` : "—"}
                        </td>
                        <td className="py-2 text-right tabular-nums text-gray-600">
                          {w.peak_date ? `${w.peak_hours}h（${md(w.peak_date)}）` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 日別（直近28日） */}
          <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold text-gray-500">日ごと</h2>
              <span className="text-[0.6875rem] text-gray-400">直近28日</span>
            </div>
            {data.days.length === 0 ? (
              <p className="text-sm text-gray-400">記録がありません。</p>
            ) : (
              <ul className="space-y-1.5">
                {data.days.map((d) => (
                  <li key={d.work_date} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-sm tabular-nums text-gray-500">
                      {md(d.work_date)}（{weekdayOf(d.work_date)}）
                    </span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <span
                        className="block h-full rounded-full bg-indigo-400"
                        style={{
                          width: `${Math.min(100, Math.max((d.hours / 12) * 100, d.hours > 0 ? 2 : 0))}%`,
                        }}
                      />
                    </span>
                    <span className="w-12 shrink-0 text-right text-sm tabular-nums text-gray-700">
                      {d.hours}h
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-gray-100 pt-2.5 text-xs text-gray-400">
              棒の物差しは1日12時間。
              {data.last_data_date && <>　最終記録：{data.last_data_date}</>}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
