"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// 月報ドラフト自動生成：暦月を選ぶと、その月の週報（weekly_reports）を集計した
// KPIと、AIが書いた「今月を一言で」「団体別ハイライト」「来月への引き継ぎ」を
// 含むドラフトを表示する。データは /api/monthly-report。
// UIパターンは app/agent/page.tsx（手直しの流れ）・app/weekly-report/page.tsx（KPI表示）を踏襲。

type WeekKpi = {
  week_start: string;
  contacts: number;
  orgs: number;
  tacticsTotal: number;
  tacticsDone: number;
};

type MonthKpi = {
  weeks: WeekKpi[];
  totalContacts: number;
  totalOrgs: number;
  tacticsTotal: number;
  tacticsDone: number;
  completionRate: number;
};

type Highlight = { organization: string; summary: string };

type Draft = {
  oneLiner: string;
  highlights: Highlight[];
  handover: string[];
};

type Report = Draft & {
  month: string;
  kpi: MonthKpi | null;
  edited: boolean;
  notionUrl: string | null;
  cached?: boolean;
};

function defaultMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function fmtMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}

function fmtWeekRange(weekStart: string): string {
  const [, m, d] = weekStart.split("-");
  return `${m}/${d}週`;
}

// 手直し用の1行。編集と削除ができる（agent/page.tsx の EditableRow と同じ考え方）。
function EditableRow({
  value,
  onChange,
  onDelete,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  onDelete: () => void;
  rows?: number;
}) {
  return (
    <div className="flex items-start gap-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="block w-full rounded-lg border border-rose-200 px-3 py-2 text-sm text-gray-900 focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100"
      />
      <button
        type="button"
        onClick={onDelete}
        aria-label="この項目を削除"
        className="mt-1 shrink-0 rounded-md px-2 py-1 text-xs font-medium text-gray-400 active:bg-gray-100"
      >
        ✕
      </button>
    </div>
  );
}

function AddRowButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-dashed border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 active:bg-rose-50"
    >
      ＋ {label}
    </button>
  );
}

export default function MonthlyReportPage() {
  const [month, setMonth] = useState(defaultMonth());
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    setDraft(null);
    try {
      const res = await fetch(`/api/monthly-report?month=${m}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || "取得に失敗しました");
      setAvailableMonths(Array.isArray(data?.available_months) ? data.available_months : []);
      if (data?.report) {
        setReport({
          month: data.report.month,
          kpi: data.report.kpi,
          oneLiner: data.report.oneLiner,
          highlights: data.report.highlights,
          handover: data.report.handover,
          edited: !!data.report.edited,
          notionUrl: data.report.notionUrl,
        });
      } else {
        setReport(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const generate = useCallback(
    async (force: boolean) => {
      if (generating) return;
      setGenerating(true);
      setError(null);
      setSavedMsg(null);
      try {
        const res = await fetch("/api/monthly-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ month, force }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) || "月報の生成に失敗しました");
        setReport({
          month: data.month,
          kpi: data.kpi,
          oneLiner: data.oneLiner,
          highlights: data.highlights,
          handover: data.handover,
          edited: !!data.edited,
          notionUrl: data.notionUrl,
          cached: !!data.cached,
        });
        setDraft(null);
        if (!availableMonths.includes(month)) {
          setAvailableMonths((prev) => [month, ...prev].sort().reverse());
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "月報の生成に失敗しました");
      } finally {
        setGenerating(false);
      }
    },
    [month, generating, availableMonths]
  );

  async function saveEdit() {
    if (!report || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/monthly-report", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: report.month,
          oneLiner: draft.oneLiner,
          highlights: draft.highlights,
          handover: draft.handover,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || "手直しの保存に失敗しました");
      setReport({ ...report, ...draft, edited: true, notionUrl: data.report?.notionUrl ?? report.notionUrl });
      setDraft(null);
      setSavedMsg("手直しを保存しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : "手直しの保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  const kpi = report?.kpi ?? null;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          月報ドラフト自動生成
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          週報を集計したKPIと、AIが書いた月報ドラフトを1画面で
        </p>
      </header>

      {/* 月選択 */}
      <div className="mb-5 flex items-center gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="min-w-0 flex-1 rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200"
        />
      </div>

      {availableMonths.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {availableMonths.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMonth(m)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                m === month
                  ? "bg-indigo-500 text-white"
                  : "bg-gray-100 text-gray-500 active:bg-gray-200"
              }`}
            >
              {fmtMonthLabel(m)}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {!loading && error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}

      {!loading && (
        <>
          {/* 生成・再生成ボタン */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => generate(!!report)}
              disabled={generating || !!draft}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
            >
              {generating ? "生成中…" : report ? "再生成する" : "生成する"}
            </button>
            {report?.cached && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                キャッシュ
              </span>
            )}
            {report?.edited && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                ✏️ 手直し済み
              </span>
            )}
            {report?.notionUrl && (
              <a
                href={report.notionUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 transition active:bg-gray-50"
              >
                Notionで見る →
              </a>
            )}
          </div>

          {generating && (
            <div className="mb-5 flex flex-col items-center gap-3 py-8">
              <div
                className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
                role="status"
                aria-label="生成中"
              />
              <p className="text-sm text-gray-500">Claudeが月報ドラフトを作成中…</p>
              <p className="text-xs text-gray-400">週報を読み込み、要約とハイライトを組み立てています</p>
            </div>
          )}

          {!generating && !report && (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center">
              <p className="text-sm leading-relaxed text-gray-600">
                {fmtMonthLabel(month)}の月報はまだ生成されていません。
                <br />
                「生成する」を押すと、週報を集計してAIがドラフトを作成します。
              </p>
            </div>
          )}

          {!generating && report && kpi && (
            <>
              {/* KPI */}
              <div className="mb-3 grid grid-cols-3 gap-2">
                {[
                  { l: "接点数", v: `${kpi.totalContacts}件`, c: "text-gray-900" },
                  { l: "対象団体数", v: `${kpi.totalOrgs}団体`, c: "text-gray-900" },
                  {
                    l: "宿題消化率",
                    v: `${Math.round(kpi.completionRate * 100)}%`,
                    c: "text-amber-600",
                  },
                ].map((m) => (
                  <div key={m.l} className="rounded-xl bg-gray-50 px-2 py-3 text-center">
                    <div className={`text-xl font-bold ${m.c}`}>{m.v}</div>
                    <div className="mt-0.5 text-[11px] text-gray-500">{m.l}</div>
                  </div>
                ))}
              </div>

              {/* 週別内訳 */}
              <div className="mb-6 overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full min-w-[420px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs text-gray-400">
                      <th className="px-3 py-2 font-medium">週</th>
                      <th className="px-3 py-2 font-medium">接点数</th>
                      <th className="px-3 py-2 font-medium">団体数</th>
                      <th className="px-3 py-2 font-medium">次アクション対応</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kpi.weeks.map((w) => (
                      <tr key={w.week_start} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-2 font-medium text-gray-700">
                          {fmtWeekRange(w.week_start)}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{w.contacts}件</td>
                        <td className="px-3 py-2 text-gray-600">{w.orgs}団体</td>
                        <td className="px-3 py-2 text-gray-600">
                          {w.tacticsDone}/{w.tacticsTotal}件
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 手直しの操作 */}
              <div className="mb-5 flex flex-wrap items-center gap-2">
                {draft ? (
                  <>
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={saving}
                      className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white transition active:bg-rose-700 disabled:opacity-40"
                    >
                      {saving ? "保存中..." : "手直しを保存"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft(null)}
                      disabled={saving}
                      className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 transition active:bg-gray-50"
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDraft(structuredClone({ oneLiner: report.oneLiner, highlights: report.highlights, handover: report.handover }))}
                    className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-700 transition active:bg-rose-50"
                  >
                    ✏️ 手直しする
                  </button>
                )}
                {savedMsg && !draft && (
                  <span className="rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800">
                    ✅ {savedMsg}
                  </span>
                )}
              </div>

              <div className="space-y-6">
                {/* 今月を一言で */}
                <section className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4">
                  <h2 className="text-sm font-bold text-indigo-800">今月を一言で</h2>
                  {draft ? (
                    <textarea
                      value={draft.oneLiner}
                      onChange={(e) => setDraft({ ...draft, oneLiner: e.target.value })}
                      rows={3}
                      className="mt-2 block w-full rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100"
                    />
                  ) : (
                    <p className="mt-2 text-lg font-bold leading-relaxed text-indigo-950">
                      {report.oneLiner || "（未設定）"}
                    </p>
                  )}
                </section>

                {/* 団体別ハイライト */}
                <section>
                  <h2 className="mb-2 text-sm font-bold text-gray-900">団体別ハイライト</h2>
                  {draft ? (
                    <div className="space-y-3">
                      {draft.highlights.map((h, i) => (
                        <div key={i} className="rounded-xl border border-rose-200 bg-white p-3 shadow-sm">
                          <div className="flex items-start gap-2">
                            <input
                              value={h.organization}
                              onChange={(e) => {
                                const next = [...draft.highlights];
                                next[i] = { ...next[i], organization: e.target.value };
                                setDraft({ ...draft, highlights: next });
                              }}
                              placeholder="団体名"
                              className="block w-full rounded-lg border border-rose-200 px-3 py-2 text-base font-bold text-gray-900 focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  highlights: draft.highlights.filter((_, j) => j !== i),
                                })
                              }
                              aria-label="このハイライトを削除"
                              className="mt-1 shrink-0 rounded-md px-2 py-1 text-xs font-medium text-gray-400 active:bg-gray-100"
                            >
                              ✕
                            </button>
                          </div>
                          <textarea
                            value={h.summary}
                            onChange={(e) => {
                              const next = [...draft.highlights];
                              next[i] = { ...next[i], summary: e.target.value };
                              setDraft({ ...draft, highlights: next });
                            }}
                            rows={3}
                            placeholder="今月の動き・進捗"
                            className="mt-2 block w-full rounded-lg border border-rose-200 px-3 py-2 text-sm text-gray-900 focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100"
                          />
                        </div>
                      ))}
                      <AddRowButton
                        label="ハイライトを足す"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            highlights: [...draft.highlights, { organization: "", summary: "" }],
                          })
                        }
                      />
                    </div>
                  ) : report.highlights.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {report.highlights.map((h, i) => (
                        <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                          <h3 className="text-base font-bold text-gray-900">{h.organization}</h3>
                          <p className="mt-1.5 text-sm leading-relaxed text-gray-700">{h.summary}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
                      （ハイライトなし）
                    </p>
                  )}
                </section>

                {/* 来月への引き継ぎ */}
                <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <h2 className="text-sm font-bold text-gray-900">来月への引き継ぎ</h2>
                  {draft ? (
                    <div className="mt-2 space-y-2">
                      {draft.handover.map((item, i) => (
                        <EditableRow
                          key={i}
                          value={item}
                          onChange={(v) => {
                            const next = [...draft.handover];
                            next[i] = v;
                            setDraft({ ...draft, handover: next });
                          }}
                          onDelete={() =>
                            setDraft({
                              ...draft,
                              handover: draft.handover.filter((_, j) => j !== i),
                            })
                          }
                        />
                      ))}
                      <AddRowButton
                        label="引き継ぎ事項を足す"
                        onClick={() => setDraft({ ...draft, handover: [...draft.handover, ""] })}
                      />
                    </div>
                  ) : report.handover.length > 0 ? (
                    <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-gray-700">
                      {report.handover.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-gray-500">（引き継ぎ事項なし）</p>
                  )}
                </section>
              </div>
            </>
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
