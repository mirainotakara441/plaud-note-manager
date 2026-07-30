"use client";

import { useCallback, useEffect, useState } from "react";

// 取込パネル。/api/jobs は「直近3日分（JST基準）＋ 期間外でも未処理のもの」だけを返す。
// 完了・エラーの古い行が延々と残って読めなくなっていたため（2026-07-30 吉井さん指摘）、
// DBの行は消さずに表示側で絞っている。
type Job = {
  id: string;
  // 起票元は Eight/PLAUD だけでなく、/weapons のスライド清書・提案書起票もここに乗る。
  kind: "eight" | "plaud" | "slides" | "proposal";
  status: "queued" | "running" | "done" | "error";
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const KIND_LABEL: Record<string, string> = {
  eight: "Eight",
  plaud: "PLAUD",
  slides: "スライド清書",
  proposal: "提案書",
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
  // APIが絞り込みに使った期間。ラベル表記と「期間外の未処理」判定に使う。
  const [days, setDays] = useState(3);
  const [since, setSince] = useState<string | null>(null);
  const [enqueuing, setEnqueuing] = useState<Job["kind"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const data = await res.json();
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      if (typeof data?.days === "number") setDays(data.days);
      if (typeof data?.since === "string") setSince(data.since);
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
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-gray-500">取込</h2>
        <span className="text-xs text-gray-400">履歴は直近{days}日分</span>
      </div>
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
          <br />
          履歴は直近{days}日分だけ表示します（未処理のものは{days}
          日より前でも必ず表示）。
        </p>

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {/* ジョブ一覧（直近3日分＋期間外でも未処理のもの） */}
        <div className="mt-4 space-y-2">
          {jobs.length === 0 ? (
            <p className="text-xs text-gray-400">
              直近{days}日の取り込みはありません。
            </p>
          ) : (
            jobs.map((job) => {
              // 期間外なのに一覧に出ている＝未処理のまま残っているジョブ。
              // ワーカーが止まっているサインなので目立たせる。
              const stalled = !!since && job.created_at < since;
              return (
                <div
                  key={job.id}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                    stalled
                      ? "border-amber-300 bg-amber-50"
                      : "border-gray-100 bg-gray-50"
                  }`}
                >
                  <span className="text-sm font-medium text-gray-800">
                    {KIND_LABEL[job.kind] ?? job.kind}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status] ?? "bg-gray-100 text-gray-600"}`}
                  >
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                  {stalled && (
                    <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      未処理のまま滞留
                    </span>
                  )}
                  <span className="ml-auto text-xs text-gray-400">
                    {formatTime(job.created_at)}
                  </span>
                </div>
              );
            })
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
