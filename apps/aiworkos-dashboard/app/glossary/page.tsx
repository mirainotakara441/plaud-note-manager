"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  type SortMode,
  type Term,
  groupTerms,
  matches,
} from "@/lib/glossary";

// 用語集。
//
// 目的は「読んだときは分かったのに、名前を聞かれると出てこん」を潰すこと。
// なので一般的な辞書の説明は置かず、
//   一言 → 本質（なぜそれが要るのか）→ 自分の仕事のどこに出てくるか
// の3段で持つ。探し方はあいうえお順とアルファベット順の2通り。

const C_ACCENT = "#7c3aed";

export default function GlossaryPage() {
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SortMode>("kana");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/glossary")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "取得に失敗しました");
        return data;
      })
      .then((data) => setTerms(data.terms as Term[]))
      .catch((e) => setError(e instanceof Error ? e.message : "取得に失敗しました"));
  }, []);

  const shown = useMemo(
    () => (terms ?? []).filter((t) => matches(t, query)),
    [terms, query]
  );
  const groups = useMemo(() => groupTerms(shown, mode), [shown, mode]);

  const loading = !terms && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          📖 用語集
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          分からんかった言葉を、辞書の説明やなく「なぜそれが要るのか」から残す。
        </p>
      </header>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {terms && (
        <>
          {/* 並べ方の切り替え。英字の用語にも読みを持たせてあるので、
              あいうえお順ではLLMが「え」の位置に入る */}
          <div className="mt-5 flex gap-2">
            {([
              ["kana", "あいうえお順"],
              ["alpha", "アルファベット順"],
            ] as [SortMode, string][]).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition active:opacity-70"
                style={
                  mode === m
                    ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                    : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {/* 用語そのものを思い出せんときのために、説明文も検索対象にしている */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="用語・読み・説明から探す"
            className="mt-3 w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm outline-none placeholder:text-gray-400 focus:border-violet-400"
          />

          <p className="mt-3 text-xs text-gray-400">
            {query ? `${shown.length} 件` : `全 ${terms.length} 語`}
          </p>

          {groups.length === 0 && (
            <p className="mt-8 text-center text-sm text-gray-400">
              見つかりませんでした
            </p>
          )}

          <div className="mt-2 space-y-6">
            {groups.map((g) => (
              <section key={g.label}>
                <h2 className="sticky top-0 bg-white/90 py-1 text-sm font-bold text-violet-700 backdrop-blur">
                  {g.label}
                </h2>
                <div className="mt-1 space-y-2">
                  {g.terms.map((t) => {
                    const open = openId === t.id;
                    return (
                      <article
                        key={t.id}
                        className="rounded-2xl border border-gray-200 bg-white p-4"
                      >
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : t.id)}
                          className="w-full text-left active:opacity-70"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <h3 className="text-base font-bold text-gray-900">
                              {t.term}
                            </h3>
                            <span className="shrink-0 text-xs text-gray-400">
                              {t.reading}
                            </span>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-gray-700">
                            {t.short}
                          </p>
                          {!open && (
                            <span className="mt-2 inline-block text-xs font-medium text-violet-600">
                              本質を読む
                            </span>
                          )}
                        </button>

                        {open && (
                          <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
                            <div>
                              <p className="text-xs font-semibold text-violet-700">
                                本質
                              </p>
                              <p className="mt-1 text-sm leading-relaxed text-gray-700">
                                {t.essence}
                              </p>
                            </div>

                            {t.usage_note && (
                              <div>
                                <p className="text-xs font-semibold text-violet-700">
                                  自分の仕事のどこに出てくるか
                                </p>
                                <p className="mt-1 text-sm leading-relaxed text-gray-700">
                                  {t.usage_note}
                                </p>
                              </div>
                            )}

                            {t.related.length > 0 && (
                              <div>
                                <p className="text-xs font-semibold text-violet-700">
                                  関連語
                                </p>
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  {t.related.map((r) => (
                                    <button
                                      key={r}
                                      type="button"
                                      onClick={() => {
                                        setQuery(r);
                                        setOpenId(null);
                                      }}
                                      className="rounded-full bg-violet-50 px-2.5 py-1 text-xs text-violet-700 active:opacity-70"
                                    >
                                      {r}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            <p className="text-xs text-gray-400">
                              {[t.category, t.source_sprint, t.source_chapter]
                                .filter(Boolean)
                                .join(" ・ ")}
                            </p>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
