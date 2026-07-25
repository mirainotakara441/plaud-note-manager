"use client";

import Link from "next/link";
import { useState } from "react";

// 一行日記の断絶解消（本命）ページ。
// Claude Projectsで書いた日記本文を貼るだけで、/api/diary が
//   1) Claudeで日ごとのエントリに構造化
//   2) Notion一行日記DBへ登録（重複は日付でスキップ）
//   3) Supabase memory_chunks(source_type=日記) へ登録
// を一度にやる。翌朝はpg_cron 06:00→Vercel Cron 06:30の既存自動化で/actionsへ反映される。

type EntryResult = {
  date: string;
  title: string;
  status: "created" | "skipped" | "error";
  notionUrl: string | null;
  reason?: string;
};

type DiaryResponse = {
  created: number;
  skipped: number;
  errors: number;
  results: EntryResult[];
};

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
