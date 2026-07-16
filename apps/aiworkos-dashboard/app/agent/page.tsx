"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Organization = { name: string; count: number };

type Meeting = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  organization: string | null;
};

type Proposal = {
  summary: string;
  issues: string[];
  actions: { title: string; detail: string }[];
  materialOutline: string[];
};

type AgentResponse = {
  organization: string;
  meetings: Meeting[];
  proposal: Proposal;
  deliverablesCount?: number;
  cached?: boolean;
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function TimelineItem({ meeting }: { meeting: Meeting }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = meeting.content.length > 120;

  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-1.5 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-indigo-500 bg-white" />
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {meeting.event_date && (
            <span className="text-xs font-medium text-indigo-600">
              {formatDate(meeting.event_date)}
            </span>
          )}
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
            会議
          </span>
        </div>
        <h4 className="mt-1.5 text-base font-bold leading-snug text-gray-900">
          {meeting.title}
        </h4>
        <p
          className={`mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700 ${
            !expanded && isLong ? "line-clamp-3" : ""
          }`}
        >
          {meeting.content}
        </p>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-sm font-medium text-indigo-600 active:opacity-70"
          >
            {expanded ? "閉じる" : "もっと見る"}
          </button>
        )}
      </div>
    </li>
  );
}

export default function AgentPage() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentResponse | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/organizations");
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok) {
          setOrgsError(
            (data && typeof data.error === "string" && data.error) ||
              "自治体一覧の取得に失敗しました"
          );
          return;
        }
        setOrgs(Array.isArray(data?.organizations) ? data.organizations : []);
      } catch {
        if (active) setOrgsError("自治体一覧の取得に失敗しました");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const runAgent = useCallback(
    async (force = false) => {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization: selected, force }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            "提案の生成に失敗しました"
        );
        return;
      }
      setResult(data as AgentResponse);
    } catch {
      setError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setLoading(false);
    }
    },
    [selected, loading]
  );

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-600 active:opacity-70"
        >
          ← 横断検索へ
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          提案エージェント
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          自治体を選ぶと、これまでの経緯と次の打ち手を提案します
        </p>
      </header>

      {/* 選択フォーム */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <label
          htmlFor="org-select"
          className="block text-sm font-medium text-gray-600"
        >
          自治体を選択
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <select
            id="org-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={!orgs || loading}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          >
            <option value="">
              {orgs ? "自治体を選んでください" : "読み込み中..."}
            </option>
            {orgs?.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name} ({o.count})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => runAgent(false)}
            disabled={!selected || loading}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
          >
            提案を生成
          </button>
        </div>
        {orgsError && (
          <p className="mt-2 text-sm text-red-600">{orgsError}</p>
        )}
      </div>

      {/* 結果エリア */}
      <section className="mt-6" aria-live="polite">
        {loading && (
          <div className="flex flex-col items-center gap-3 py-12">
            <div
              className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
              role="status"
              aria-label="分析中"
            />
            <p className="text-sm text-gray-500">Claudeが分析中…</p>
            <p className="text-xs text-gray-400">
              会議履歴を読み込み、戦略を組み立てています
            </p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && !result && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center">
            <p className="text-sm leading-relaxed text-gray-600">
              自治体を選んで「提案を生成」を押すと、
              <br />
              これまでの施策履歴とAIによる提案が表示されます。
            </p>
          </div>
        )}

        {!loading && !error && result && (
          <div className="space-y-8">
            {/* 施策履歴タイムライン */}
            <div>
              <h2 className="mb-3 text-lg font-bold text-gray-900">
                施策履歴タイムライン
              </h2>
              {result.meetings.length > 0 ? (
                <ul className="ml-1.5 space-y-3 border-l-2 border-indigo-100">
                  {result.meetings.map((m) => (
                    <TimelineItem key={m.id} meeting={m} />
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
                  この自治体の会議履歴はまだ登録されていません。
                </p>
              )}
            </div>

            {/* AI提案パネル */}
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-gray-900">AI提案</h2>
                {result.cached && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                    キャッシュ
                  </span>
                )}
                {(result.deliverablesCount ?? 0) > 0 && (
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                    過去成果物 {result.deliverablesCount}件を参照
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => runAgent(true)}
                  disabled={loading}
                  className="ml-auto rounded-lg border border-indigo-200 px-3 py-1.5 text-sm font-medium text-indigo-600 transition active:bg-indigo-50 disabled:opacity-40"
                >
                  再生成
                </button>
              </div>

              {/* 経緯サマリ */}
              <section className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4">
                <h3 className="text-sm font-bold text-indigo-800">
                  ① これまでの経緯
                </h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                  {result.proposal.summary || "（要約なし）"}
                </p>
              </section>

              {/* 論点 */}
              <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900">② 論点</h3>
                {result.proposal.issues.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-gray-700">
                    {result.proposal.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">（論点なし）</p>
                )}
              </section>

              {/* 次の打ち手 */}
              <section>
                <h3 className="mb-2 text-sm font-bold text-gray-900">
                  ③ 次の打ち手
                </h3>
                <div className="space-y-3">
                  {result.proposal.actions.length > 0 ? (
                    result.proposal.actions.map((action, i) => (
                      <div
                        key={i}
                        className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
                      >
                        <p className="text-base font-bold text-gray-900">
                          {action.title}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                          {action.detail}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
                      （打ち手なし）
                    </p>
                  )}
                </div>
              </section>

              {/* 提案資料の骨子 */}
              <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900">
                  ④ 提案資料の骨子
                </h3>
                {result.proposal.materialOutline.length > 0 ? (
                  <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-gray-700">
                    {result.proposal.materialOutline.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">（骨子なし）</p>
                )}
              </section>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
