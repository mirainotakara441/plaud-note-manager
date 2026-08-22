"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  type SortMode,
  type Term,
  groupTerms,
  matches,
  sprintPhaseOf,
  sprintPhaseGroups,
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
  // 語数が増えて一覧を上から探すのがしんどくなったので、
  // 頭文字（あ行／A）で1グループだけに絞れるようにする。null は全表示。
  const [group, setGroup] = useState<string | null>(null);
  // どのスプリントのどの回で出てきた言葉か（例: "Sprint3 Learn"）。null は全表示。
  const [sprint, setSprint] = useState<string | null>(null);

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

  // スプリントの選択肢は実データから作る。Sprint1の語を入れれば自動で増える。
  const sprintOptions = useMemo(() => sprintPhaseGroups(terms ?? []), [terms]);

  const shown = useMemo(
    () =>
      (terms ?? []).filter(
        (t) => matches(t, query) && (!sprint || sprintPhaseOf(t) === sprint)
      ),
    [terms, query, sprint]
  );
  const allGroups = useMemo(() => groupTerms(shown, mode), [shown, mode]);
  // 選んだ見出しが検索で消えたら、黙って全表示に戻す（0件の画面で固まらんように）
  useEffect(() => {
    if (group && !allGroups.some((g) => g.label === group)) setGroup(null);
  }, [allGroups, group]);
  const groups = useMemo(
    () => (group ? allGroups.filter((g) => g.label === group) : allGroups),
    [allGroups, group]
  );

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
                onClick={() => {
                  setMode(m);
                  // 見出しの体系ごと変わるので、絞り込みは持ち越さない
                  setGroup(null);
                }}
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

          {/* どのスプリントのどの回で出てきた言葉かで絞る。
              選択肢は実データから作るので、語が無い区分は出ない */}
          {sprintOptions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSprint(null)}
                className="rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition active:opacity-70"
                style={
                  sprint === null
                    ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                    : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                }
              >
                全スプリント
              </button>
              {sprintOptions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setSprint(sprint === s.label ? null : s.label)}
                  className="rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition active:opacity-70"
                  style={
                    sprint === s.label
                      ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                      : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                  }
                >
                  {s.label}
                  <span
                    className="ml-1 font-normal"
                    style={{ color: sprint === s.label ? "#ddd6fe" : "#9ca3af" }}
                  >
                    {s.count}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* 頭文字で1グループに絞る。
              語が無い見出しは出さんので、押して0件になることがない */}
          {allGroups.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setGroup(null)}
                className="rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition active:opacity-70"
                style={
                  group === null
                    ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                    : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                }
              >
                すべて
              </button>
              {allGroups.map((g) => (
                <button
                  key={g.label}
                  type="button"
                  onClick={() => setGroup(group === g.label ? null : g.label)}
                  className="rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition active:opacity-70"
                  style={
                    group === g.label
                      ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                      : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                  }
                >
                  {g.label}
                  <span
                    className="ml-1 font-normal"
                    style={{ color: group === g.label ? "#ddd6fe" : "#9ca3af" }}
                  >
                    {g.terms.length}
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="mt-3 text-xs text-gray-400">
            {group
              ? `${group} ${groups[0]?.terms.length ?? 0} 語`
              : query || sprint
                ? `${shown.length} 件`
                : `全 ${terms.length} 語`}
            {sprint && <span className="ml-1">（{sprint}）</span>}
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
                                        // スプリント絞り込みを残したままだと、関連語が別スプリントの
                                        // 語のときに0件表示になる。関連語ジャンプは全体から探す。
                                        setSprint(null);
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
