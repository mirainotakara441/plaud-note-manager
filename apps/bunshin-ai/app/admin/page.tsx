"use client";

import { useEffect, useState } from "react";

// 相談ログ一覧（吉井さん専用）。
// 権限の判定は /api/logs 側でやっているので、ここは結果を並べるだけ。

type LogRow = {
  id: number;
  member_name: string;
  question: string;
  answer: string;
  created_at: string;
};

export default function AdminPage() {
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/logs");
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError((d && d.error) || "読み込みに失敗しました");
        setLogs([]);
        return;
      }
      setLogs(d.logs ?? []);
    })();
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-lg font-bold">相談ログ</h1>
      <p className="mt-1 text-xs text-slate-500">
        新しい順に最大200件。答えの部分は行をタップすると開きます。
      </p>

      {error && <p className="mt-6 text-sm text-red-600">{error}</p>}
      {logs === null && <p className="mt-6 text-sm text-slate-400">読み込み中...</p>}
      {logs !== null && logs.length === 0 && !error && (
        <p className="mt-6 text-sm text-slate-400">まだ相談はありません。</p>
      )}

      <ul className="mt-4 space-y-2">
        {(logs ?? []).map((l) => (
          <li key={l.id} className="rounded-xl border border-slate-200 bg-white">
            <button
              onClick={() => setOpen(open === l.id ? null : l.id)}
              className="w-full px-4 py-3 text-left"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold">{l.member_name}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {new Date(l.created_at).toLocaleString("ja-JP")}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-slate-700">{l.question}</p>
            </button>
            {open === l.id && (
              <div className="border-t border-slate-100 px-4 py-3">
                <p className="text-xs font-semibold text-slate-400">相談</p>
                <p className="mt-1 text-sm whitespace-pre-wrap text-slate-800">
                  {l.question}
                </p>
                <p className="mt-3 text-xs font-semibold text-slate-400">法人請求オンラインサービス相談AIの答え</p>
                <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
                  {l.answer}
                </p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
