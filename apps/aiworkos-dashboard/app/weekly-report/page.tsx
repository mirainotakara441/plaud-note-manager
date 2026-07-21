"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

// 週報ダッシュボード：自治体・事業者・議員・委託企業まわりの週次活動を、
// カテゴリー別に1枚で確認する。データは /api/weekly-report（Supabase・読み取り専用）。
// 登録は週報登録スキル側で行う。このページは閲覧専用。

type Row = {
  week_start: string; // YYYY-MM-DD
  category: string;
  organization: string | null;
  summary: string;
  insight: string | null;
  tactic: string | null;
  created_at: string;
};

type ApiResponse = {
  week_start: string | null;
  rows: Row[];
  available_weeks: string[];
  error?: string;
};

const CATEGORIES = [
  "全体",
  "支店",
  "自治体",
  "事業者",
  "議員",
  "委託企業",
  "銀行",
  "プロモーション",
] as const;

function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 与えられた日付が属する週の月曜日を返す
function toMonday(d: Date): string {
  const day = d.getDay(); // 0=日, 1=月, ...
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return fmtYMD(monday);
}

function addDays(ymd: string, days: number): string {
  const d = parseYMD(ymd);
  d.setDate(d.getDate() + days);
  return fmtYMD(d);
}

function fmtRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const [, em, ed] = end.split("-");
  return `${weekStart}〜${em}-${ed}`;
}

export default function WeeklyReportPage() {
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(week?: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = week ? `?week=${week}` : "";
      const res = await fetch(`/api/weekly-report${qs}`, { cache: "no-store" });
      const data: ApiResponse = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setWeekStart(data.week_start);
      setRows(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function goToWeek(week: string) {
    load(week);
  }

  function handleDateChange(value: string) {
    if (!value) return;
    const monday = toMonday(parseYMD(value));
    goToWeek(monday);
  }

  function handlePrev() {
    if (!weekStart) return;
    goToWeek(addDays(weekStart, -7));
  }

  function handleNext() {
    if (!weekStart) return;
    goToWeek(addDays(weekStart, 7));
  }

  // KPI集計
  const kpi = useMemo(() => {
    const contactRows = rows.filter((r) => r.category !== "全体");
    const orgs = new Set(
      rows.filter((r) => r.organization).map((r) => r.organization as string)
    );
    const withTactic = rows.filter((r) => r.tactic).length;
    return {
      contacts: contactRows.length,
      orgs: orgs.size,
      withTactic,
    };
  }, [rows]);

  // カテゴリー別にグループ化
  const byCategory = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const cat of CATEGORIES) map.set(cat, []);
    for (const r of rows) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return map;
  }, [rows]);

  const overall = byCategory.get("全体") ?? [];
  const otherCategories = CATEGORIES.filter((c) => c !== "全体");

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          週報ダッシュボード
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          自治体・事業者・議員・委託企業まわりの週次活動を、カテゴリー別に1枚で
        </p>
      </header>

      {/* 週ナビゲーション */}
      <div className="mb-5 flex items-center gap-2">
        <button
          onClick={handlePrev}
          disabled={!weekStart}
          className="rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200 active:scale-95 disabled:opacity-40"
          aria-label="前週"
        >
          ←
        </button>
        <input
          type="date"
          value={weekStart ?? ""}
          onChange={(e) => handleDateChange(e.target.value)}
          className="min-w-0 flex-1 rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200"
        />
        <button
          onClick={handleNext}
          disabled={!weekStart}
          className="rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200 active:scale-95 disabled:opacity-40"
          aria-label="次週"
        >
          →
        </button>
      </div>

      {weekStart && (
        <h2 className="mb-4 text-sm font-bold text-gray-500">
          {fmtRange(weekStart)}
        </h2>
      )}

      {loading && (
        <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>
      )}
      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      {!loading && !error && (
        <>
          {/* KPI */}
          <div className="mb-5 grid grid-cols-3 gap-2">
            {[
              { l: "訪問・接点件数", v: kpi.contacts, c: "text-gray-900" },
              { l: "対象団体数", v: kpi.orgs, c: "text-gray-900" },
              { l: "次アクションあり", v: kpi.withTactic, c: "text-amber-600" },
            ].map((m) => (
              <div key={m.l} className="rounded-xl bg-gray-50 px-2 py-3 text-center">
                <div className={`text-xl font-bold ${m.c}`}>{m.v}</div>
                <div className="mt-0.5 text-[11px] text-gray-500">{m.l}</div>
              </div>
            ))}
          </div>

          {/* 全体 */}
          <div className="mb-5">
            <h3 className="mb-2 text-sm font-bold text-gray-500">全体</h3>
            {overall.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-sm text-gray-400">今週の記録なし</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed text-gray-700">
                  {overall
                    .flatMap((r) => r.summary.split("\n"))
                    .filter((line) => line.trim().length > 0)
                    .map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                </ul>
              </div>
            )}
          </div>

          {/* カテゴリー別 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {otherCategories.map((cat) => {
              const items = byCategory.get(cat) ?? [];
              return (
                <div
                  key={cat}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <h3 className="mb-2 text-sm font-bold text-gray-500">{cat}</h3>
                  {items.length === 0 ? (
                    <p className="text-sm text-gray-400">今週の記録なし</p>
                  ) : (
                    <div className="space-y-3">
                      {items.map((r, i) => (
                        <div
                          key={`${r.organization ?? "x"}-${i}`}
                          className={i > 0 ? "border-t border-gray-100 pt-3" : ""}
                        >
                          {r.organization && (
                            <h4 className="text-sm font-bold text-gray-900">
                              {r.organization}
                            </h4>
                          )}
                          <p className="mt-1 text-sm leading-relaxed text-gray-700">
                            {r.summary}
                          </p>
                          {r.insight && (
                            <p className="mt-1 text-xs leading-relaxed text-gray-400">
                              {r.insight}
                            </p>
                          )}
                          {r.tactic && (
                            <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
                              <span className="font-medium">次：</span>
                              {r.tactic}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
