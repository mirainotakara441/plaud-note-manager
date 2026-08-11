"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// 「その月に何をしたか」を、書いた振り返りではなく残っている記録から見る面。
// 中身は /api/retrospective/month。
//
// 月次の振り返りは月末に書くもので、書いていない月は空になる。だが記録そのものは
// 毎日溜まっている。振り返りを書くときも読み返すときも要るのは「実際に何があったか」
// なので、そちらを機械的に並べる。要約はしない——事実を並べる場所で、
// 文章にする役は月報ドラフト(/monthly-report)が既に持っている。

type WeeklyRow = {
  week_start: string;
  category: string;
  organization: string | null;
  summary: string | null;
  insight: string | null;
  tactic: string | null;
};

type MonthActivity = {
  month: string;
  start: string;
  end: string;
  weekly: WeeklyRow[];
  byCategory: { category: string; count: number }[];
  organizations: { name: string; weeks: number; meetings: number; deliverables: number }[];
  counts: { weekly: number; meetings: number; deliverables: number; diaries: number };
  tactics: { organization: string | null; tactic: string }[];
  error?: string;
};

const CAT_STYLE: Record<string, string> = {
  自治体: "bg-sky-100 text-sky-800",
  議員: "bg-indigo-100 text-indigo-800",
  事業者: "bg-emerald-100 text-emerald-800",
  委託会社: "bg-teal-100 text-teal-800",
  銀行: "bg-amber-100 text-amber-800",
  支店: "bg-violet-100 text-violet-800",
  プロモーション: "bg-pink-100 text-pink-800",
  全体: "bg-gray-200 text-gray-700",
};

/** JSTの今月（YYYY-MM）。 */
function thisMonth(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function label(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}

function weekLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}週`;
}

export default function MonthView() {
  const [month, setMonth] = useState<string>(thisMonth);
  const [data, setData] = useState<MonthActivity | null>(null);
  const [failed, setFailed] = useState(false);
  const [openWeekly, setOpenWeekly] = useState(false);

  const load = useCallback(async (m: string) => {
    setData(null);
    setFailed(false);
    try {
      const r = await fetch(`/api/retrospective/month?month=${m}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData(await r.json());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load(month);
  }, [load, month]);

  return (
    <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {/* 月送り。振り返りは前の月と見比べる作業なので、行き来を軽くする */}
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label="前の月"
          className="rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-600 active:bg-gray-200"
        >
          ←
        </button>
        <p className="flex-1 text-center text-base font-bold text-gray-900">{label(month)}</p>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          disabled={month >= thisMonth()}
          aria-label="次の月"
          className="rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-600 active:bg-gray-200 disabled:opacity-30"
        >
          →
        </button>
      </div>

      {failed && <p className="text-sm text-red-600">取得できませんでした</p>}
      {!data && !failed && (
        <div className="h-32 animate-pulse rounded-xl border border-gray-200 bg-gray-100" />
      )}

      {data && (
        <>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {[
              { label: "週報", value: data.counts.weekly, unit: "行" },
              { label: "会議", value: data.counts.meetings, unit: "件" },
              { label: "成果物", value: data.counts.deliverables, unit: "件" },
              { label: "日記", value: data.counts.diaries, unit: "日" },
            ].map((k) => (
              <div key={k.label} className="rounded-xl bg-gray-50 px-2 py-2 text-center">
                <p className="text-xs font-medium text-gray-500">{k.label}</p>
                <p className="text-xl font-bold text-gray-900">{k.value}</p>
                <p className="text-[0.6875rem] text-gray-400">{k.unit}</p>
              </div>
            ))}
          </div>

          {data.counts.weekly === 0 && data.counts.meetings === 0 && (
            <p className="rounded-xl bg-gray-50 px-3 py-4 text-center text-sm text-gray-500">
              この月の記録はまだありません
            </p>
          )}

          {data.byCategory.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {data.byCategory.map((c) => (
                <span
                  key={c.category}
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    CAT_STYLE[c.category] ?? "bg-gray-100 text-gray-700"
                  }`}
                >
                  {c.category} {c.count}
                </span>
              ))}
            </div>
          )}

          {data.organizations.length > 0 && (
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-bold text-gray-900">動いた相手</p>
              <ul className="space-y-1">
                {data.organizations.slice(0, 12).map((o) => (
                  <li
                    key={o.name}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-gray-50 px-2.5 py-1.5"
                  >
                    <Link
                      href={`/organizations?org=${encodeURIComponent(o.name)}`}
                      className="min-w-[6rem] flex-1 basis-[6rem] truncate text-sm font-semibold text-gray-900 active:opacity-70"
                    >
                      {o.name}
                    </Link>
                    {o.weeks > 0 && (
                      <span className="shrink-0 text-[0.6875rem] text-gray-500">週報{o.weeks}週</span>
                    )}
                    {o.meetings > 0 && (
                      <span className="shrink-0 text-[0.6875rem] text-gray-500">会議{o.meetings}</span>
                    )}
                    {o.deliverables > 0 && (
                      <span className="shrink-0 text-[0.6875rem] text-gray-500">
                        成果物{o.deliverables}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {data.organizations.length > 12 && (
                <p className="mt-1 text-xs text-gray-400">
                  ほか {data.organizations.length - 12}団体
                </p>
              )}
            </div>
          )}

          {/* 宿題は翌月に持ち越す材料。振り返りを書くときの一次資料になる */}
          {data.tactics.length > 0 && (
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-bold text-gray-900">
                この月に書いた宿題
                <span className="ml-1 font-medium text-gray-400">{data.tactics.length}件</span>
              </p>
              <ul className="space-y-1">
                {data.tactics.map((t, i) => (
                  <li key={i} className="rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-1.5">
                    <span className="text-sm leading-snug text-amber-900">
                      {t.organization && (
                        <span className="mr-1 font-semibold">{t.organization}：</span>
                      )}
                      {t.tactic}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.weekly.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpenWeekly((v) => !v)}
                className="w-full rounded-xl border border-gray-200 py-2 text-sm font-bold text-gray-600 transition active:bg-gray-50"
              >
                {openWeekly ? "週報の中身を閉じる" : `週報の中身を見る（${data.weekly.length}行）`}
              </button>
              {openWeekly && (
                <ul className="mt-2 space-y-1.5">
                  {data.weekly.map((r, i) => (
                    <li key={i} className="rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-2">
                      <p className="mb-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[0.6875rem] text-gray-400">
                          {weekLabel(r.week_start)}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold ${
                            CAT_STYLE[r.category] ?? "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {r.category}
                        </span>
                        {r.organization && (
                          <span className="text-sm font-semibold text-gray-900">
                            {r.organization}
                          </span>
                        )}
                      </p>
                      {r.summary && (
                        <p className="text-sm leading-relaxed text-gray-700">{r.summary}</p>
                      )}
                      {r.insight && (
                        <p className="mt-0.5 text-sm leading-relaxed text-indigo-700">
                          示唆：{r.insight}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
