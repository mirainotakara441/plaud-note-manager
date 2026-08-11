"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Trend from "./Trend";
import RetrospectiveForm from "./RetrospectiveForm";
import MonthView from "./MonthView";
import {
  PERIOD_TYPES,
  averageRating,
  categoryAccent,
  draftFromRow,
  emptyDraft,
  formatPeriod,
  formatPlanDate,
  formatStars,
  ratingColor,
  type PeriodType,
  type RetroRow,
} from "@/lib/retrospective";

// 振り返り（週次・月次）。
//
// 週報ダッシュボード（/weekly-report）が「団体ごとの事実のログ」なのに対し、
// ここは★評価・総括・示唆・次期の予定という「解釈」を溜めて、その動きを見る場所。
// 別物なので混ぜない。
//
// 1画面で 一覧 → 詳細 → 登録／編集 を切り替える（URLは /retrospective のまま）。

type View =
  | { kind: "list" }
  | { kind: "detail"; id: string }
  | { kind: "new" }
  | { kind: "edit"; id: string };

export default function RetrospectivePage() {
  const [items, setItems] = useState<RetroRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodType, setPeriodType] = useState<PeriodType>("週次");
  const [view, setView] = useState<View>({ kind: "list" });
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/retrospective", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 一覧⇄詳細⇄フォームは同じURLのまま切り替えるため、放っておくと
  // 前の画面のスクロール位置のまま次の画面が出て見出しを見失う。都度上に戻す。
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  const filtered = useMemo(
    () => items.filter((i) => i.period_type === periodType),
    [items, periodType]
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of PERIOD_TYPES) m[t] = items.filter((i) => i.period_type === t).length;
    return m;
  }, [items]);

  const current = useMemo(
    () =>
      view.kind === "detail" || view.kind === "edit"
        ? items.find((i) => i.id === view.id) ?? null
        : null,
    [items, view]
  );

  async function remove(row: RetroRow) {
    const label = `${row.period_type} ${formatPeriod(row.period_start, row.period_end)}`;
    if (!window.confirm(`「${label}」の振り返りを削除します。\n節・示唆・予定もすべて消えます。よろしいですか？`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/retrospective?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました");
      setView({ kind: "list" });
      await load();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  }

  // ---- 登録・編集 ----
  if (view.kind === "new" || (view.kind === "edit" && current)) {
    const isNew = view.kind === "new";
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
        <header className="mb-6">
          <button
            onClick={() => setView(isNew ? { kind: "list" } : { kind: "detail", id: view.id })}
            className="text-sm text-indigo-500 active:opacity-70"
          >
            ← やめて戻る
          </button>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
            {isNew ? "振り返りを登録" : "振り返りを編集"}
          </h1>
        </header>
        <RetrospectiveForm
          mode={isNew ? "new" : "edit"}
          retroId={isNew ? undefined : current!.id}
          initialDraft={
            isNew ? { ...emptyDraft(), period_type: periodType } : draftFromRow(current!)
          }
          onSaved={async (id) => {
            await load();
            setView(id ? { kind: "detail", id } : { kind: "list" });
          }}
          onCancel={() => setView(isNew ? { kind: "list" } : { kind: "detail", id: view.id })}
        />
      </main>
    );
  }

  // ---- 詳細 ----
  if (view.kind === "detail" && current) {
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
        <Detail
          row={current}
          onBack={() => setView({ kind: "list" })}
          onEdit={() => setView({ kind: "edit", id: current.id })}
          onDelete={() => remove(current)}
          deleting={deleting}
        />
      </main>
    );
  }

  // ---- 一覧 ----
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">振り返り</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          週次・月次の★評価と総括・示唆・次期の予定。
          <br />
          月次では、書いた解釈だけでなく<strong>その月に実際に何があったか</strong>も出します。
        </p>
      </header>

      {/* 種別の切り替え */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {PERIOD_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setPeriodType(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition active:scale-95 ${
              periodType === t
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 ring-1 ring-gray-200"
            }`}
          >
            {t}
            <span className="ml-1 text-xs opacity-70">{counts[t] ?? 0}</span>
          </button>
        ))}
        <button
          onClick={load}
          className="ml-auto rounded-full px-3 py-1.5 text-sm text-gray-400 ring-1 ring-gray-200 active:scale-95"
          aria-label="再読み込み"
        >
          ↻
        </button>
      </div>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}

      {!loading && !error && (
        <>
          {/* 月次のときだけ「その月に何があったか」を先に出す。振り返りを書く前に
              読む面であり、書いていない月でも中身がある（記録は毎日溜まっているため）。 */}
          {periodType === "月次" && <MonthView />}

          <Trend items={filtered} periodType={periodType} />

          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-bold text-gray-500">
              {periodType}の振り返り（{filtered.length}件）
            </h2>
            <button
              onClick={() => setView({ kind: "new" })}
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-bold text-white transition active:scale-95"
            >
              ＋ 登録
            </button>
          </div>

          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400">
              {periodType}の振り返りはまだありません。
            </p>
          ) : (
            <div className="space-y-3">
              {filtered.map((r) => {
                const avg = averageRating(r.sections);
                return (
                  <button
                    key={r.id}
                    onClick={() => setView({ kind: "detail", id: r.id })}
                    className="w-full rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm transition active:bg-gray-50"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-bold text-gray-400 tabular-nums">
                        {formatPeriod(r.period_start, r.period_end)}
                      </span>
                      <span className="shrink-0 text-xs text-gray-400">
                        平均 {avg?.toFixed(1) ?? "—"}
                      </span>
                    </div>
                    <h3 className="mt-1 text-base font-bold leading-snug text-gray-900">
                      {r.title ?? "（タイトルなし）"}
                    </h3>
                    {r.one_liner && (
                      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-gray-500">
                        {r.one_liner}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.sections.map((s) => (
                        <span
                          key={s.id}
                          className={`rounded-lg px-2 py-0.5 text-xs ${categoryAccent(s.category)}`}
                        >
                          {s.category}
                          <span className="ml-1 tabular-nums opacity-70">
                            {s.rating ?? "—"}
                          </span>
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
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

// ---------------------------------------------------------------------------

function Detail({
  row,
  onBack,
  onEdit,
  onDelete,
  deleting,
}: {
  row: RetroRow;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const avg = averageRating(row.sections);
  const plans = [...(row.next_plans ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const insights = row.insights ?? [];

  return (
    <>
      <header className="mb-6">
        <button onClick={onBack} className="text-sm text-indigo-500 active:opacity-70">
          ← 一覧へ
        </button>
        <p className="mt-2 flex flex-wrap items-baseline gap-2 text-xs font-bold text-gray-400 tabular-nums">
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
            {row.period_type}
          </span>
          {formatPeriod(row.period_start, row.period_end)}
        </p>
        <h1 className="mt-2 text-2xl font-bold leading-snug tracking-tight text-gray-900">
          {row.title ?? "（タイトルなし）"}
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          ★のある節 {row.sections.filter((s) => s.rating !== null).length}／{row.sections.length}・
          平均 {avg?.toFixed(1) ?? "—"}
        </p>
      </header>

      {row.one_liner && (
        <section className="mb-5 rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
          <h2 className="text-xs font-bold text-indigo-500">一言で</h2>
          <p className="mt-1 whitespace-pre-wrap text-base font-bold leading-relaxed text-indigo-900">
            {row.one_liner}
          </p>
        </section>
      )}

      <div className="mb-5 space-y-4">
        {row.sections.map((s) => (
          <section
            key={s.id}
            className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className={`rounded-lg px-2.5 py-1 text-sm font-bold ${categoryAccent(s.category)}`}>
                {s.category}
              </span>
              <span className={`text-lg tabular-nums ${ratingColor(s.rating)}`}>
                {formatStars(s.rating)}
                {s.rating !== null && (
                  <span className="ml-1 text-sm text-gray-400">{s.rating}</span>
                )}
              </span>
            </div>
            {s.body && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{s.body}</p>
            )}
            {Array.isArray(s.items) && s.items.length > 0 && (
              <ul className="mt-3 space-y-2">
                {s.items.map((it, i) => (
                  <li key={i} className="rounded-xl bg-gray-50 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-bold text-gray-900">{it.name}</span>
                      {it.eval && (
                        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs text-gray-600 ring-1 ring-gray-200">
                          {it.eval}
                        </span>
                      )}
                    </div>
                    {it.move && (
                      <p className="mt-1 text-sm leading-relaxed text-gray-600">{it.move}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {insights.length > 0 && (
        <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-bold text-gray-500">示唆</h2>
          <ul className="space-y-2">
            {insights.map((v, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-gray-700">
                <span className="shrink-0 text-amber-500" aria-hidden>
                  ◇
                </span>
                <span className="whitespace-pre-wrap">{v}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plans.length > 0 && (
        <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-bold text-gray-500">次期の予定</h2>
          <ul className="space-y-2">
            {plans.map((p, i) => (
              <li key={i} className="flex gap-3 text-sm leading-relaxed">
                <span className="w-20 shrink-0 font-bold text-gray-500 tabular-nums">
                  {p.date ? formatPlanDate(p.date) : "日付未定"}
                </span>
                <span className="min-w-0 flex-1 text-gray-700">{p.label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={onEdit}
          className="rounded-full bg-gray-900 px-5 py-2.5 text-sm font-bold text-white transition active:scale-95"
        >
          編集
        </button>
        <button
          onClick={onDelete}
          disabled={deleting}
          className="rounded-full px-4 py-2.5 text-sm font-bold text-rose-600 ring-1 ring-rose-200 transition active:scale-95 disabled:opacity-50"
        >
          {deleting ? "削除中…" : "削除"}
        </button>
        {row.notion_page_id && (
          <span className="ml-auto text-xs text-gray-400">Notion連携あり</span>
        )}
      </div>

      <div className="mt-8 text-center">
        <button onClick={onBack} className="text-sm text-indigo-500 active:opacity-70">
          ← 一覧へ
        </button>
      </div>
    </>
  );
}
