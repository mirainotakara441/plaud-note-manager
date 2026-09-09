"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { FitGetResponse, FitJobOption, FitPostResponse } from "@/app/api/fit/route";
import {
  BackToHome,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  ScoreBadge,
  Spinner,
  fmtDate,
} from "@/app/components/ui";
import type { CareerCriterion, FitResult } from "@/lib/types";

// 適合診断。
//
// 上段：判断軸（career_criteria）の重みを自分で変える。ここを変えると、以後の採点の
//       基準そのものが変わる（取込時の一次採点も、下段の深掘り再採点も同じ軸を見る）。
// 下段：求人を1件選んで Opus 5 で深掘り再採点し、判断軸ごとの内訳まで出す。
//
// 再採点は数十秒〜2分かかる。押してから無反応に見えると二重に押されるので、
// 経過秒数つきの処理中表示を必ず出し、その間はボタンを止める。

/** 重みの意味。数字だけだと何を上げ下げしているのか分からなくなるため添える。 */
const WEIGHT_HINT: Record<number, string> = {
  1: "参考程度",
  2: "軽め",
  3: "普通",
  4: "重視",
  5: "ここで引っかかったら見送り",
};

export default function FitPage() {
  const [criteria, setCriteria] = useState<CareerCriterion[]>([]);
  const [jobs, setJobs] = useState<FitJobOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 判断軸の編集
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  // 深掘り再採点
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [rescoring, setRescoring] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<FitPostResponse | null>(null);
  const [rescoreError, setRescoreError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fit", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as
        | (FitGetResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `判断軸の取得に失敗しました（${res.status}）`);
      }
      setCriteria(data.criteria);
      setJobs(data.jobs);
      setWeights(Object.fromEntries(data.criteria.map((c) => [c.id, c.weight])));
      setSelectedJobId((prev) =>
        prev !== "" && data.jobs.some((j) => j.id === prev) ? prev : data.jobs[0]?.id ?? ""
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "判断軸の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 再採点中の経過秒数。待ち時間の見当がつくように数字を動かし続ける。
  useEffect(() => {
    if (!rescoring) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [rescoring]);

  /** 判断軸の重み・有効無効を保存する。 */
  async function patchCriterion(id: string, patch: { weight?: number; active?: boolean }) {
    setSavingId(id);
    setCriteriaError(null);
    setSavedId(null);
    try {
      const res = await fetch("/api/fit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const data = (await res.json().catch(() => null)) as
        | { row?: CareerCriterion; error?: string }
        | null;
      if (!res.ok) throw new Error(data?.error ?? `保存に失敗しました（${res.status}）`);
      if (data?.row) {
        const row = data.row;
        setCriteria((prev) => prev.map((c) => (c.id === id ? row : c)));
        setWeights((prev) => ({ ...prev, [id]: row.weight }));
      }
      setSavedId(id);
      setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 2000);
    } catch (e) {
      // 失敗したらスライダーを保存済みの値へ戻す（画面とDBの食い違いを残さない）。
      const original = criteria.find((c) => c.id === id)?.weight;
      if (original !== undefined) setWeights((prev) => ({ ...prev, [id]: original }));
      setCriteriaError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSavingId(null);
    }
  }

  /** 深掘り再採点（Opus 5）。時間がかかるので二重送信を止める。 */
  async function rescore() {
    if (rescoring || selectedJobId === "") return;
    setRescoring(true);
    setRescoreError(null);
    setResult(null);
    try {
      const res = await fetch("/api/fit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: selectedJobId }),
      });
      const data = (await res.json().catch(() => null)) as
        | (FitPostResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `再採点に失敗しました（${res.status}）`);
      }
      setResult(data);
      // 選択肢に出ているスコアも新しい値へ差し替える（一覧と食い違わないように）。
      setJobs((prev) =>
        prev.map((j) =>
          j.id === data.job.id
            ? { ...j, fit_score: data.result.score, fit_scored_at: new Date().toISOString() }
            : j
        )
      );
    } catch (e) {
      setRescoreError(e instanceof Error ? e.message : "再採点に失敗しました");
    } finally {
      setRescoring(false);
    }
  }

  const activeCount = useMemo(() => criteria.filter((c) => c.active).length, [criteria]);
  const breakdown: FitResult["breakdown"] = result?.result.breakdown ?? [];

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <PageHeader
        title="適合診断"
        lead="判断軸の重みを決め、その軸で求人を深掘り採点する"
      />

      {loading ? (
        <LoadingBlock label="判断軸を読み込み中…" />
      ) : error ? (
        <ErrorBlock message={error} onRetry={load} />
      ) : (
        <>
          {/* ---------------- 上段：判断軸 ---------------- */}
          <section className="mb-8">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-bold text-gray-500">判断軸</h2>
              <p className="text-xs text-gray-400">有効 {activeCount}件</p>
            </div>

            {criteriaError && (
              <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2 text-xs leading-relaxed text-rose-700">
                {criteriaError}
              </p>
            )}

            {criteria.length === 0 ? (
              <EmptyBlock
                icon="🧭"
                title="判断軸がまだ登録されていません"
                hint="判断軸（career_criteria）が1件もありません。軸が無いと採点ができないため、まず判断軸を登録してください。"
              />
            ) : (
              <div className="space-y-3">
                {criteria.map((c) => {
                  const value = weights[c.id] ?? c.weight;
                  const dirty = value !== c.weight;
                  const saving = savingId === c.id;
                  return (
                    <div
                      key={c.id}
                      className={`rounded-2xl border p-4 shadow-sm ${
                        c.active ? "border-gray-200 bg-white" : "border-gray-200 bg-gray-50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h3
                            className={`text-sm font-bold leading-snug ${
                              c.active ? "text-gray-900" : "text-gray-400"
                            }`}
                          >
                            {c.label}
                            {!c.active && (
                              <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-[0.6875rem] font-bold text-gray-500">
                                無効
                              </span>
                            )}
                          </h3>
                          {c.description && (
                            <p className="mt-1 text-xs leading-relaxed text-gray-500">
                              {c.description}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 rounded-xl bg-teal-50 px-3 py-1.5 text-center">
                          <p className="text-lg font-bold leading-none text-teal-800">{value}</p>
                          <p className="mt-0.5 text-[0.625rem] text-teal-600">重み</p>
                        </div>
                      </div>

                      <div className="mt-3">
                        <input
                          type="range"
                          min={1}
                          max={5}
                          step={1}
                          value={value}
                          disabled={saving}
                          onChange={(e) =>
                            setWeights((prev) => ({ ...prev, [c.id]: Number(e.target.value) }))
                          }
                          className="w-full accent-teal-700"
                          aria-label={`${c.label} の重み`}
                        />
                        <p className="mt-1 text-[0.6875rem] text-gray-400">
                          1（参考程度）〜 5（決定的）／ いま {value}：{WEIGHT_HINT[value]}
                        </p>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => patchCriterion(c.id, { weight: value })}
                          disabled={!dirty || saving}
                          className="flex items-center gap-2 rounded-full bg-teal-700 px-4 py-1.5 text-xs font-bold text-white active:scale-95 disabled:opacity-40"
                        >
                          {saving && <Spinner />}
                          {saving ? "保存中…" : "重みを保存"}
                        </button>
                        <button
                          onClick={() => patchCriterion(c.id, { active: !c.active })}
                          disabled={saving}
                          className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600 active:scale-95 disabled:opacity-40"
                        >
                          {c.active ? "この軸を無効にする" : "この軸を有効にする"}
                        </button>
                        {savedId === c.id && (
                          <span className="text-xs font-bold text-emerald-600">保存しました</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ---------------- 下段：深掘り再採点 ---------------- */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-gray-500">深掘り再採点</h2>

            {jobs.length === 0 ? (
              <EmptyBlock
                icon="🎯"
                title="再採点できる求人がありません"
                hint="まだ取込していません。ホームの「今すぐ取込」を押してください。求人が入ると、ここで1件ずつ判断軸ごとの内訳まで採点できます。"
                action={{ href: "/", label: "ホームで取込する" }}
              />
            ) : (
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <label className="block text-xs font-bold text-gray-500" htmlFor="job-select">
                  採点する求人
                </label>
                <select
                  id="job-select"
                  value={selectedJobId}
                  onChange={(e) => setSelectedJobId(e.target.value)}
                  disabled={rescoring}
                  className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 disabled:opacity-50"
                >
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.fit_score === null ? "未採点" : `${j.fit_score}点`}／{j.company}／{j.title}
                    </option>
                  ))}
                </select>

                <button
                  onClick={rescore}
                  disabled={rescoring || selectedJobId === ""}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-teal-700 px-4 py-2.5 text-sm font-bold text-white active:bg-teal-800 disabled:opacity-50"
                >
                  {rescoring && <Spinner />}
                  {rescoring ? `採点中… ${elapsed}秒` : "深掘り再採点する"}
                </button>

                {rescoring ? (
                  <p className="mt-2 rounded-xl bg-teal-50 px-3 py-2 text-xs leading-relaxed text-teal-800">
                    Opus 5 が判断軸ごとに読み込んでいます。1〜2分かかることがあります。
                    この画面を開いたままお待ちください。
                  </p>
                ) : (
                  <p className="mt-2 text-[0.6875rem] leading-relaxed text-gray-400">
                    上の重みを保存してから実行すると、その重みで採点されます。
                    結果は求人一覧にも反映されます。
                  </p>
                )}

                {rescoreError && (
                  <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2 text-xs leading-relaxed text-rose-700">
                    {rescoreError}
                  </p>
                )}
              </div>
            )}

            {/* 採点結果 */}
            {result && (
              <div className="mt-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-bold leading-snug text-gray-900">
                      {result.job.company}
                    </h3>
                    <p className="mt-0.5 text-sm leading-relaxed text-gray-700">
                      {result.job.title}
                    </p>
                  </div>
                  <ScoreBadge score={result.result.score} size="lg" />
                </div>

                <p className="mt-3 text-sm leading-relaxed text-gray-800">
                  {result.result.summary}
                </p>

                {/* 判断軸ごとの内訳 */}
                {breakdown.length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-xs font-bold text-gray-500">判断軸ごとの内訳</h4>
                    <div className="space-y-3">
                      {breakdown.map((b, i) => (
                        <div key={`${b.label}-${i}`}>
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="min-w-0 flex-1 text-xs font-bold text-gray-700">
                              {b.label}
                            </p>
                            <p className="shrink-0 text-xs font-bold text-gray-900">{b.score}</p>
                          </div>
                          {/* 横棒グラフ。幅は値によって変わるので inline style で指定する
                              （Tailwind は動的なクラス名を生成できないため）。 */}
                          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                            <div
                              className={`h-full rounded-full ${
                                b.score >= 85
                                  ? "bg-emerald-500"
                                  : b.score >= 70
                                  ? "bg-sky-500"
                                  : b.score >= 55
                                  ? "bg-amber-500"
                                  : "bg-rose-400"
                              }`}
                              style={{ width: `${Math.max(0, Math.min(100, b.score))}%` }}
                            />
                          </div>
                          <p className="mt-1 text-[0.6875rem] leading-relaxed text-gray-500">
                            {b.comment}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 良い点・懸念 */}
                <div className="mt-4 space-y-2">
                  {result.result.pros.length > 0 && (
                    <div className="rounded-xl bg-emerald-50 px-3 py-2">
                      <p className="text-[0.6875rem] font-bold text-emerald-700">良い点</p>
                      <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-emerald-900">
                        {result.result.pros.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {result.result.cons.length > 0 && (
                    <div className="rounded-xl bg-rose-50 px-3 py-2">
                      <p className="text-[0.6875rem] font-bold text-rose-700">懸念</p>
                      <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-rose-900">
                        {result.result.cons.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <p className="mt-3 text-[0.6875rem] text-gray-400">
                  {fmtDate(new Date().toISOString())} 採点・モデル {result.result.model}
                </p>
              </div>
            )}
          </section>
        </>
      )}

      <BackToHome />
    </main>
  );
}
