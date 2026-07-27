"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import StakeholderPicker, { type Category } from "@/app/components/StakeholderPicker";
import { composeReply, parseQuestions, stripBold } from "@/lib/parseQuestions";

// スライド壁打ち。/refine（対象との関係の熟成）のスライド版。
// お題（このスライドで伝えたいこと）を軸に、目的・聞き手・ゴールを深掘り →
// スライド構成案 → 簡易ビジュアル → 成果物として記憶に登録、という一本の流れ。

type Msg = { role: "user" | "assistant"; content: string };
type Slide = { section: "結論" | "根拠" | "アクション"; title: string; bullets: string[] };
type VisualCandidate = { diagramType: string; description: string };
type Visual = { diagramType: string; description: string; svg: string };
type Session = {
  id: string;
  theme: string;
  organization: string | null;
  category: string | null;
  title: string | null;
  purpose: string | null;
  updated_at: string;
};
type Stage = "form" | "chat" | "outline" | "diagrams" | "visualize";

// 壁打ちの目的：StakeholderPickerと同じ「カテゴリー選択 + その他は直接入力」パターン。
// ただしこちらは育っていくマスタが無いのでローカルのプリセットで十分（DBには保存しない）。
const PURPOSE_PRESETS = [
  "予算獲得・本導入決裁",
  "新規開拓・提案",
  "進捗報告・共有",
  "社内稟議・承認",
  "契約更新・アップセル",
  "その他",
] as const;

const SECTION_BADGE_CLASS: Record<Slide["section"], string> = {
  結論: "bg-amber-100 text-amber-700",
  根拠: "bg-sky-100 text-sky-700",
  アクション: "bg-emerald-100 text-emerald-700",
};

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
  const [purposeCategory, setPurposeCategory] = useState<string>(PURPOSE_PRESETS[0]);
  const [purposeCustom, setPurposeCustom] = useState("");
  const [linkTarget, setLinkTarget] = useState(false);
  const [category, setCategory] = useState<Category>("自治体");
  const [organization, setOrganization] = useState("");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("form");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [slideCountInput, setSlideCountInput] = useState("");
  const [slides, setSlides] = useState<Slide[]>([]);
  const [candidates, setCandidates] = useState<VisualCandidate[][]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [visuals, setVisuals] = useState<Visual[]>([]);
  const [deletedSlides, setDeletedSlides] = useState<Record<number, boolean>>({});
  const [editingSlide, setEditingSlide] = useState<Record<number, boolean>>({});
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [outlining, setOutlining] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // その他が選ばれていれば自由記述、それ以外はプリセットのラベルそのものがpurpose文字列になる。
  const purpose = purposeCategory === "その他" ? purposeCustom.trim() : purposeCategory;

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
    setSlideCountInput("");
    setSlides([]);
    setCandidates([]);
    setSelected([]);
    setVisuals([]);
    setDeletedSlides({});
    setEditingSlide({});
    setSaved(null);
    setError(null);
  }

  async function start() {
    if (!theme.trim()) return setError("このスライドで伝えたいこと・お題を入力してください");
    if (!purpose) return setError("壁打ちの目的を入力してください");
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
          purpose,
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
      const loadedPurpose: string | null = d?.purpose ?? s.purpose ?? null;
      if (loadedPurpose && (PURPOSE_PRESETS as readonly string[]).includes(loadedPurpose)) {
        setPurposeCategory(loadedPurpose);
        setPurposeCustom("");
      } else if (loadedPurpose) {
        setPurposeCategory("その他");
        setPurposeCustom(loadedPurpose);
      } else {
        setPurposeCategory(PURPOSE_PRESETS[0]);
        setPurposeCustom("");
      }
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
      const loadedCandidates: VisualCandidate[][] = Array.isArray(d?.visual_candidates)
        ? d.visual_candidates
        : [];
      const loadedVisuals: Visual[] = Array.isArray(d?.visuals) ? d.visuals : [];
      setSlides(loadedSlides);
      setCandidates(loadedCandidates);
      setSelected(loadedCandidates.map(() => 0));
      setVisuals(loadedVisuals);
      if (loadedVisuals.length > 0) setStage("visualize");
      else if (loadedCandidates.length > 0) setStage("diagrams");
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
      const n = parseInt(slideCountInput, 10);
      const slideCount = slideCountInput.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "outline", sessionId, slideCount }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "構成案の生成に失敗しました");
      setSlides(Array.isArray(d.slides) ? d.slides : []);
      setDeletedSlides({});
      setEditingSlide({});
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

  // Step A: (編集済みの可能性がある)構成案から、スライドごとに2〜3個の図解パターン候補を提案してもらう。
  async function goProposeVisuals() {
    if (!sessionId) return;
    setError(null);
    setProposing(true);
    try {
      const cleanedSlides = slides.map((s) => ({
        section: s.section,
        title: s.title,
        bullets: s.bullets.map((b) => b.trim()).filter(Boolean),
      }));
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "propose-visuals", sessionId, slides: cleanedSlides }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "図解候補の生成に失敗しました");
      setSlides(cleanedSlides);
      const cands: VisualCandidate[][] = Array.isArray(d.candidates) ? d.candidates : [];
      setCandidates(cands);
      setSelected(cands.map(() => 0));
      setStage("diagrams");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setProposing(false);
    }
  }

  // Step C: 吉井さんがスライドごとに選んだ図解候補だけを、実際のSVGとして描画してもらう。
  async function goRenderVisuals() {
    if (!sessionId) return;
    setError(null);
    setRendering(true);
    try {
      const choices = slides.map((_, i) => {
        const list = candidates[i] ?? [];
        const idx = selected[i] ?? 0;
        return list[idx] ?? list[0] ?? { diagramType: "", description: "" };
      });
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "render-visuals", sessionId, choices }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "図解の生成に失敗しました");
      setVisuals(Array.isArray(d.visuals) ? d.visuals : []);
      setDeletedSlides({});
      setEditingSlide({});
      setStage("visualize");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setRendering(false);
    }
  }

  // 納得いかない1枚だけ、内容とビジュアルを両方作り直す。
  async function regenerateSlide(i: number) {
    if (!sessionId) return;
    setError(null);
    setRegeneratingIndex(i);
    try {
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "regenerate-slide",
          sessionId,
          slide: slides[i],
          visual: visuals[i]
            ? { diagramType: visuals[i].diagramType, description: visuals[i].description }
            : undefined,
          slides,
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "作り直しに失敗しました");
      setSlides((prev) => prev.map((s, idx) => (idx === i ? d.slide : s)));
      setVisuals((prev) => prev.map((v, idx) => (idx === i ? d.visual : v)));
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setRegeneratingIndex(null);
    }
  }

  function toggleDeleted(i: number) {
    setDeletedSlides((prev) => ({ ...prev, [i]: !prev[i] }));
  }

  function toggleEditing(i: number) {
    setEditingSlide((prev) => ({ ...prev, [i]: !prev[i] }));
  }

  const keptIndices = slides.map((_, i) => i).filter((i) => !deletedSlides[i]);

  async function saveFinal() {
    if (!sessionId) return;
    if (keptIndices.length === 0) return setError("すべて削除されています。少なくとも1枚は残してください");
    setError(null);
    setSaving(true);
    try {
      const finalSlides = keptIndices.map((i) => slides[i]);
      const finalVisuals = keptIndices.map((i) => visuals[i]);
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", sessionId, slides: finalSlides, visuals: finalVisuals }),
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

          <div>
            <label className="block text-sm font-medium text-gray-600">
              作成するスライド枚数（任意）
            </label>
            <input
              type="number"
              min={1}
              max={30}
              value={slideCountInput}
              onChange={(e) => setSlideCountInput(e.target.value)}
              disabled={loading}
              placeholder="未入力ならAIにお任せ（5〜10枚程度）"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-600">壁打ちの目的</label>
            <select
              value={purposeCategory}
              onChange={(e) => {
                setPurposeCategory(e.target.value);
                if (e.target.value !== "その他") setPurposeCustom("");
              }}
              disabled={loading}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            >
              {PURPOSE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {purposeCategory === "その他" && (
              <input
                type="text"
                value={purposeCustom}
                onChange={(e) => setPurposeCustom(e.target.value)}
                disabled={loading}
                placeholder="目的を入力してください"
                className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
              />
            )}
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

      {/* ヘッダー帯（対象・お題・目的・戻る） */}
      {stage !== "form" && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate rounded-full bg-indigo-100 px-3 py-1 text-sm font-semibold text-indigo-700">
            {organization ? `${organization}（${category}）` : theme}
          </span>
          {purpose && (
            <span className="min-w-0 truncate rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700">
              {purpose}
            </span>
          )}
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
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${SECTION_BADGE_CLASS[s.section]}`}
                  >
                    {s.section}
                  </span>
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
            onClick={goProposeVisuals}
            disabled={proposing || slides.length === 0}
            className="w-full rounded-xl bg-purple-600 px-4 py-3 text-base font-semibold text-white transition active:bg-purple-700 disabled:opacity-40"
          >
            {proposing ? "図解候補を考えています..." : "図式化する"}
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>
      )}

      {/* Stage 3.5: 図解パターン候補から選ぶ（スライドごとに1個・単一選択） */}
      {stage === "diagrams" && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400">
            各スライドの図解パターンを選んでください。迷ったら最初の候補のままで大丈夫です（未選択のスライドは先頭候補のまま進みます）。
          </p>
          <div className="space-y-4">
            {slides.map((s, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${SECTION_BADGE_CLASS[s.section]}`}
                  >
                    {s.section}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900">
                    {i + 1}枚目 {s.title}
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {(candidates[i] ?? []).map((c, ci) => {
                    const isChosen = (selected[i] ?? 0) === ci;
                    return (
                      <button
                        key={ci}
                        type="button"
                        onClick={() =>
                          setSelected((prev) => prev.map((v, idx) => (idx === i ? ci : v)))
                        }
                        className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                          isChosen ? "border-purple-400 bg-purple-50" : "border-gray-200 bg-white active:bg-gray-50"
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
                            isChosen ? "border-purple-500 bg-purple-500 text-white" : "border-gray-300 text-transparent"
                          }`}
                        >
                          ✓
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
                            {c.diagramType}
                          </span>
                          <span className="mt-1 block text-sm leading-relaxed text-gray-700">{c.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={goRenderVisuals}
            disabled={rendering || slides.length === 0}
            className="w-full rounded-xl bg-purple-600 px-4 py-3 text-base font-semibold text-white transition active:bg-purple-700 disabled:opacity-40"
          >
            {rendering ? "図解を生成しています..." : "この図解で作る"}
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>
      )}

      {/* Stage 4: 簡易ビジュアルプレビュー */}
      {stage === "visualize" && (
        <div className="space-y-4">
          {!saved && (
            <p className="text-xs text-gray-400">
              スライドごとに「編集する」「作り直す」「削除」を選べます。削除したスライドは登録対象から外れます。
            </p>
          )}
          <div className="space-y-3">
            {visuals.map((v, i) => {
              const s = slides[i];
              const isDeleted = !!deletedSlides[i];
              const isEditing = !!editingSlide[i];
              const isRegenerating = regeneratingIndex === i;

              if (isDeleted) {
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 p-4 opacity-60"
                  >
                    <span className="shrink-0 rounded-md bg-gray-200 px-2 py-0.5 text-xs font-bold text-gray-500">
                      {i + 1}枚目
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-500 line-through">
                      {s?.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleDeleted(i)}
                      disabled={!!saved}
                      className="shrink-0 text-xs font-medium text-indigo-600 active:opacity-70 disabled:opacity-40"
                    >
                      ↩︎ 元に戻す
                    </button>
                  </div>
                );
              }

              return (
                <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-2">
                    {s && (
                      <span
                        className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${SECTION_BADGE_CLASS[s.section]}`}
                      >
                        {s.section}
                      </span>
                    )}
                    <span className="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                      {i + 1}枚目
                    </span>
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700">
                      {v.diagramType}
                    </span>
                  </div>

                  {s && isEditing ? (
                    <div className="mt-2 space-y-2">
                      <input
                        type="text"
                        value={s.title}
                        onChange={(e) => updateSlide(i, { title: e.target.value })}
                        className="block w-full rounded-md border border-purple-300 bg-purple-50 px-2 py-1.5 text-sm font-bold text-gray-900 focus:outline-none"
                      />
                      <textarea
                        value={s.bullets.join("\n")}
                        onChange={(e) => updateSlide(i, { bullets: e.target.value.split("\n") })}
                        rows={Math.max(3, s.bullets.length)}
                        placeholder="要点を1行ずつ"
                        className="block w-full resize-y rounded-md border border-purple-300 bg-purple-50 px-2 py-1.5 text-sm leading-relaxed text-gray-700 focus:outline-none"
                      />
                    </div>
                  ) : (
                    s && (
                      <div className="mt-2">
                        <p className="text-sm font-bold text-gray-900">{s.title}</p>
                        <ul className="mt-1 space-y-0.5">
                          {s.bullets.map((b, bi) => (
                            <li key={bi} className="flex gap-2 text-sm leading-relaxed text-gray-700">
                              <span className="text-gray-300">・</span>
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  )}

                  <p className="mt-3 text-xs leading-relaxed text-gray-500">{v.description}</p>
                  <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                    <SvgPreview svg={v.svg} />
                  </div>

                  {!saved && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => toggleEditing(i)}
                        disabled={isRegenerating}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 active:bg-gray-50 disabled:opacity-40"
                      >
                        {isEditing ? "編集を終える" : "✏️ 編集する"}
                      </button>
                      <button
                        type="button"
                        onClick={() => regenerateSlide(i)}
                        disabled={isRegenerating}
                        className="rounded-lg border border-purple-200 px-3 py-1.5 text-xs font-medium text-purple-700 active:bg-purple-50 disabled:opacity-40"
                      >
                        {isRegenerating ? "作り直し中..." : "🔄 作り直す"}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleDeleted(i)}
                        disabled={isRegenerating}
                        className="ml-auto rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 active:bg-red-50 disabled:opacity-40"
                      >
                        🗑 削除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!saved ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <button
                type="button"
                onClick={saveFinal}
                disabled={saving || keptIndices.length === 0}
                className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
              >
                {saving
                  ? "登録中..."
                  : `この${keptIndices.length}枚を確定して登録`}
              </button>
              {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center shadow-sm">
              <p className="text-2xl">✅</p>
              <p className="mt-2 text-base font-bold text-emerald-900">この壁打ちは完了です</p>
              <p className="mt-1 text-sm leading-relaxed text-emerald-800">
                「{saved}」として成果物に登録しました。
                {organization ? `${organization}向けの` : ""}
                次回の提案・壁打ちの土台になります。
              </p>
              <p className="mt-2 text-xs leading-relaxed text-emerald-700">
                ※ .pptx化は今回のスコープ外です。構成案とビジュアル方針の確定・保存までで、この壁打ちは終わりです。
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={resetToForm}
                  className="flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition active:bg-emerald-700"
                >
                  新しい壁打ちを始める
                </button>
                <Link
                  href="/"
                  className="flex-1 rounded-xl border border-emerald-300 bg-white px-4 py-2.5 text-center text-sm font-semibold text-emerald-700 active:bg-emerald-50"
                >
                  ホームに戻る
                </Link>
              </div>
            </div>
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
