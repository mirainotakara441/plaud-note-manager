"use client";

import { useCallback, useEffect, useState } from "react";

type Job = {
  id: string;
  kind: "eight" | "plaud";
  status: "queued" | "running" | "done" | "error";
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const KIND_LABEL: Record<Job["kind"], string> = {
  eight: "Eight",
  plaud: "PLAUD",
};

const STATUS_STYLE: Record<Job["status"], string> = {
  queued: "bg-gray-100 text-gray-600",
  running: "bg-blue-100 text-blue-700",
  done: "bg-emerald-100 text-emerald-800",
  error: "bg-red-100 text-red-700",
};

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "待機中",
  running: "実行中",
  done: "完了",
  error: "エラー",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export default function IntegrationPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [enqueuing, setEnqueuing] = useState<Job["kind"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const data = await res.json();
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch {
      // 一覧取得失敗は致命的でない
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  async function enqueue(kind: Job["kind"]) {
    setError(null);
    setEnqueuing(kind);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, params: { source: "front" } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "登録に失敗しました");
      } else {
        await loadJobs();
      }
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setEnqueuing(null);
    }
  }

  return (
    <section className="mt-6">
      <h2 className="mb-2 px-1 text-sm font-semibold text-gray-500">取込</h2>
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => enqueue("eight")}
            disabled={enqueuing !== null}
            className="flex-1 rounded-xl bg-sky-600 px-4 py-3 text-base font-semibold text-white transition active:bg-sky-700 disabled:opacity-40"
          >
            {enqueuing === "eight" ? "登録中..." : "Eight取込"}
          </button>
          <button
            type="button"
            onClick={() => enqueue("plaud")}
            disabled={enqueuing !== null}
            className="flex-1 rounded-xl bg-teal-600 px-4 py-3 text-base font-semibold text-white transition active:bg-teal-700 disabled:opacity-40"
          >
            {enqueuing === "plaud" ? "登録中..." : "PLAUD取込"}
          </button>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-gray-400">
          押すと取込ジョブが登録され、実行ワーカーが順次処理して Notion・Supabase
          へ連携します。※ワーカー接続までは「待機中」のまま保留されます。
        </p>

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {/* ジョブ一覧 */}
        <div className="mt-4 space-y-2">
          {jobs.length === 0 ? (
            <p className="text-xs text-gray-400">まだ取込ジョブはありません。</p>
          ) : (
            jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <span className="text-sm font-medium text-gray-800">
                  {KIND_LABEL[job.kind]}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status]}`}
                >
                  {STATUS_LABEL[job.status]}
                </span>
                <span className="ml-auto text-xs text-gray-400">
                  {formatTime(job.created_at)}
                </span>
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={loadJobs}
          className="mt-3 text-xs font-medium text-indigo-600 active:opacity-70"
        >
          状態を更新
        </button>
      </div>
    </section>
  );
}
