"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import StakeholderPicker, { type Category } from "@/app/components/StakeholderPicker";
import { composeReply, parseQuestions, stripBold } from "@/lib/parseQuestions";

// スライド壁打ち。/refine（対象との関係の熟成）のスライド版。
// お題（このスライドで伝えたいこと）を軸に、目的・聞き手・ゴールを深掘り →
// スライド構成案 → 簡易ビジュアル → 成果物として記憶に登録、という一本の流れ。

type Msg = { role: "user" | "assistant"; content: string };
type Slide = { title: string; bullets: string[] };
type Visual = { diagramType: string; description: string; svg: string };
type Session = {
  id: string;
  theme: string;
  organization: string | null;
  category: string | null;
  title: string | null;
  updated_at: string;
};
type Stage = "form" | "chat" | "outline" | "visualize";

// AI生成のSVGはユーザー向けに描画される未検証の文字列なので、自前のクライアントとはいえ
// 信用しきらずに軽く消毒する（多層防御。生成時点の縛りだけに頼らない）。
function sanitizeSvg(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<svg")) return null;
  let s = trimmed;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  s = s.replace(/<image\b[^>]*>/gi, "");
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/javascript:/gi, "");
  return s;
}

function SvgPreview({ svg }: { svg: string }) {
  const safe = sanitizeSvg(svg);
  if (!safe) {
    return (
      <p className="rounded-lg bg-gray-50 px-3 py-4 text-center text-xs text-gray-400">
        プレビューを表示できませんでした
      </p>
    );
  }
  return (
    <div
      className="[&>svg]:mx-auto [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-full"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

function SlideRefineInner() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [theme, setTheme] = useState("");
  const [linkTarget, setLinkTarget] = useState(false);
  const [category, setCategory] = useState<Category>("自治体");
  const [organization, setOrganization] = useState("");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("form");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [slides, setSlides] = useState<Slide[]>([]);
  const [visuals, setVisuals] = useState<Visual[]>([]);

  const [loading, setLoading] = useState(false);
  const [outlining, setOutlining] = useState(false);
  const [visualizing, setVisualizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/slide-refine", { cache: "no-store" });
      const d = await r.json();
      setSessions(Array.isArray(d?.sessions) ? d.sessions : []);
    } catch {
      // 一覧が取れなくても壁打ちはできる
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  function resetToForm() {
    setSessionId(null);
    setStage("form");
    setMessages([]);
    setAnswers({});
    setSkipped({});
    setSlides([]);
    setVisuals([]);
    setSaved(null);
    setError(null);
  }

  async function start() {
    if (!theme.trim()) return setError("このスライドで伝えたいこと・お題を入力してください");
    if (linkTarget && !organization.trim()) return setError(`${category}名を選んでください`);
    setError(null);
    setSaved(null);
    setLoading(true);
    try {
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          theme: theme.trim(),
          organization: linkTarget ? organization.trim() : undefined,
          category: linkTarget ? category : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "開始に失敗しました");
      setSessionId(d.sessionId);
      setMessages(d.messages ?? []);
      setStage("chat");
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
      const r = await fetch(`/api/slide-refine?sessionId=${s.id}`, { cache: "no-store" });
      const d = await r.json();
      setSessionId(s.id);
      setTheme(s.theme);
      if (s.organization) {
        setLinkTarget(true);
        setOrganization(s.organization);
        setCategory((s.category as Category) ?? "自治体");
      } else {
        setLinkTarget(false);
        setOrganization("");
      }
      setMessages(Array.isArray(d?.messages) ? d.messages : []);
      const loadedSlides: Slide[] = Array.isArray(d?.slides) ? d.slides : [];
      const loadedVisuals: Visual[] = Array.isArray(d?.visuals) ? d.visuals : [];
      setSlides(loadedSlides);
      setVisuals(loadedVisuals);
      if (loadedVisuals.length > 0) setStage("visualize");
      else if (loadedSlides.length > 0) setStage("outline");
      else setStage("chat");
    } catch {
      setError("読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!sessionId) return;
    const msg = questions.length > 0 ? composeReply(questions, answers, skipped, input) : input.trim();
    if (!msg || !canSend) return;
    setError(null);
    setSaved(null);
    setInput("");
    setAnswers({});
    setSkipped({});
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);
    try {
      const r = await fetch("/api/slide-refine", {
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

  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  const lastAssistant = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : null;
  const parsed = lastAssistant ? parseQuestions(lastAssistant.content) : null;
  const questions = parsed?.questions ?? [];
  const hasAssistantTurn = messages.some((m) => m.role === "assistant");

  const canSend =
    questions.length > 0
      ? questions.some((q) => (answers[q.label] ?? "").trim() || skipped[q.label]) || !!input.trim()
      : !!input.trim();

  async function goOutline() {
    if (!sessionId) return;
    setError(null);
    setOutlining(true);
    try {
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "outline", sessionId }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "構成案の生成に失敗しました");
      setSlides(Array.isArray(d.slides) ? d.slides : []);
      setStage("outline");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setOutlining(false);
    }
  }

  function updateSlide(i: number, patch: Partial<Slide>) {
    setSlides((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function goVisualize() {
    if (!sessionId) return;
    setError(null);
    setVisualizing(true);
    try {
      const cleanedSlides = slides.map((s) => ({
        title: s.title,
        bullets: s.bullets.map((b) => b.trim()).filter(Boolean),
      }));
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "visualize", sessionId, slides: cleanedSlides }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "図式化に失敗しました");
      setSlides(cleanedSlides);
      setVisuals(Array.isArray(d.visuals) ? d.visuals : []);
      setStage("visualize");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setVisualizing(false);
    }
  }

  async function saveFinal() {
    if (!sessionId) return;
    setError(null);
    setSaving(true);
    try {
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", sessionId }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "登録に失敗しました");
      setSaved(d.title ?? "スライド資料");
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
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">スライド壁打ち</h1>
        <p className="mt-1 text-sm text-gray-500">
          目的・聞き手・ゴールをAIが深掘り。答えるほど構成が固まり、スライド構成案と簡易ビジュアルまで作ります
        </p>
      </header>

      {/* Stage 1: お題入力 */}
      {stage === "form" && (
        <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div>
            <label className="block text-sm font-medium text-gray-600">
              このスライドで伝えたいこと・お題
            </label>
            <textarea
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              rows={3}
              disabled={loading}
              placeholder="例: 無償トライアルの効果を事務センターの係長に伝え、本導入の稟議を上げてもらいたい"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>

          <button
            type="button"
            onClick={() => setLinkTarget((v) => !v)}
            disabled={loading}
            className="flex w-full items-center gap-2 text-left disabled:opacity-50"
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
                linkTarget ? "border-indigo-500 bg-indigo-500 text-white" : "border-gray-300 text-transparent"
              }`}
            >
              ✓
            </span>
            <span className="text-sm font-medium text-gray-600">特定の対象に紐付ける</span>
          </button>

          {linkTarget && (
            <StakeholderPicker
              category={category}
              onCategoryChange={setCategory}
              name={organization}
              onNameChange={setOrganization}
              disabled={loading}
            />
          )}

          <button
            type="button"
            onClick={start}
            disabled={loading}
            className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
          >
            {loading ? "準備しています..." : "壁打ちを始める"}
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>
      )}

      {/* ヘッダー帯（対象・お題・戻る） */}
      {stage !== "form" && (
        <div className="mb-4 flex items-center gap-2">
          <span className="min-w-0 truncate rounded-full bg-indigo-100 px-3 py-1 text-sm font-semibold text-indigo-700">
            {organization ? `${organization}（${category}）` : theme}
          </span>
          <button
            type="button"
            onClick={resetToForm}
            className="ml-auto shrink-0 text-sm font-medium text-gray-500 active:opacity-70"
          >
            最初からやり直す
          </button>
        </div>
      )}

      {/* Stage 2: 面談チャット */}
      {stage === "chat" && (
        <div className="space-y-4">
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

          {!loading && questions.length > 0 && (
            <div className="space-y-3">
              {parsed?.intro && (
                <p className="px-1 text-sm leading-relaxed whitespace-pre-wrap text-gray-600">{parsed.intro}</p>
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
                      <p className="text-sm font-semibold leading-relaxed text-gray-900">{q.heading}</p>
                    </div>
                    {q.body && (
                      <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-gray-500">{q.body}</p>
                    )}
                    <textarea
                      value={answers[q.label] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.label]: e.target.value }))}
                      rows={3}
                      disabled={isSkipped}
                      placeholder="ここに答える（箇条書き・音声入力そのままでOK）"
                      className="mt-3 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-gray-50 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setSkipped((prev) => ({ ...prev, [q.label]: !prev[q.label] }))}
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
              placeholder={questions.length > 0 ? "例: 相手は数字より事例で刺さるタイプ" : "質問に答える"}
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
                onClick={goOutline}
                disabled={outlining || loading || !hasAssistantTurn}
                className="flex-1 rounded-xl bg-purple-600 px-4 py-2.5 text-base font-semibold text-white transition active:bg-purple-700 disabled:opacity-40"
              >
                {outlining ? "構成案を作成中..." : "もう構成案を作る"}
              </button>
            </div>
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>
      )}

      {/* Stage 3: スライド構成案（編集可） */}
      {stage === "outline" && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400">
            見出し・要点は直接書き換えられます。要点は1行1項目です。おかしいところがあれば修正してください。
          </p>
          <div className="space-y-3">
            {slides.map((s, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded-md bg-purple-100 px-2 py-0.5 text-xs font-bold text-purple-700">
                    {i + 1}枚目
                  </span>
                  <input
                    type="text"
                    value={s.title}
                    onChange={(e) => updateSlide(i, { title: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-1 text-sm font-bold text-gray-900 transition focus:border-purple-300 focus:bg-purple-50 focus:outline-none"
                  />
                </div>
                <textarea
                  value={s.bullets.join("\n")}
                  onChange={(e) => updateSlide(i, { bullets: e.target.value.split("\n") })}
                  rows={Math.max(3, s.bullets.length)}
                  placeholder="要点を1行ずつ"
                  className="mt-2 block w-full resize-y rounded-lg border border-transparent px-2 py-1.5 text-sm leading-relaxed text-gray-700 transition focus:border-purple-300 focus:bg-purple-50 focus:outline-none"
                />
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={goVisualize}
            disabled={visualizing || slides.length === 0}
            className="w-full rounded-xl bg-purple-600 px-4 py-3 text-base font-semibold text-white transition active:bg-purple-700 disabled:opacity-40"
          >
            {visualizing ? "図式化しています..." : "図式化する"}
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>
      )}

      {/* Stage 4: 簡易ビジュアルプレビュー */}
      {stage === "visualize" && (
        <div className="space-y-4">
          <div className="space-y-3">
            {visuals.map((v, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                    {i + 1}枚目
                  </span>
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700">
                    {v.diagramType}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-gray-700">{v.description}</p>
                <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <SvgPreview svg={v.svg} />
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <button
              type="button"
              onClick={saveFinal}
              disabled={saving || visuals.length === 0}
              className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
            >
              {saving ? "登録中..." : "確定して登録"}
            </button>
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {saved && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
              ✅「{saved}」を成果物として登録しました。次回の提案の土台になります。
            </p>
          )}
        </div>
      )}

      {/* 過去のスライド壁打ち */}
      {stage === "form" && sessions.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 px-1 text-sm font-semibold text-gray-500">過去のスライド壁打ち</h2>
          <div className="space-y-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => resume(s)}
                className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm active:bg-gray-50"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                  {s.title ?? s.theme}
                </span>
                {s.organization && (
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                    {s.organization}
                  </span>
                )}
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

export default function SlideRefinePage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}>
      <SlideRefineInner />
    </Suspense>
  );
}
