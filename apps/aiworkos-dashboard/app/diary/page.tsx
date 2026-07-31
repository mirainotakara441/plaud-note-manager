"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// 一行日記の断絶解消（本命）ページ。
// Claude Projectsで書いた日記本文を貼るだけで、/api/diary が
//   1) Claudeで日ごとのエントリに構造化
//   2) Notion一行日記DBへ登録（重複は日付でスキップ）
//   3) Supabase memory_chunks(source_type=日記) へ登録
// を一度にやる。翌朝はpg_cron 06:00→Vercel Cron 06:30の既存自動化で/actionsへ反映される。
//
// ページを開いた時点で「過去何日ぶん登録済みか」が分からない、という声を受けて、
// /api/diary/status（Supabase memory_chunks 直参照）から直近分の登録状況を取得し、
// 上部に日付ごとの済/未の帯を出す。登録直後も再取得して即座に反映する。

type EntryResult = {
  date: string;
  title: string;
  status: "created" | "skipped" | "error";
  notionUrl: string | null;
  reason?: string;
};

// 音声入力の誤変換を辞書で自動修正した内訳。黙って書き換えると
// 「自分が書いたものと違う」となるため、実際に置換したものだけを控えめに出す。
type Correction = { wrong: string; correct: string; count: number };

type DiaryResponse = {
  created: number;
  skipped: number;
  errors: number;
  results: EntryResult[];
  corrections?: Correction[];
  correctionTotal?: number;
  correctionMessage?: string | null;
};

type StatusEntry = {
  date: string;
  registered: boolean;
  isToday: boolean;
};

type StatusResponse = {
  today: string;
  days: number;
  entries: StatusEntry[];
  latestDate: string | null;
  staleDays: number | null;
  error?: string;
};

const DAYS_OPTIONS = [
  { label: "1週間", value: 7 },
  { label: "2週間", value: 14 },
  { label: "1か月", value: 30 },
] as const;

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function formatDayLabel(dateStr: string): { md: string; weekday: string } {
  const [, m, d] = dateStr.split("-").map(Number);
  const weekday = WEEKDAY_LABELS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
  return { md: `${m}/${d}`, weekday };
}

const PLACEHOLDER = `例:
7/25 【転】平和地区の座談会、大変に素晴らしかった
◇印象的だったこと：...
◇そうか：...
◇やってみよう：...
◇本日の要点3つ：...

複数日ぶんまとめて貼ってもOKです`;

function statusBadge(status: EntryResult["status"]) {
  if (status === "created") {
    return (
      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
        新規
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
        スキップ（既登録）
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
      エラー
    </span>
  );
}

export default function DiaryPage() {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiaryResponse | null>(null);

  const [statusDays, setStatusDays] = useState<number>(7);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (days: number) => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/diary/status?days=${days}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setStatusError(data?.error ?? "登録状況の取得に失敗しました");
      } else {
        setStatus(data as StatusResponse);
      }
    } catch {
      setStatusError("登録状況の通信エラーが発生しました");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus(statusDays);
  }, [fetchStatus, statusDays]);

  async function onSubmit() {
    setError(null);
    if (!text.trim()) {
      setError("日記本文を貼り付けてください");
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/diary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "登録に失敗しました");
      } else {
        setResult(data as DiaryResponse);
        if ((data as DiaryResponse).errors === 0) {
          setText("");
        }
        // 登録直後に済/未の帯へ反映する（登録したのに「未」のままだと意味が無いため）。
        fetchStatus(statusDays);
      }
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">一行日記を登録</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          登録すると、Notionの一行日記DBとAIワークOSの記憶に入り、翌朝ToDoに反映されます
        </p>
      </header>

      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-700">登録状況</h2>
          <div className="flex shrink-0 gap-1">
            {DAYS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatusDays(opt.value)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  statusDays === opt.value
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 text-gray-500 active:bg-gray-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {statusError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
            {statusError}
          </p>
        )}

        {!statusError && (
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {statusLoading && !status ? (
              <p className="py-2 text-sm text-gray-400">読み込み中...</p>
            ) : (
              status?.entries.map((entry) => {
                const { md, weekday } = formatDayLabel(entry.date);
                return (
                  <div
                    key={entry.date}
                    className={`flex shrink-0 flex-col items-center gap-1 rounded-lg border px-2 py-1.5 ${
                      entry.isToday
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-100 bg-gray-50"
                    }`}
                  >
                    <span
                      className={`text-xs ${entry.isToday ? "font-semibold text-indigo-700" : "text-gray-500"}`}
                    >
                      {md}({weekday})
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        entry.registered
                          ? "bg-emerald-100 text-emerald-700"
                          : entry.isToday
                            ? "bg-gray-200 text-gray-500"
                            : "bg-red-50 text-red-600"
                      }`}
                    >
                      {entry.registered ? "済" : "未"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}

        {status && status.staleDays !== null && status.staleDays >= 3 && (
          <p className="mt-3 text-xs leading-relaxed text-amber-700">
            最終登録から{status.staleDays}日ほど間が空いています（最終: {status.latestDate}）
          </p>
        )}
      </div>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-gray-600">日記本文</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={submitting}
            rows={12}
            placeholder={PLACEHOLDER}
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
          <p className="mt-2 text-xs text-gray-400">
            複数日ぶんまとめて貼っても、日付ごとに自動で分けて登録します。同じ日付が既に登録済みならスキップします。
          </p>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white transition active:scale-95 disabled:opacity-40"
        >
          {submitting ? "登録中..." : "登録する"}
        </button>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-3 border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-900">
              新規 {result.created}件 ／ スキップ {result.skipped}件
              {result.errors > 0 ? ` ／ エラー ${result.errors}件` : ""}
            </p>

            {result.correctionMessage && (
              <div className="rounded-lg bg-amber-50 px-3 py-2">
                <p className="text-xs leading-relaxed text-amber-800">
                  {result.correctionMessage}
                </p>
                {result.corrections && result.corrections.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    {result.corrections.map((c) => (
                      <li key={`${c.wrong}-${c.correct}`} className="text-xs text-amber-700">
                        {c.wrong}→{c.correct}
                        {c.count > 1 ? `（${c.count}回）` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <ul className="space-y-2">
              {result.results.map((r) => (
                <li
                  key={`${r.date}-${r.title}`}
                  className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-400">{r.date}</p>
                      <p className="truncate text-sm font-medium text-gray-900">{r.title}</p>
                    </div>
                    {statusBadge(r.status)}
                  </div>
                  {r.notionUrl && (
                    <a
                      href={r.notionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-xs text-indigo-600 underline active:opacity-70"
                    >
                      Notionで見る
                    </a>
                  )}
                  {r.reason && <p className="mt-1 text-xs text-amber-700">{r.reason}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}
