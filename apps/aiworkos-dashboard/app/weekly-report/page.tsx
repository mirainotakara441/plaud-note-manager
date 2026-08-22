"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

// 週報ダッシュボード：自治体・事業者・議員・委託会社まわりの週次活動を、
// カテゴリー別に1枚で確認する。データは /api/weekly-report（Supabase）。
//
// 登録はチャット（週報登録スキル）とこのページの両方からできる。どちらも
// 最終的に weekly_reports へ同じ形で入る（分類ロジックは /api/weekly-report の
// システムプロンプト側に集約）。
//
// 上部の済/未の帯は /diary と同じ考え方。「どの週まで登録したか」が
// 開いた瞬間に分かるようにするためで、登録直後も再取得して即反映する。

type Row = {
  id: string;
  week_start: string; // YYYY-MM-DD
  category: string;
  organization: string | null;
  summary: string;
  insight: string | null;
  tactic: string | null;
  created_at: string;
  action_done: boolean | null;
};

type Draft = {
  summary: string;
  insight: string;
  tactic: string;
};

type ApiResponse = {
  week_start: string | null;
  rows: Row[];
  available_weeks: string[];
  error?: string;
};

type StatusEntry = {
  week_start: string;
  registered: boolean;
  count: number;
  isCurrentWeek: boolean;
};

type StatusResponse = {
  currentWeek: string;
  weeks: number;
  entries: StatusEntry[];
  latestWeek: string | null;
  staleWeeks: number | null;
  error?: string;
};

type PostResult = {
  week_start: string;
  total: number;
  categories: Record<string, number>;
  replaced: boolean;
  correctionMessage: string | null;
};

const WEEKS_OPTIONS = [
  { label: "8週", value: 8 },
  { label: "13週", value: 13 },
  { label: "26週", value: 26 },
] as const;

const PLACEHOLDER = `例:
【全体】
・戦略合宿　8/21 開催
　→9月に支店を集め検討会を実施予定

【自治体】
・新宿区　8/19 面談（戸籍住民課 田中課長）
　→極めて否定的な反応
　→議員経由のトップアプローチを設計する

【議員】
　豊島区　7/23 辻議員による同行

見出し（【自治体】等）ごとに自動で分類して登録します`;

const CATEGORIES = [
  "全体",
  "支店",
  "自治体",
  "事業者",
  "議員",
  "委託会社",
  "銀行",
  "プロモーション",
] as const;

function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 与えられた日付が属する週の月曜日を返す
function toMonday(d: Date): string {
  const day = d.getDay(); // 0=日, 1=月, ...
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return fmtYMD(monday);
}

function addDays(ymd: string, days: number): string {
  const d = parseYMD(ymd);
  d.setDate(d.getDate() + days);
  return fmtYMD(d);
}

function fmtRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const [, em, ed] = end.split("-");
  return `${weekStart}〜${em}-${ed}`;
}

export default function WeeklyReportPage() {
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ summary: "", insight: "", tactic: "" });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // 登録フォーム
  const [showForm, setShowForm] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postResult, setPostResult] = useState<PostResult | null>(null);
  // 同じ週が既に登録済みのとき、上書きしてよいか確認するための保留状態。
  // 黙って消さないよう、確認を挟んでから replace:true で投げ直す。
  const [confirmOverwrite, setConfirmOverwrite] = useState<{
    week: string;
    count: number;
  } | null>(null);

  // 登録状況（済/未の帯）
  const [statusWeeks, setStatusWeeks] = useState<number>(8);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  // 保存時に音声入力の誤変換を辞書で直した場合の控えめな通知。
  // 実際に置換したものがある時だけAPIが文言を返す（無ければ null）。
  const [correctionMsg, setCorrectionMsg] = useState<string | null>(null);

  async function load(week?: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = week ? `?week=${week}` : "";
      const res = await fetch(`/api/weekly-report${qs}`, { cache: "no-store" });
      const data: ApiResponse = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setWeekStart(data.week_start);
      setRows(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  const fetchStatus = useCallback(async (weeks: number) => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/weekly-report/status?weeks=${weeks}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        setStatusError(data?.error ?? "登録状況の取得に失敗しました");
      } else {
        setStatus(data as StatusResponse);
      }
    } catch {
      setStatusError("登録状況の通信エラーが発生しました");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    fetchStatus(statusWeeks);
  }, [fetchStatus, statusWeeks]);

  function goToWeek(week: string) {
    load(week);
  }

  async function submitReport(replace: boolean) {
    setPostError(null);
    setPostResult(null);
    if (!text.trim()) {
      setPostError("週報本文を貼り付けてください");
      return;
    }
    setPosting(true);
    try {
      const res = await fetch("/api/weekly-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, replace }),
      });
      const data = await res.json();
      if (res.status === 409 && data?.needsConfirmation) {
        setConfirmOverwrite({ week: data.week_start, count: data.existingCount });
        setPostError(data?.error ?? null);
        return;
      }
      if (!res.ok) {
        setPostError(data?.error ?? "登録に失敗しました");
        return;
      }
      const result = data as PostResult;
      setPostResult(result);
      setConfirmOverwrite(null);
      setText("");
      setShowForm(false);
      // 登録した週をそのまま開き、済/未の帯にも即反映する。
      load(result.week_start);
      fetchStatus(statusWeeks);
    } catch {
      setPostError("通信エラーが発生しました");
    } finally {
      setPosting(false);
    }
  }

  function handleDateChange(value: string) {
    if (!value) return;
    const monday = toMonday(parseYMD(value));
    goToWeek(monday);
  }

  function handlePrev() {
    if (!weekStart) return;
    goToWeek(addDays(weekStart, -7));
  }

  function handleNext() {
    if (!weekStart) return;
    goToWeek(addDays(weekStart, 7));
  }

  function startEdit(r: Row) {
    setEditingId(r.id);
    setDraft({
      summary: r.summary,
      insight: r.insight ?? "",
      tactic: r.tactic ?? "",
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(id: string) {
    setSavingId(id);
    setEditError(null);
    setCorrectionMsg(null);
    try {
      const res = await fetch("/api/weekly-report", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          summary: draft.summary,
          insight: draft.insight.trim() === "" ? null : draft.insight,
          tactic: draft.tactic.trim() === "" ? null : draft.tactic,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました");
      const updated: Row | null = data.row;
      if (updated) {
        setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      }
      setCorrectionMsg(data.correctionMessage ?? null);
      setEditingId(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSavingId(null);
    }
  }

  // 編集フォーム（summary/insight/tactic）。全体カード・カテゴリー別カード両方で使う。
  function renderEditFields(id: string) {
    const saving = savingId === id;
    return (
      <div className="space-y-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            事実（summary）
          </label>
          <textarea
            value={draft.summary}
            onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
            rows={3}
            className="w-full rounded-lg border border-gray-200 p-2 text-sm text-gray-700"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            反応・示唆（insight）
          </label>
          <textarea
            value={draft.insight}
            onChange={(e) => setDraft((d) => ({ ...d, insight: e.target.value }))}
            rows={2}
            className="w-full rounded-lg border border-gray-200 p-2 text-sm text-gray-700"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            次アクション（tactic）
          </label>
          <textarea
            value={draft.tactic}
            onChange={(e) => setDraft((d) => ({ ...d, tactic: e.target.value }))}
            rows={2}
            className="w-full rounded-lg border border-gray-200 p-2 text-sm text-gray-700"
          />
        </div>
        {editError && (
          <p className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
            {editError}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => saveEdit(id)}
            disabled={saving}
            className="rounded-full bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white active:scale-95 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            onClick={cancelEdit}
            disabled={saving}
            className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600 active:scale-95 disabled:opacity-50"
          >
            キャンセル
          </button>
        </div>
      </div>
    );
  }

  // KPI集計
  const kpi = useMemo(() => {
    const contactRows = rows.filter((r) => r.category !== "全体");
    const orgs = new Set(
      rows.filter((r) => r.organization).map((r) => r.organization as string)
    );
    const withTactic = rows.filter((r) => r.tactic).length;
    const homeworkDone = rows.filter(
      (r) => r.tactic && r.action_done === true
    ).length;
    return {
      contacts: contactRows.length,
      orgs: orgs.size,
      withTactic,
      homeworkDone,
    };
  }, [rows]);

  // カテゴリー別にグループ化
  const byCategory = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const cat of CATEGORIES) map.set(cat, []);
    for (const r of rows) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return map;
  }, [rows]);

  const overall = byCategory.get("全体") ?? [];
  const otherCategories = CATEGORIES.filter((c) => c !== "全体");

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          週報ダッシュボード
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          自治体・事業者・議員・委託会社まわりの週次活動を、カテゴリー別に1枚で
        </p>
      </header>

      {/* 登録状況（済/未の帯） */}
      <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-700">登録状況</h2>
          <div className="flex shrink-0 gap-1">
            {WEEKS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatusWeeks(opt.value)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  statusWeeks === opt.value
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 text-gray-500 active:bg-gray-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {statusError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
            {statusError}
          </p>
        )}

        {!statusError && (
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {statusLoading && !status ? (
              <p className="py-2 text-sm text-gray-400">読み込み中...</p>
            ) : (
              status?.entries.map((entry) => {
                const [, m, d] = entry.week_start.split("-");
                return (
                  <button
                    key={entry.week_start}
                    type="button"
                    onClick={() => goToWeek(entry.week_start)}
                    className={`flex shrink-0 flex-col items-center gap-1 rounded-lg border px-2 py-1.5 transition active:scale-95 ${
                      entry.week_start === weekStart
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-100 bg-gray-50"
                    }`}
                  >
                    <span
                      className={`text-xs ${
                        entry.isCurrentWeek
                          ? "font-semibold text-indigo-700"
                          : "text-gray-500"
                      }`}
                    >
                      {Number(m)}/{Number(d)}週
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        entry.registered
                          ? "bg-emerald-100 text-emerald-700"
                          : entry.isCurrentWeek
                            ? "bg-gray-200 text-gray-500"
                            : "bg-red-50 text-red-600"
                      }`}
                    >
                      {entry.registered ? `済 ${entry.count}` : "未"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}

        {status && status.staleWeeks !== null && status.staleWeeks >= 2 && (
          <p className="mt-3 text-xs leading-relaxed text-amber-700">
            最終登録から{status.staleWeeks}週ほど間が空いています（最終: {status.latestWeek}）
          </p>
        )}

        <button
          type="button"
          onClick={() => {
            setShowForm((v) => !v);
            setPostError(null);
            setConfirmOverwrite(null);
          }}
          className="mt-3 w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition active:scale-95"
        >
          {showForm ? "閉じる" : "週報を登録する"}
        </button>

        {showForm && (
          <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={posting}
              rows={12}
              placeholder={PLACEHOLDER}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
            <p className="text-xs leading-relaxed text-gray-400">
              見出しごとに8カテゴリーへ自動で分類し、対象週も本文の日付から判定します。
            </p>

            {postError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
                {postError}
              </p>
            )}

            {confirmOverwrite ? (
              <div className="space-y-2 rounded-lg bg-amber-50 px-3 py-2.5">
                <p className="text-sm leading-relaxed text-amber-800">
                  {confirmOverwrite.week} 週の既存{confirmOverwrite.count}件を削除して
                  登録し直します。よろしいですか？
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => submitReport(true)}
                    disabled={posting}
                    className="rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white active:scale-95 disabled:opacity-50"
                  >
                    {posting ? "登録中…" : "上書きして登録"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmOverwrite(null);
                      setPostError(null);
                    }}
                    disabled={posting}
                    className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600 active:scale-95 disabled:opacity-50"
                  >
                    やめる
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => submitReport(false)}
                disabled={posting}
                className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white transition active:scale-95 disabled:opacity-40"
              >
                {posting ? "登録中..." : "登録する"}
              </button>
            )}
          </div>
        )}

        {postResult && (
          <div className="mt-3 space-y-1.5 rounded-lg bg-emerald-50 px-3 py-2.5">
            <p className="text-sm font-medium text-emerald-900">
              {postResult.week_start} 週に{postResult.total}件を
              {postResult.replaced ? "上書き" : ""}登録しました
            </p>
            <p className="text-xs text-emerald-700">
              {Object.entries(postResult.categories)
                .map(([cat, n]) => `${cat} ${n}`)
                .join(" ／ ")}
            </p>
            {postResult.correctionMessage && (
              <p className="text-xs text-amber-700">{postResult.correctionMessage}</p>
            )}
          </div>
        )}
      </div>

      {/* 週ナビゲーション */}
      <div className="mb-5 flex items-center gap-2">
        <button
          onClick={handlePrev}
          disabled={!weekStart}
          className="rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200 active:scale-95 disabled:opacity-40"
          aria-label="前週"
        >
          ←
        </button>
        <input
          type="date"
          value={weekStart ?? ""}
          onChange={(e) => handleDateChange(e.target.value)}
          className="min-w-0 flex-1 rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200"
        />
        <button
          onClick={handleNext}
          disabled={!weekStart}
          className="rounded-full bg-white px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-200 active:scale-95 disabled:opacity-40"
          aria-label="次週"
        >
          →
        </button>
      </div>

      {weekStart && (
        <h2 className="mb-4 text-sm font-bold text-gray-500">
          {fmtRange(weekStart)}
        </h2>
      )}

      {loading && (
        <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>
      )}
      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      {correctionMsg && (
        <p className="mb-3 rounded-xl bg-amber-50 px-4 py-2 text-xs leading-relaxed text-amber-800">
          {correctionMsg}
        </p>
      )}

      {!loading && !error && (
        <>
          {/* KPI */}
          <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { l: "訪問・接点件数", v: kpi.contacts, c: "text-gray-900" },
              { l: "対象団体数", v: kpi.orgs, c: "text-gray-900" },
              { l: "次アクションあり", v: kpi.withTactic, c: "text-amber-600" },
              {
                l: "宿題消化",
                v:
                  kpi.withTactic === 0
                    ? "宿題なし"
                    : `${kpi.homeworkDone}/${kpi.withTactic}`,
                c: "text-emerald-600",
              },
            ].map((m) => (
              <div key={m.l} className="rounded-xl bg-gray-50 px-2 py-3 text-center">
                <div className={`text-xl font-bold ${m.c}`}>{m.v}</div>
                <div className="mt-0.5 text-[0.6875rem] text-gray-500">{m.l}</div>
              </div>
            ))}
          </div>

          {/* 全体 */}
          <div className="mb-5">
            <h3 className="mb-2 text-sm font-bold text-gray-500">全体</h3>
            {overall.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-sm text-gray-400">今週の記録なし</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="space-y-3">
                  {overall.map((r, i) => (
                    <div
                      key={r.id}
                      className={i > 0 ? "border-t border-gray-100 pt-3" : ""}
                    >
                      {editingId === r.id ? (
                        renderEditFields(r.id)
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed text-gray-700">
                            {r.summary
                              .split("\n")
                              .filter((line) => line.trim().length > 0)
                              .map((line, li) => (
                                <li key={li}>{line}</li>
                              ))}
                          </ul>
                          <button
                            onClick={() => startEdit(r)}
                            className="shrink-0 text-xs text-indigo-500 active:opacity-70"
                          >
                            編集
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* カテゴリー別 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {otherCategories.map((cat) => {
              const items = byCategory.get(cat) ?? [];
              return (
                <div
                  key={cat}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <h3 className="mb-2 text-sm font-bold text-gray-500">{cat}</h3>
                  {items.length === 0 ? (
                    <p className="text-sm text-gray-400">今週の記録なし</p>
                  ) : (
                    <div className="space-y-3">
                      {items.map((r, i) => (
                        <div
                          key={r.id}
                          className={i > 0 ? "border-t border-gray-100 pt-3" : ""}
                        >
                          {editingId === r.id ? (
                            <div>
                              {r.organization && (
                                <h4 className="text-sm font-bold text-gray-900">
                                  {r.organization}
                                </h4>
                              )}
                              <div className="mt-1">{renderEditFields(r.id)}</div>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-start justify-between gap-2">
                                {r.organization ? (
                                  <h4 className="text-sm font-bold text-gray-900">
                                    {r.organization}
                                  </h4>
                                ) : (
                                  <div />
                                )}
                                <button
                                  onClick={() => startEdit(r)}
                                  className="shrink-0 text-xs text-indigo-500 active:opacity-70"
                                >
                                  編集
                                </button>
                              </div>
                              <p className="mt-1 text-sm leading-relaxed text-gray-700">
                                {r.summary}
                              </p>
                              {r.insight && (
                                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                                  {r.insight}
                                </p>
                              )}
                              {r.tactic && (
                                <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
                                  <div className="mb-1 flex items-center gap-2">
                                    <span className="font-medium">次：</span>
                                    {r.action_done === true && (
                                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[0.6875rem] font-medium text-emerald-700">
                                        ✅ 対応済み
                                      </span>
                                    )}
                                    {r.action_done === false && (
                                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-700">
                                        ⏳ 未対応
                                      </span>
                                    )}
                                  </div>
                                  {r.tactic}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
