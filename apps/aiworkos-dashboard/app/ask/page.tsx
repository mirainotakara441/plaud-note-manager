"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// /ask 相談窓口。難しい問いを投げると、AIが記憶層を自分で何度も引きながら
// 根拠つきで答える。/search（生チャンクを見る）との違いは api/ask/route.ts 冒頭に。
//
// 画面の設計:
//   ・生成に1〜3分かかることがある。進行中は経過秒と「いま何をしているか」を
//     出し続ける（無言の待ち時間は、壊れたのか考えているのか区別できない）。
//   ・答えの下に「何を調べたか」（ツールの足あと）を畳んで置く。
//     根拠の検証はここから始まる。
//   ・役に立った/ずれてる の1タップを置く。押されないと、この窓口が
//     役に立っているのかを後から誰も測れない。

type Step = { tool: string; input: Record<string, unknown>; ms: number };

type AskResponse = {
  id: string | null;
  answer: string;
  sources: string[];
  steps: Step[];
  ms: number;
  error?: string;
};

type LogRow = {
  id: string;
  question: string;
  answer: string;
  sources: string[] | null;
  rating: string | null;
  ms: number | null;
  created_at: string;
};

const TOOL_LABEL: Record<string, string> = {
  search_memory: "記憶を検索",
  org_history: "会議履歴",
  weekly_reports: "週報",
};

function toolSummary(s: Step): string {
  const label = TOOL_LABEL[s.tool] ?? s.tool;
  const q =
    (s.input.query as string) ??
    (s.input.organization as string) ??
    (typeof s.input.weeks === "number" ? `直近${s.input.weeks}週` : "");
  return q ? `${label}「${q}」` : label;
}

const EXAMPLES = [
  "堺市の申込が遅れた場合、9月の人口カバー率にどう効く？",
  "東洋紙業の攻め方、これまでの経緯を踏まえて筋の良い順に",
  "オンライン化率が低いと言われた時の切り返し、過去の会議から組み立てて",
];

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ?q= で問いを持って開けるようにする（夜間参謀の「問い」から1タップで飛ぶ導線）。
  // 自動送信はしない——1〜3分の生成が走るものを、リンクを踏んだだけで発火させない。
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setQuestion(q.slice(0, 2000));
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const r = await fetch("/api/ask", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { logs: LogRow[] };
      setLogs(data.logs ?? []);
    } catch {
      // 履歴が読めなくても新規の相談はできる。静かに諦める。
    }
  }, []);

  useEffect(() => {
    void loadLogs();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadLogs]);

  async function submit(q?: string) {
    const body = (q ?? question).trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setShowSteps(false);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: body }),
      });
      const data = (await r.json()) as AskResponse;
      if (!r.ok) {
        setError(data.error ?? `エラーが発生しました（${r.status}）`);
      } else {
        setResult(data);
        void loadLogs();
      }
    } catch {
      setError("接続できませんでした。もう一度お試しください。");
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      setBusy(false);
    }
  }

  async function rate(id: string, rating: "helpful" | "off" | null) {
    try {
      await fetch("/api/ask", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, rating }),
      });
      void loadLogs();
    } catch {
      // 評価の失敗は答えの価値を損なわない。黙って流す。
    }
  }

  // 答え本文と根拠ブロックを分けて描画する（--- 区切りはAPI側の規約）。
  const answerBody = result ? result.answer.split(/\n---\n/)[0] : "";

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-900">🧠 相談窓口</h1>
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ホームへ
        </Link>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        難しい問いほど向いています。AIが日記・会議録・成果物・週報を自分で検索しながら、
        根拠つきで答えます。原文をそのまま見たいときは
        <Link href="/search" className="mx-1 text-indigo-600 underline">
          横断検索
        </Link>
        へ。
      </p>

      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          placeholder="例: 堺市が9月に間に合わなかったら、どこでカバーする筋があるか？"
          className="w-full resize-y rounded-xl border border-gray-300 px-3 py-2 text-sm"
          disabled={busy}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={busy}
                onClick={() => setQuestion(ex)}
                className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500 active:bg-gray-50 disabled:opacity-40"
              >
                {ex.slice(0, 14)}…
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !question.trim()}
            className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
          >
            相談する
          </button>
        </div>
      </div>

      {busy && (
        <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 text-sm text-indigo-800">
          <p className="font-bold">考えています…（{elapsed}秒）</p>
          <p className="mt-1 text-xs text-indigo-600">
            記憶を検索→読む→足りなければ引き直す、を繰り返しています。
            問いによっては2〜3分かかります。画面を閉じずにお待ちください。
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{answerBody}</p>

          {result.sources.length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <p className="mb-1 text-xs font-bold text-gray-400">根拠</p>
              <ul className="space-y-0.5">
                {result.sources.map((s, i) => (
                  <li key={i} className="text-xs text-gray-500">
                    ・{s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.steps.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowSteps((v) => !v)}
                className="text-xs font-medium text-indigo-600 underline active:opacity-70"
              >
                {showSteps ? "調べ方を隠す" : `何を調べたか（${result.steps.length}回）`}
              </button>
              {showSteps && (
                <ol className="mt-1 space-y-0.5">
                  {result.steps.map((s, i) => (
                    <li key={i} className="text-xs text-gray-500">
                      {i + 1}. {toolSummary(s)}（{(s.ms / 1000).toFixed(1)}秒）
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3">
            <span className="text-xs text-gray-400">{(result.ms / 1000).toFixed(0)}秒で回答</span>
            {result.id && (
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => void rate(result.id!, "helpful")}
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 active:opacity-70"
                >
                  役に立った
                </button>
                <button
                  type="button"
                  onClick={() => void rate(result.id!, "off")}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-bold text-gray-500 active:opacity-70"
                >
                  ずれてる
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      {logs.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-bold text-gray-900">これまでの相談</h2>
          <ul className="space-y-2">
            {logs.map((l) => (
              <li key={l.id} className="rounded-xl border border-gray-200 bg-white">
                <button
                  type="button"
                  onClick={() => setOpenLog(openLog === l.id ? null : l.id)}
                  className="flex w-full items-start justify-between gap-2 p-3 text-left"
                >
                  <span className="text-sm text-gray-800">{l.question}</span>
                  <span className="shrink-0 text-xs text-gray-400">
                    {l.created_at.slice(5, 10).replace("-", "/")}
                    {l.rating === "helpful" && " 👍"}
                    {l.rating === "off" && " 👎"}
                  </span>
                </button>
                {openLog === l.id && (
                  <div className="border-t border-gray-100 p-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                      {l.answer.split(/\n---\n/)[0]}
                    </p>
                    {!l.rating && (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void rate(l.id, "helpful")}
                          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 active:opacity-70"
                        >
                          役に立った
                        </button>
                        <button
                          type="button"
                          onClick={() => void rate(l.id, "off")}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-bold text-gray-500 active:opacity-70"
                        >
                          ずれてる
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
