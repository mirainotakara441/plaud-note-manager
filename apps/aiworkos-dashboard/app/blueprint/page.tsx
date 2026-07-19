"use client";

import Link from "next/link";
import { useState } from "react";

// 全体設計図（v2.0）と進捗スコアカードを、アプリ内でいつでも開けるページ。
// 中身は public/ の自己完結HTMLを iframe で表示する（合言葉認証の内側なので本人だけ閲覧可）。
// ※Claude Artifact 版と違い claude.ai ログイン不要。ダッシュボードから常に見られる。

type View = { key: string; label: string; src: string };

const VIEWS: View[] = [
  { key: "blueprint", label: "📐 設計図 v2.0", src: "/blueprint-v2.html" },
  { key: "scorecard", label: "🧭 スコアカード", src: "/scorecard.html" },
];

export default function BlueprintPage() {
  const [active, setActive] = useState<string>(VIEWS[0].key);
  const current = VIEWS.find((v) => v.key === active) ?? VIEWS[0];

  return (
    <main className="flex h-[100dvh] flex-col bg-gray-50">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-gray-500 transition active:bg-gray-100"
        >
          ← ホーム
        </Link>
        <div
          className="flex gap-1 rounded-xl bg-gray-100 p-1"
          role="tablist"
          aria-label="表示する資料"
        >
          {VIEWS.map((v) => {
            const on = v.key === active;
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setActive(v.key)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  on
                    ? "bg-white text-emerald-700 shadow-sm"
                    : "text-gray-500 active:text-gray-700"
                }`}
              >
                {v.label}
              </button>
            );
          })}
        </div>
        <a
          href={current.src}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto shrink-0 rounded-lg px-2 py-1 text-sm text-emerald-600 transition active:opacity-70"
        >
          別タブで開く ↗
        </a>
      </header>

      <iframe
        key={current.key}
        src={current.src}
        title={current.label}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </main>
  );
}
