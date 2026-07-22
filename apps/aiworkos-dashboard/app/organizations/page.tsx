"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 団体別タイムライン：団体を選ぶと、会議・週報・成果物を時系列で1画面に並べる
// ミニCRM的なページ。日記は意味検索で「関連しそうな日記」として別枠で補助表示する。
// データは /api/organizations（一覧）・/api/organizations/timeline（本体）。
// 閲覧専用（読み取りのみ）。

type Organization = { name: string; count: number };

type TimelineEntry = {
  id: string;
  kind: "会議" | "成果物" | "週報";
  date: string;
  title: string;
  summary: string;
  url?: string;
};

type DiaryResult = {
  id: string;
  source_type: string;
  source_id: string;
  organization: string | null;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
};

type TimelineResponse = {
  organization: string;
  timeline: TimelineEntry[];
  relatedDiaries: DiaryResult[];
};

const KIND_BADGE: Record<TimelineEntry["kind"], string> = {
  会議: "bg-blue-100 text-blue-700",
  週報: "bg-cyan-100 text-cyan-700",
  成果物: "bg-amber-100 text-amber-700",
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function TimelineCard({ entry }: { entry: TimelineEntry }) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${KIND_BADGE[entry.kind]}`}
        >
          {entry.kind}
        </span>
        <span className="text-xs text-gray-500">{formatDate(entry.date)}</span>
      </div>
      <h3 className="mt-2 text-base font-bold leading-snug text-gray-900">
        {entry.title}
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-700">
        {truncate(entry.summary, 150)}
      </p>
    </article>
  );
}

function DiaryCard({ diary }: { diary: DiaryResult }) {
  return (
    <article className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
          日記
        </span>
        {diary.event_date && (
          <span className="text-xs text-gray-500">{formatDate(diary.event_date)}</span>
        )}
        <span className="ml-auto text-xs font-medium text-emerald-600">
          類似度 {Math.round(diary.similarity * 100)}%
        </span>
      </div>
      <h4 className="mt-2 text-sm font-bold leading-snug text-gray-900">
        {diary.title}
      </h4>
      <p className="mt-1 text-sm leading-relaxed text-gray-700">
        {truncate(diary.content, 150)}
      </p>
    </article>
  );
}

function OrganizationsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const presetOrg = searchParams.get("org") ?? "";

  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [selected, setSelected] = useState(presetOrg);

  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/organizations");
        const json: unknown = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok) {
          const message =
            json && typeof json === "object" && "error" in json &&
            typeof (json as { error?: unknown }).error === "string"
              ? (json as { error: string }).error
              : "団体一覧の取得に失敗しました";
          setOrgsError(message);
          return;
        }
        const list =
          json && typeof json === "object" && Array.isArray((json as { organizations?: unknown }).organizations)
            ? ((json as { organizations: Organization[] }).organizations)
            : [];
        setOrgs(list);
      } catch {
        if (active) setOrgsError("団体一覧の取得に失敗しました");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadTimeline = useCallback(async (org: string) => {
    if (!org) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(
        `/api/organizations/timeline?org=${encodeURIComponent(org)}`,
        { cache: "no-store" }
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          json && typeof json === "object" && "error" in json &&
          typeof (json as { error?: unknown }).error === "string"
            ? (json as { error: string }).error
            : "取得に失敗しました";
        setError(message);
        return;
      }
      setData(json as TimelineResponse);
    } catch {
      setError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (presetOrg) loadTimeline(presetOrg);
  }, [presetOrg, loadTimeline]);

  function handleSelect(org: string) {
    setSelected(org);
    router.push(org ? `/organizations?org=${encodeURIComponent(org)}` : "/organizations");
    if (org) loadTimeline(org);
  }

  const sortedOrgs = useMemo(() => {
    if (!orgs) return [];
    return [...orgs].sort((a, b) => b.count - a.count);
  }, [orgs]);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-600 active:opacity-70"
        >
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          団体別タイムライン
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          団体を選ぶと、会議・週報・成果物を時系列で1画面に確認できます
        </p>
      </header>

      {/* 団体セレクタ */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <label
          htmlFor="org-select"
          className="block text-sm font-medium text-gray-600"
        >
          団体を選択
        </label>
        <select
          id="org-select"
          value={selected}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={!orgs}
          className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
        >
          <option value="">
            {orgs ? "団体を選んでください" : "読み込み中..."}
          </option>
          {sortedOrgs.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name}（会議 {o.count}件）
            </option>
          ))}
        </select>
        {orgsError && <p className="mt-2 text-sm text-red-600">{orgsError}</p>}
      </div>

      {/* 本体 */}
      <section className="mt-6" aria-live="polite">
        {!selected && !loading && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center">
            <p className="text-sm leading-relaxed text-gray-600">
              団体を選んでください。
              <br />
              会議・週報・成果物を時系列でまとめて表示します。
            </p>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center gap-3 py-12">
            <div
              className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
              role="status"
              aria-label="読み込み中"
            />
            <p className="text-sm text-gray-500">読み込み中…</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-8">
            <div>
              <h2 className="mb-3 text-lg font-bold text-gray-900">
                {data.organization} のタイムライン
              </h2>
              {data.timeline.length > 0 ? (
                <div className="space-y-3">
                  {data.timeline.map((entry) => (
                    <TimelineCard key={entry.id} entry={entry} />
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
                  記録がありません。
                </p>
              )}
            </div>

            <div>
              <h2 className="mb-1 text-lg font-bold text-gray-900">
                関連しそうな日記
              </h2>
              <p className="mb-3 text-xs text-gray-400">
                ※AIが意味的に関連しそうと判断した日記です。時系列本体とは確度が異なる参考情報です。
              </p>
              {data.relatedDiaries.length > 0 ? (
                <div className="space-y-3">
                  {data.relatedDiaries.map((diary) => (
                    <DiaryCard key={diary.id} diary={diary} />
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 bg-white/60 p-4 text-sm text-gray-400">
                  関連しそうな日記は見つかりませんでした。
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

export default function OrganizationsPage() {
  return (
    <Suspense
      fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}
    >
      <OrganizationsInner />
    </Suspense>
  );
}
