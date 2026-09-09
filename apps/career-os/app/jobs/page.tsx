"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { JobsResponse } from "@/app/api/jobs/route";
import {
  BackToHome,
  EmptyBlock,
  ErrorBlock,
  JOB_STATUS_LABEL,
  JobStatusChip,
  LoadingBlock,
  PageHeader,
  SOURCE_LABEL,
  ScoreBadge,
  SourceBadge,
  Spinner,
  fmtDate,
  formatSalary,
} from "@/app/components/ui";
import type { CareerJob, JobSource, JobStatus } from "@/lib/types";

// 求人一覧。
//
// doda X 等が「年収と知名度」で並べるのに対して、この画面は適合スコア（＝自分の判断軸）で並べる。
// 既定の並びが「適合スコア順」なのはそのため。
//
// ホームからは ?status=interested / ?sort=new / ?sort=fit で入ってくるので、
// useSearchParams で初期値を受ける（Suspense で包むこと。App Router の要件）。

const SORT_OPTIONS = [
  { value: "fit", label: "適合スコア順" },
  { value: "new", label: "新着順" },
  { value: "salary", label: "年収上限順" },
] as const;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "すべてのステータス" },
  ...(Object.keys(JOB_STATUS_LABEL) as JobStatus[]).map((s) => ({
    value: s,
    label: JOB_STATUS_LABEL[s],
  })),
];

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "すべての出典" },
  ...(Object.keys(SOURCE_LABEL) as JobSource[]).map((s) => ({
    value: s,
    label: SOURCE_LABEL[s],
  })),
];

const SALARY_OPTIONS = [
  { value: "", label: "年収の下限なし" },
  { value: "800", label: "800万円以上" },
  { value: "1000", label: "1000万円以上" },
  { value: "1200", label: "1200万円以上" },
  { value: "1500", label: "1500万円以上" },
];

const SELECT_CLASS =
  "min-w-0 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700";

function JobsInner() {
  const sp = useSearchParams();

  const [sort, setSort] = useState<string>(() => sp.get("sort") ?? "fit");
  const [status, setStatus] = useState<string>(() => sp.get("status") ?? "all");
  const [source, setSource] = useState<string>("all");
  const [salaryMin, setSalaryMin] = useState<string>("");
  const [word, setWord] = useState<string>("");
  // 入力のたびにAPIを叩かないよう、フリーワードだけ 350ms 遅らせて反映する。
  const [wordApplied, setWordApplied] = useState<string>("");

  const [rows, setRows] = useState<CareerJob[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setWordApplied(word), 350);
    return () => clearTimeout(t);
  }, [word]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set("sort", sort);
    if (status !== "all") p.set("status", status);
    if (source !== "all") p.set("source", source);
    if (salaryMin !== "") p.set("salary_min", salaryMin);
    if (wordApplied.trim() !== "") p.set("q", wordApplied.trim());
    return p.toString();
  }, [sort, status, source, salaryMin, wordApplied]);

  const load = useCallback(
    async (offset: number) => {
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const res = await fetch(`/api/jobs?${query}&offset=${offset}`, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as (JobsResponse & { error?: string }) | null;
        if (!res.ok || !data) {
          throw new Error(data?.error ?? `求人の取得に失敗しました（${res.status}）`);
        }
        setTotal(data.total);
        setHasMore(data.has_more);
        setRows((prev) => (offset === 0 ? data.rows : [...prev, ...data.rows]));
      } catch (e) {
        setError(e instanceof Error ? e.message : "求人の取得に失敗しました");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [query]
  );

  useEffect(() => {
    load(0);
  }, [load]);

  /**
   * ステータス・メモの更新。押した瞬間に画面へ反映し（楽観的更新）、
   * 失敗したら元に戻してエラーを出す。
   */
  async function patchJob(id: string, patch: Partial<Pick<CareerJob, "status" | "note">>) {
    const snapshot = rows;
    setActionError(null);
    setSavingId(id);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    try {
      const res = await fetch("/api/jobs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const data = (await res.json().catch(() => null)) as
        | { row?: CareerJob; error?: string }
        | null;
      if (!res.ok) throw new Error(data?.error ?? `更新に失敗しました（${res.status}）`);
      if (data?.row) {
        const row = data.row;
        setRows((prev) => prev.map((r) => (r.id === id ? row : r)));
      }
    } catch (e) {
      setRows(snapshot); // 巻き戻し
      setActionError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSavingId(null);
    }
  }

  /** 同じボタンをもう一度押したら「新着」に戻す（付け間違いをその場で消せるように）。 */
  function toggleStatus(job: CareerJob, next: JobStatus) {
    patchJob(job.id, { status: job.status === next ? "new" : next });
  }

  function startNote(job: CareerJob) {
    setEditingNoteId(job.id);
    setNoteDraft(job.note ?? "");
  }

  async function saveNote(id: string) {
    await patchJob(id, { note: noteDraft.trim() === "" ? null : noteDraft.trim() });
    setEditingNoteId(null);
  }

  const filtered =
    status !== "all" || source !== "all" || salaryMin !== "" || wordApplied.trim() !== "";

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <PageHeader title="求人一覧" lead="届いた求人を、自分の判断軸のスコア順に並べて仕分ける" />

      {/* 絞り込み・並べ替え */}
      <div className="mb-4 space-y-2">
        <input
          type="search"
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder="企業名・ポジションで検索"
          className="w-full rounded-full border border-gray-200 bg-white px-4 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-teal-500 focus:outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={SELECT_CLASS}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={SELECT_CLASS}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={SELECT_CLASS}
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={salaryMin}
            onChange={(e) => setSalaryMin(e.target.value)}
            className={SELECT_CLASS}
          >
            {SALARY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!loading && !error && rows.length > 0 && (
        <p className="mb-3 text-xs text-gray-400">
          全{total}件中 {rows.length}件を表示
        </p>
      )}

      {actionError && (
        <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2 text-xs leading-relaxed text-rose-700">
          {actionError}
        </p>
      )}

      {loading ? (
        <LoadingBlock label="求人を読み込み中…" />
      ) : error ? (
        <ErrorBlock message={error} onRetry={() => load(0)} />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyBlock
            icon="🔍"
            title="条件に合う求人がありません"
            hint="絞り込みを緩めるか、フリーワードを消して確認してください。"
          />
        ) : (
          <EmptyBlock
            icon="📭"
            title="まだ求人がありません"
            hint="まだ取込していません。ホームの「今すぐ取込」を押してください。メールから求人を拾い上げて、判断軸で採点したうえでここに並べます。"
            action={{ href: "/", label: "ホームで取込する" }}
          />
        )
      ) : (
        <div className="space-y-3">
          {rows.map((job) => (
            <article
              key={job.id}
              className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              {/* 企業名・ポジション・スコア */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-bold leading-snug text-gray-900">{job.company}</h2>
                  <p className="mt-0.5 text-sm leading-relaxed text-gray-700">{job.title}</p>
                </div>
                <ScoreBadge score={job.fit_score} />
              </div>

              {/* 年収・勤務地・出典・ステータス */}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-600">
                <span className="font-bold text-gray-800">{formatSalary(job)}</span>
                {job.location && <span>{job.location}</span>}
                <SourceBadge source={job.source} />
                <JobStatusChip status={job.status} />
              </div>

              {/* 掲載の履歴 */}
              <p className="mt-1.5 text-[0.6875rem] text-gray-400">
                初回 {fmtDate(job.first_seen_at)}・最終 {fmtDate(job.last_seen_at)}
                {job.seen_count >= 2 && (
                  <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 font-bold text-gray-600">
                    {job.seen_count}回掲載
                  </span>
                )}
              </p>

              {/* 適合の要約と内訳 */}
              {job.fit_summary && (
                <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-gray-700">
                  {job.fit_summary}
                </p>
              )}
              {((job.fit_pros?.length ?? 0) > 0 || (job.fit_cons?.length ?? 0) > 0) && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-bold text-teal-700">
                    良い点・懸念を見る
                  </summary>
                  <div className="mt-2 space-y-2">
                    {(job.fit_pros?.length ?? 0) > 0 && (
                      <div className="rounded-xl bg-emerald-50 px-3 py-2">
                        <p className="text-[0.6875rem] font-bold text-emerald-700">良い点</p>
                        <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-emerald-900">
                          {job.fit_pros?.map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(job.fit_cons?.length ?? 0) > 0 && (
                      <div className="rounded-xl bg-rose-50 px-3 py-2">
                        <p className="text-[0.6875rem] font-bold text-rose-700">懸念</p>
                        <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-rose-900">
                          {job.fit_cons?.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* メモ */}
              {editingNoteId === job.id ? (
                <div className="mt-3">
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={3}
                    placeholder="この求人について思ったこと・確認したいこと"
                    className="w-full rounded-xl border border-gray-200 p-2 text-sm text-gray-800"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => saveNote(job.id)}
                      disabled={savingId === job.id}
                      className="rounded-full bg-teal-700 px-3 py-1.5 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
                    >
                      {savingId === job.id ? "保存中…" : "保存"}
                    </button>
                    <button
                      onClick={() => setEditingNoteId(null)}
                      disabled={savingId === job.id}
                      className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600 active:scale-95 disabled:opacity-50"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : (
                job.note && (
                  <p className="mt-3 whitespace-pre-wrap rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                    {job.note}
                  </p>
                )
              )}

              {/* 操作 */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                <button
                  onClick={() => toggleStatus(job, "interested")}
                  disabled={savingId === job.id}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold active:scale-95 disabled:opacity-50 ${
                    job.status === "interested"
                      ? "bg-amber-500 text-white"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  ⭐️ 気になる
                </button>
                <button
                  onClick={() => toggleStatus(job, "declined")}
                  disabled={savingId === job.id}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold active:scale-95 disabled:opacity-50 ${
                    job.status === "declined"
                      ? "bg-gray-500 text-white"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  見送り
                </button>
                {editingNoteId !== job.id && (
                  <button
                    onClick={() => startNote(job)}
                    className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600 active:scale-95"
                  >
                    {job.note ? "メモを編集" : "メモ"}
                  </button>
                )}
                {job.url && (
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-xs font-bold text-teal-700 active:opacity-70"
                  >
                    求人を開く ↗
                  </a>
                )}
              </div>
            </article>
          ))}

          {hasMore && (
            <button
              onClick={() => load(rows.length)}
              disabled={loadingMore}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white py-3 text-sm font-bold text-teal-700 shadow-sm active:bg-gray-50 disabled:opacity-50"
            >
              {loadingMore && <Spinner />}
              {loadingMore ? "読み込み中…" : `もっと読む（残り${Math.max(total - rows.length, 0)}件）`}
            </button>
          )}
        </div>
      )}

      <BackToHome />
    </main>
  );
}

export default function JobsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-2xl px-4 pt-16">
          <LoadingBlock label="求人を読み込み中…" />
        </main>
      }
    >
      <JobsInner />
    </Suspense>
  );
}
