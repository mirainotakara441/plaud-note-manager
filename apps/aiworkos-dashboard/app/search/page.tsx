"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

type SearchResult = {
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

const SOURCE_FILTERS = ["すべて", "日記", "会議", "学び", "成果物"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

const MATCH_COUNTS = [5, 10, 20] as const;

const PERSON_FILTERS = [
  "伊藤羊一",
  "小澤隆生",
  "越川慎司",
  "澤円",
  "高橋浩一",
  "守屋実",
] as const;

const THEME_FILTERS = [
  "営業・折衝",
  "事業戦略",
  "マネジメント・組織",
  "AI・テクノロジー",
  "リーダーシップ・自己成長",
  "健康・コンディション",
  "信仰・人間性",
  "家族・人生",
] as const;

const BADGE_STYLES: Record<string, string> = {
  日記: "bg-emerald-100 text-emerald-800",
  会議: "bg-blue-100 text-blue-800",
  学び: "bg-orange-100 text-orange-800",
  成果物: "bg-purple-100 text-purple-800",
};

const TAG_KEYS = [
  "人物",
  "people",
  "persons",
  "person",
  "テーマ",
  "theme",
  "themes",
  "タグ",
  "tags",
  "keywords",
  "キーワード",
];

function extractTags(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  const tags: string[] = [];
  for (const key of TAG_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      tags.push(...value.split(/[、,]/).map((s) => s.trim()).filter(Boolean));
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string" && v.trim()) tags.push(v.trim());
      }
    }
  }
  return [...new Set(tags)].slice(0, 8);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function ResultCard({ result }: { result: SearchResult }) {
  const [expanded, setExpanded] = useState(false);
  const tags = extractTags(result.metadata);
  const isLong = result.content.length > 120;
  const badgeStyle =
    BADGE_STYLES[result.source_type] ?? "bg-gray-100 text-gray-700";

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeStyle}`}
        >
          {result.source_type}
        </span>
        {result.event_date && (
          <span className="text-xs text-gray-500">
            {formatDate(result.event_date)}
          </span>
        )}
        <span className="ml-auto text-xs font-medium text-indigo-600">
          類似度 {Math.round(result.similarity * 100)}%
        </span>
      </div>

      <h3 className="mt-2 text-base font-bold leading-snug text-gray-900">
        {result.title}
      </h3>

      <p
        className={`mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700 ${
          !expanded && isLong ? "line-clamp-4" : ""
        }`}
      >
        {result.content}
      </p>

      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-sm font-medium text-indigo-600 active:opacity-70"
        >
          {expanded ? "閉じる" : "もっと見る"}
        </button>
      )}

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("すべて");
  const [matchCount, setMatchCount] = useState<number>(10);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          ...(sourceFilter !== "すべて" ? { source_type: sourceFilter } : {}),
          match_count: matchCount,
          ...(personFilter ? { person: personFilter } : {}),
          ...(themeFilter ? { theme: themeFilter } : {}),
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            "検索中にエラーが発生しました"
        );
        setResults(null);
        return;
      }

      setResults(Array.isArray(data?.results) ? data.results : []);
    } catch {
      setError("通信エラーが発生しました。接続を確認してください。");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [query, sourceFilter, matchCount, personFilter, themeFilter, loading]);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      {/* ヘッダー */}
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-600 active:opacity-70"
        >
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          横断検索
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          日記・会議・学び・成果物を自然言語で横断検索します
        </p>
      </header>

      {/* 検索フォーム */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              }
            }}
            placeholder="例: 小澤隆生さんの営業の学び"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            aria-label="検索キーワード"
          />
          <button
            type="button"
            onClick={runSearch}
            disabled={loading || !query.trim()}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
          >
            検索
          </button>
        </div>

        {/* ソース種別フィルタ */}
        <div className="mt-3 flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => {
                setSourceFilter(filter);
                if (filter !== "学び") {
                  setPersonFilter(null);
                  setThemeFilter(null);
                }
              }}
              className={`min-h-11 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                sourceFilter === filter
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 active:bg-gray-200"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* 件数セレクタ */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-sm text-gray-500">表示件数</span>
          <div className="flex gap-1.5">
            {MATCH_COUNTS.map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => setMatchCount(count)}
                className={`min-h-11 rounded-lg px-3 py-1 text-sm font-medium transition ${
                  matchCount === count
                    ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300"
                    : "bg-gray-50 text-gray-500 active:bg-gray-100"
                }`}
              >
                {count}件
              </button>
            ))}
          </div>
        </div>

        {/* 人物・テーマ絞り込み（学びのみ） */}
        {sourceFilter === "学び" && (
          <>
            <div className="mt-3">
              <span className="text-sm text-gray-500">人物で絞る</span>
              <div className="mt-3 flex flex-wrap gap-2">
                {PERSON_FILTERS.map((person) => (
                  <button
                    key={person}
                    type="button"
                    onClick={() =>
                      setPersonFilter((prev) => (prev === person ? null : person))
                    }
                    className={`min-h-11 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                      personFilter === person
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-100 text-gray-600 active:bg-gray-200"
                    }`}
                  >
                    {person}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3">
              <span className="text-sm text-gray-500">テーマで絞る</span>
              <div className="mt-3 flex flex-wrap gap-2">
                {THEME_FILTERS.map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    onClick={() =>
                      setThemeFilter((prev) => (prev === theme ? null : theme))
                    }
                    className={`min-h-11 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                      themeFilter === theme
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-100 text-gray-600 active:bg-gray-200"
                    }`}
                  >
                    {theme}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 結果エリア */}
      <section className="mt-6" aria-live="polite">
        {loading && (
          <div className="flex flex-col items-center gap-3 py-12">
            <div
              className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
              role="status"
              aria-label="検索中"
            />
            <p className="text-sm text-gray-500">検索中...</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && results === null && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center">
            <p className="text-sm leading-relaxed text-gray-600">
              あなたの記録を自然言語で横断検索できます。
              <br />
              キーワードや質問を入力して検索してください。
            </p>
            <p className="mt-3 text-xs font-medium text-gray-400">
              日記 127件・会議 53件・学び 9件・成果物 11件を横断検索
            </p>
          </div>
        )}

        {!loading && !error && results !== null && results.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            該当する結果が見つかりませんでした。キーワードを変えてお試しください。
          </div>
        )}

        {!loading && !error && results !== null && results.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">{results.length}件の結果</p>
            {results.map((result) => (
              <ResultCard key={result.id} result={result} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
