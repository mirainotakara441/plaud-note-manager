"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import StakeholderPicker, {
  rememberStakeholder,
  type Category,
} from "@/app/components/StakeholderPicker";
import { composeReply, parseQuestions, stripBold } from "@/lib/parseQuestions";

type Msg = { role: "user" | "assistant"; content: string };
type Session = {
  id: string;
  organization: string;
  category: string;
  title: string | null;
  updated_at: string;
};

function RefineInner() {
  const searchParams = useSearchParams();
  const presetOrg = searchParams.get("org") ?? "";

  const [sessions, setSessions] = useState<Session[]>([]);
  const [organization, setOrganization] = useState(presetOrg);
  const [category, setCategory] = useState<Category>("自治体");
  const [theme, setTheme] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  // 問いごとの回答。キーは "Q1" / "Q2（再確認）" などのラベル。
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/refine", { cache: "no-store" });
      const d = await r.json();
      setSessions(Array.isArray(d?.sessions) ? d.sessions : []);
    } catch {
      // 一覧が取れなくても壁打ちはできる
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  async function start() {
    if (!organization.trim()) return setError(`${category}名を選んでください`);
    setError(null);
    setSaved(null);
    setLoading(true);
    try {
      const r = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          organization: organization.trim(),
          category,
          theme: theme.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "開始に失敗しました");
      setSessionId(d.sessionId);
      setMessages(d.messages ?? []);
      rememberStakeholder(category, organization.trim());
      loadSessions();
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  async function resume(s: Session) {
    setError(null);
    setSaved(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/refine?sessionId=${s.id}`, { cache: "no-store" });
      const d = await r.json();
      setSessionId(s.id);
      setOrganization(s.organization);
      setCategory((s.category as Category) ?? "自治体");
      setMessages(Array.isArray(d?.messages) ? d.messages : []);
    } catch {
      setError("読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!sessionId) return;
    // 問いを切り出せていれば各欄の回答を1本にまとめ、崩れていれば自由入力をそのまま送る
    const msg = questions.length > 0
      ? composeReply(questions, answers, skipped, input)
      : input.trim();
    if (!msg || !canSend) return;
    setError(null);
    setSaved(null);
    setInput("");
    setAnswers({});
    setSkipped({});
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);
    try {
      const r = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", sessionId, message: msg }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "送信に失敗しました");
      setMessages(d.messages ?? []);
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  // 最新の参謀メッセージだけを「問い＋入力欄」に展開する。過去のやり取りは読み物として残す。
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  const lastAssistant =
    lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : null;
  const parsed = lastAssistant ? parseQuestions(lastAssistant.content) : null;
  const questions = parsed?.questions ?? [];

  // 1問でも答えるかスキップしていれば送れる。全部空のまま送っても意味がないので止める。
  const canSend =
    questions.length > 0
      ? questions.some((q) => (answers[q.label] ?? "").trim() || skipped[q.label]) ||
        !!input.trim()
      : !!input.trim();

  async function saveMatured() {
    if (!sessionId) return;
    setError(null);
    setSaving(true);
    try {
      const r = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", sessionId }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "登録に失敗しました");
      setSaved(d.title ?? "熟成内容");
      loadSessions();
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">壁打ち</h1>
        <p className="mt-1 text-sm text-gray-500">
          登録内容を土台にAIが深掘り質問。答えるほど内容が熟成し、成果物として記憶に還ります
        </p>
      </header>

      {/* 対象選択 */}
      {!sessionId && (
        <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <StakeholderPicker
            category={category}
            onCategoryChange={setCategory}
            name={organization}
            onNameChange={setOrganization}
            disabled={loading}
          />

          {/* テーマ出し：自分で決める／AIに任せる の両方に対応 */}
          <div>
            <label className="block text-sm font-medium text-gray-600">
              深掘りしたいテーマ（任意）
            </label>
            <textarea
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              rows={2}
              disabled={loading}
              placeholder="例: 無償トライアルの出し方を詰めたい / 議員ルートの口説き方"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-gray-400">
              空にすると、AIが登録内容を読んでテーマを決めて深掘りします。
            </p>
          </div>

          <button
            type="button"
            onClick={start}
            disabled={loading}
            className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
          >
            {loading ? "土台を読み込み中..." : "壁打ちを始める"}
          </button>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
        </div>
      )}

      {/* チャット */}
      {sessionId && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-semibold text-indigo-700">
              {organization}（{category}）
            </span>
            <button
              type="button"
              onClick={() => {
                setSessionId(null);
                setMessages([]);
                setSaved(null);
              }}
              className="ml-auto text-sm font-medium text-gray-500 active:opacity-70"
            >
              対象を変える
            </button>
          </div>

          {/* これまでのやり取り。最新の参謀メッセージは下の「問い」欄に展開するのでここでは出さない */}
          <div className="space-y-3">
            {messages.map((m, i) =>
              i === lastAssistantIndex && questions.length > 0 ? null : (
                <div
                  key={i}
                  className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "assistant"
                      ? "border border-gray-200 bg-white text-gray-800 shadow-sm"
                      : "ml-6 bg-indigo-600 text-white"
                  }`}
                >
                  {m.role === "assistant" ? stripBold(m.content) : m.content}
                </div>
              )
            )}
            {loading && (
              <div className="flex items-center gap-2 px-1 py-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                <span className="text-sm text-gray-500">考えています...</span>
              </div>
            )}
          </div>

          {/* 最新の問い：1問ずつカードにして、その下に入力欄を置く */}
          {!loading && questions.length > 0 && (
            <div className="space-y-3">
              {parsed?.intro && (
                <p className="px-1 text-sm leading-relaxed whitespace-pre-wrap text-gray-600">
                  {parsed.intro}
                </p>
              )}
              {questions.map((q) => {
                const isSkipped = !!skipped[q.label];
                return (
                  <div
                    key={q.label}
                    className={`rounded-2xl border bg-white p-4 shadow-sm transition ${
                      isSkipped ? "border-gray-200 opacity-60" : "border-indigo-200"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 rounded-md bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-700">
                        {q.label}
                      </span>
                      <p className="text-sm font-semibold leading-relaxed text-gray-900">
                        {q.heading}
                      </p>
                    </div>
                    {q.body && (
                      <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-gray-500">
                        {q.body}
                      </p>
                    )}
                    <textarea
                      value={answers[q.label] ?? ""}
                      onChange={(e) =>
                        setAnswers((prev) => ({ ...prev, [q.label]: e.target.value }))
                      }
                      rows={3}
                      disabled={isSkipped}
                      placeholder="ここに答える（箇条書き・音声入力そのままでOK）"
                      className="mt-3 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-gray-50 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setSkipped((prev) => ({ ...prev, [q.label]: !prev[q.label] }))
                      }
                      className="mt-2 text-xs font-medium text-gray-500 active:opacity-70"
                    >
                      {isSkipped ? "↩︎ やっぱり答える" : "この問いはスキップ"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
            {questions.length > 0 && (
              <label className="mb-1 block px-1 text-xs font-medium text-gray-500">
                補足（任意・問い以外に伝えたいこと）
              </label>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={questions.length > 0 ? 2 : 3}
              placeholder={
                questions.length > 0 ? "例: 8月頭に西山さんと会う予定あり" : "質問に答える"
              }
              disabled={loading}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={send}
                disabled={loading || !canSend}
                className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
              >
                {questions.length > 0 ? "回答を送る" : "送信"}
              </button>
              <button
                type="button"
                onClick={saveMatured}
                disabled={saving || loading || messages.length === 0}
                className="flex-1 rounded-xl bg-purple-600 px-4 py-2.5 text-base font-semibold text-white transition active:bg-purple-700 disabled:opacity-40"
              >
                {saving ? "熟成中..." : "熟成して登録"}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
          {saved && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
              ✅「{saved}」を成果物として登録しました。次回の提案の土台になります。
            </p>
          )}
        </div>
      )}

      {/* 過去の壁打ち */}
      {!sessionId && sessions.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 px-1 text-sm font-semibold text-gray-500">過去の壁打ち</h2>
          <div className="space-y-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => resume(s)}
                className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm active:bg-gray-50"
              >
                <span className="text-sm font-medium text-gray-800">
                  {s.organization}
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {s.category}
                </span>
                <span className="truncate text-xs text-gray-400">{s.title ?? ""}</span>
                <span className="ml-auto shrink-0 text-xs text-indigo-600">続きから →</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}

export default function RefinePage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}>
      <RefineInner />
    </Suspense>
  );
}
