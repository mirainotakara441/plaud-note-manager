"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// 提案書（資料集）のひな形（節構成）を編集するページ。
// 節の見出し・書き方の指示（任意）を並び順どおりに編集し、上下ボタンで並べ替える。
// 保存すると次回の「武器を出す」からこの節構成で生成される。

type Section = { section: string; guidance: string };

function toEdit(rows: { section: string; guidance: string | null }[]): Section[] {
  return rows.map((r) => ({ section: r.section, guidance: r.guidance ?? "" }));
}

export default function WeaponTemplatePage() {
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/weapons/template", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSections(toEdit(Array.isArray(d?.sections) ? d.sections : [])))
      .catch(() => setError("ひな形の取得に失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  function update(i: number, patch: Partial<Section>) {
    setSaved(false);
    setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    setSaved(false);
    setSections((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function remove(i: number) {
    setSaved(false);
    setSections((prev) => prev.filter((_, idx) => idx !== i));
  }

  function add() {
    setSaved(false);
    setSections((prev) => [...prev, { section: "", guidance: "" }]);
  }

  async function save() {
    const cleaned = sections.map((s) => ({ ...s, section: s.section.trim() }));
    if (cleaned.some((s) => s.section === "")) {
      return setError("節の見出しが空のものがあります");
    }
    if (cleaned.length === 0) {
      return setError("節を1つ以上入力してください");
    }
    setError(null);
    setSaving(true);
    setSaved(false);
    try {
      const r = await fetch("/api/weapons/template", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: cleaned }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "保存に失敗しました");
      setSections(toEdit(d.sections ?? cleaned.map((s) => ({ ...s, guidance: s.guidance || null }))));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/weapons"
          className="rounded-lg px-2 py-1 text-sm font-medium text-gray-500 transition active:bg-gray-100"
        >
          ← 武器を出す
        </Link>
        <Link
          href="/"
          className="rounded-lg px-2 py-1 text-sm font-medium text-gray-500 transition active:bg-gray-100"
        >
          ← ホーム
        </Link>
      </div>

      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          提案書のひな形を編集
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          節の見出し・順序・書き方の指示（任意）を編集できます。保存すると次回の生成からこの節構成が使われます。
        </p>
      </header>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}

      {!loading && (
        <>
          <div className="space-y-3">
            {sections.map((s, i) => (
              <div
                key={i}
                className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-2.5 shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <input
                      type="text"
                      value={s.section}
                      onChange={(e) => update(i, { section: e.target.value })}
                      placeholder="節の見出し（例: 背景・課題認識）"
                      className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-900"
                    />
                    <textarea
                      value={s.guidance}
                      onChange={(e) => update(i, { guidance: e.target.value })}
                      rows={2}
                      placeholder="書き方の指示（任意）例: 最新実績サマリの数値だけを根拠にすること"
                      className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600"
                    />
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label="上へ"
                    className="rounded-md px-2 py-1 text-sm text-gray-400 transition active:bg-gray-100 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === sections.length - 1}
                    aria-label="下へ"
                    className="rounded-md px-2 py-1 text-sm text-gray-400 transition active:bg-gray-100 disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label="削除"
                    className="rounded-md px-2 py-1 text-sm text-gray-400 transition active:bg-gray-100 active:text-rose-500"
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={add}
            className="mt-3 w-full rounded-xl border border-dashed border-gray-300 py-2.5 text-sm font-medium text-gray-500 transition active:bg-gray-50"
          >
            ＋ 節を追加
          </button>

          {error && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              保存しました。次回の生成からこのひな形が使われます。
            </p>
          )}

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="mt-4 w-full rounded-xl bg-amber-600 px-4 py-3 text-base font-semibold text-white transition active:bg-amber-700 disabled:opacity-40"
          >
            {saving ? "保存しています..." : "このひな形で保存"}
          </button>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}
