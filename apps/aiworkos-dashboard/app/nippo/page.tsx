"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

// 日報録：CCDセッション横断で集約した日次の作業ログ（daily_work_log）を、
// 日付ごとに束ねて一覧する。何を実施し、何が生まれ、何が残っているかを1画面で。
// データは /api/nippo（Supabase・読み取り専用）。集約・書き込みはClaude Code側で行う。

type Status = "completed" | "follow_up" | "in_progress" | "blocked";

type Deliverable = {
  name: string;
  type?: string;
  status?: string;
  url?: string;
};

type Log = {
  id: number;
  work_date: string; // YYYY-MM-DD
  session_title: string;
  session_id: string | null;
  workstream: string | null;
  summary: string[] | null;
  deliverables: Deliverable[] | null;
  status: Status;
  next_action: string | null;
  source: string;
  created_at: string;
};

const STATUS_META: Record<Status, { label: string; klass: string }> = {
  completed: { label: "完了", klass: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  follow_up: { label: "要フォロー", klass: "bg-amber-50 text-amber-700 ring-amber-200" },
  in_progress: { label: "進行中", klass: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  blocked: { label: "要再実行", klass: "bg-rose-50 text-rose-700 ring-rose-200" },
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${y}年${m}月${day}日（${wd}）`;
}

type Filter = "all" | "open" | Status;

export default function NippoPage() {
  const [items, setItems] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/nippo", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  // KPI集計
  const kpi = useMemo(() => {
    const days = new Set(items.map((it) => it.work_date));
    const completed = items.filter((it) => it.status === "completed").length;
    const open = items.filter((it) => it.status !== "completed").length;
    return { total: items.length, days: days.size, completed, open };
  }, [items]);

  // フィルタ適用
  const filtered = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "open") return items.filter((it) => it.status !== "completed");
    return items.filter((it) => it.status === filter);
  }, [items, filter]);

  // 日付ごとにグループ化（既に work_date desc で来ている）
  const groups = useMemo(() => {
    const map = new Map<string, Log[]>();
    for (const it of filtered) {
      const arr = map.get(it.work_date) ?? [];
      arr.push(it);
      map.set(it.work_date, arr);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "すべて" },
    { key: "open", label: "要対応" },
    { key: "completed", label: "完了" },
    { key: "blocked", label: "要再実行" },
  ];

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          日報録
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          各セッションで何をどこまで進めたかの記録。日付ごとに束ねて表示。
        </p>
      </header>

      {/* KPI */}
      <div className="mb-5 grid grid-cols-4 gap-2">
        {[
          { l: "セッション", v: kpi.total, c: "text-gray-900" },
          { l: "活動日数", v: kpi.days, c: "text-gray-900" },
          { l: "完了", v: kpi.completed, c: "text-emerald-600" },
          { l: "要対応", v: kpi.open, c: "text-amber-600" },
        ].map((m) => (
          <div key={m.l} className="rounded-xl bg-gray-50 px-2 py-3 text-center">
            <div className={`text-xl font-bold ${m.c}`}>{m.v}</div>
            <div className="mt-0.5 text-[11px] text-gray-500">{m.l}</div>
          </div>
        ))}
      </div>

      {/* フィルタ */}
      <div className="mb-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
              filter === f.key
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 ring-1 ring-gray-200"
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={load}
          className="ml-auto rounded-full px-3 py-1 text-sm text-gray-400 ring-1 ring-gray-200 active:scale-95"
          aria-label="再読み込み"
        >
          ↻
        </button>
      </div>

      {loading && (
        <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>
      )}
      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      {!loading && !error && groups.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-400">
          該当する記録がありません。
        </p>
      )}

      <div className="space-y-6">
        {groups.map(([date, logs]) => (
          <section key={date}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-gray-500">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" aria-hidden />
              {fmtDate(date)}
              <span className="text-xs font-normal text-gray-400">
                {logs.length}件
              </span>
            </h2>
            <div className="space-y-3">
              {logs.map((it) => {
                const sm = STATUS_META[it.status];
                return (
                  <article
                    key={it.id}
                    className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-bold leading-snug text-gray-900">
                          {it.session_title}
                        </h3>
                        {it.workstream && (
                          <span className="mt-0.5 inline-block text-xs text-gray-400">
                            {it.workstream}
                          </span>
                        )}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${sm.klass}`}
                      >
                        {sm.label}
                      </span>
                    </div>

                    {Array.isArray(it.summary) && it.summary.length > 0 && (
                      <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed text-gray-700">
                        {it.summary.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}

                    {Array.isArray(it.deliverables) &&
                      it.deliverables.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {it.deliverables.map((d, i) => {
                            const chip = (
                              <span className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-600">
                                📎 {d.name}
                                {d.status && (
                                  <span className="text-gray-400">・{d.status}</span>
                                )}
                              </span>
                            );
                            return d.url ? (
                              <a
                                key={i}
                                href={d.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="active:opacity-70"
                              >
                                {chip}
                              </a>
                            ) : (
                              <span key={i}>{chip}</span>
                            );
                          })}
                        </div>
                      )}

                    {it.next_action && (
                      <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
                        <span className="font-medium">次：</span>
                        {it.next_action}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>

      <p className="mt-4 text-center text-xs leading-relaxed text-gray-400">
        集約・書き込みは Claude Code 側で実施（daily_work_log）。
        <br />
        このページは読み取り専用の閲覧ビューです。
      </p>
    </main>
  );
}
