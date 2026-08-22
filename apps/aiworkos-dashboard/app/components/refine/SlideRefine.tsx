"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import StakeholderPicker, { type Category } from "@/app/components/StakeholderPicker";
import DocUpload from "@/app/components/refine/DocUpload";
import { composeReply, parseQuestions, stripBold } from "@/lib/parseQuestions";
import { SLIDE_TEMPLATES, findTemplate, sectionBadgeClass } from "@/lib/slideTemplates";

// スライド壁打ち。統合入口 /refine?mode=slide の「🎯 スライド」モードの本体
// （旧 app/slide-refine/page.tsx の中身を移した。旧URLはリダイレクトとして残っている）。
// お題（このスライドで伝えたいこと）を軸に、目的・聞き手・ゴールを深掘り →
// スライド構成案 → 簡易ビジュアル → 成果物として記憶に登録、という一本の流れ。

type Msg = { role: "user" | "assistant"; content: string };
// sectionは選んだテンプレート(lib/slideTemplates.ts)のセクション名のいずれか（テンプレートごとに変わる）。
type Slide = { section: string; title: string; bullets: string[] };
type VisualCandidate = { diagramType: string; description: string };
type Visual = { diagramType: string; description: string; svg: string };
type Session = {
  id: string;
  theme: string;
  organization: string | null;
  category: string | null;
  title: string | null;
  purpose: string | null;
  template_id: string | null;
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

// 文言だけをLLM無しで直接書き換える（「ここを直す」はAI任せで別の誤りを生むことがあるため、
// 用語1つを直すような単純な修正はここで確実・即時・無料に済ませる）。
//
// <text>が<tspan>で複数行に分かれているケース（例:
// <text><tspan>1行目</tspan><tspan>2行目</tspan></text>）で、
// 親<text>のtextContentをそのまま上書きすると複数のtspanが1本のテキストに潰れて
// レイアウトが壊れる。tspanがあればtspan単位を編集対象にし、無い<text>だけを
// テキストノード単位で扱う。pathは[textIndex]または[textIndex, tspanIndex]。
type SvgTextEntry = { path: [number] | [number, number]; value: string };

function getSvgTextEntries(svg: string): SvgTextEntry[] {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.querySelector("parsererror")) return [];
    const entries: SvgTextEntry[] = [];
    Array.from(doc.querySelectorAll("text")).forEach((t, ti) => {
      const tspans = Array.from(t.querySelectorAll("tspan"));
      if (tspans.length > 0) {
        tspans.forEach((ts, tsi) => entries.push({ path: [ti, tsi], value: ts.textContent ?? "" }));
      } else {
        entries.push({ path: [ti], value: t.textContent ?? "" });
      }
    });
    return entries;
  } catch {
    return [];
  }
}

function setSvgTextEntry(svg: string, path: [number] | [number, number], value: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.querySelector("parsererror")) return svg;
    const texts = doc.querySelectorAll("text");
    const t = texts[path[0]];
    if (!t) return svg;
    if (path.length === 2) {
      const tspans = t.querySelectorAll("tspan");
      const ts = tspans[path[1]];
      if (!ts) return svg;
      ts.textContent = value;
    } else {
      t.textContent = value;
    }
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return svg;
  }
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

export default function SlideRefine() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [theme, setTheme] = useState("");
  const [purposeCategory, setPurposeCategory] = useState<string>(PURPOSE_PRESETS[0]);
  const [purposeCustom, setPurposeCustom] = useState("");
  const [templateId, setTemplateId] = useState<string>(SLIDE_TEMPLATES[0].id);
  const [linkTarget, setLinkTarget] = useState(false);
  const [category, setCategory] = useState<Category>("自治体");
  const [organization, setOrganization] = useState("");
  // ⑤ 既存スライドから始める: 過去に作ったスライド構成（と任意で台本）を登録し、
  // 「改善・完成」を目的とした壁打ちの土台にする。どちらか片方だけでも始められる
  // （あるものだけ登録する、が要件）。
  const [useBase, setUseBase] = useState(false);
  const [baseSlides, setBaseSlides] = useState("");
  const [baseScript, setBaseScript] = useState("");

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
  const [fixingSlide, setFixingSlide] = useState<Record<number, boolean>>({});
  const [fixInstructions, setFixInstructions] = useState<Record<number, string>>({});
  const [fixBusyIndex, setFixBusyIndex] = useState<number | null>(null);
  const [retracting, setRetracting] = useState(false);
  const [textEditIndex, setTextEditIndex] = useState<number | null>(null);
  const [queuedPptx, setQueuedPptx] = useState(false);
  const [orderingPptx, setOrderingPptx] = useState(false);

  const [loading, setLoading] = useState(false);
  const [outlining, setOutlining] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // その他が選ばれていれば自由記述、それ以外はプリセットのラベルそのものがpurpose文字列になる。
  const purpose = purposeCategory === "その他" ? purposeCustom.trim() : purposeCategory;
  const template = findTemplate(templateId);

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

  // ステージが切り替わるたびに前のスクロール位置が残ってしまい、短いビューポートだと
  // 新しいステージの先頭が画面外になって「上半分が空白」に見える不具合があった。
  // ステージ変更のたびに先頭へ戻す。
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stage]);

  function resetToForm() {
    // 登録前の成果（チャット・構成案・図解）が1つでもあるうちは、確認なしで破棄しない。
    // 登録済み（saved）からの「新しい壁打ちを始める」は成果が保存済みなので確認不要。
    const hasUnsaved =
      !saved && (messages.length > 0 || slides.length > 0 || visuals.length > 0);
    if (hasUnsaved && !window.confirm("作り直した内容は保存されていません。破棄しますか？")) {
      return;
    }
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
    setFixingSlide({});
    setFixInstructions({});
    setTextEditIndex(null);
    setQueuedPptx(false);
    setSaved(null);
    setError(null);
    setInput("");
    // 入力系も初期値へ戻す。残したまま次の壁打ちに入ると、前回の団体・目的・
    // 既存スライド（元資料）が黙って引き継がれる（A市の資料を土台にB市の文書が作られる事故）。
    setTheme("");
    setPurposeCategory(PURPOSE_PRESETS[0]);
    setPurposeCustom("");
    setTemplateId(SLIDE_TEMPLATES[0].id);
    setLinkTarget(false);
    setCategory("自治体");
    setOrganization("");
    setUseBase(false);
    setBaseSlides("");
    setBaseScript("");
  }

  async function start() {
    if (!theme.trim()) return setError("このスライドで伝えたいこと・お題を入力してください");
    if (!purpose) return setError("壁打ちの目的を入力してください");
    if (linkTarget && !organization.trim()) return setError(`${category}名を選んでください`);
    // 両方必須にはしないが、チェックだけ入れて中身が空だと土台が何も無いので止める。
    if (useBase && !baseSlides.trim() && !baseScript.trim())
      return setError("既存スライドの構成か台本の、どちらかは貼り付けてください");
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
          templateId,
          organization: linkTarget ? organization.trim() : undefined,
          category: linkTarget ? category : undefined,
          baseSlides: useBase && baseSlides.trim() ? baseSlides.trim() : undefined,
          baseScript: useBase && baseScript.trim() ? baseScript.trim() : undefined,
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
      setTemplateId(findTemplate(d?.templateId ?? s.template_id).id);
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
      setDeletedSlides({});
      setEditingSlide({});
      setFixingSlide({});
      setFixInstructions({});
      setTextEditIndex(null);
      // 過去に「確定して登録」済みのセッションを開いた場合、完了パネルから再開する
      // （titleは登録時にだけ付くので、これが有れば既に登録済みという判定にできる）。
      if (loadedVisuals.length > 0 && s.title) setSaved(s.title);
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
      // diagramType/descriptionだけでなく本文(title/bullets)も一緒に渡す。
      // これが無いとSVG生成時にAIが文言・数値・年月を独自に埋めてしまう（事実誤りの原因）。
      const choices = slides.map((s, i) => {
        const list = candidates[i] ?? [];
        const idx = selected[i] ?? 0;
        const c = list[idx] ?? list[0] ?? { diagramType: "", description: "" };
        return { ...c, slide: s };
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

  function toggleFixing(i: number) {
    setFixingSlide((prev) => ({ ...prev, [i]: !prev[i] }));
  }

  function toggleTextEdit(i: number) {
    setTextEditIndex((prev) => (prev === i ? null : i));
  }

  // 文言修正はAIを呼ばず、SVG内のテキスト（tspan単位・無ければtext単位）をその場で直接書き換える。確実・即時・無料。
  function updateVisualSvgText(i: number, path: [number] | [number, number], value: string) {
    setVisuals((prev) =>
      prev.map((v, idx) => (idx === i ? { ...v, svg: setSvgTextEntry(v.svg, path, value) } : v))
    );
  }

  // 「ここを直す」: 全面作り直しではなく、指示した箇所だけの修正をベストエフォートで依頼する。
  // 注意: SVGは毎回丸ごと再生成されるため、指示以外の箇所が完全に同一である保証はない。
  async function fixSlide(i: number) {
    if (!sessionId) return;
    const instruction = (fixInstructions[i] ?? "").trim();
    if (!instruction) return setError("修正したい内容を入力してください");
    setError(null);
    setFixBusyIndex(i);
    try {
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fix-slide",
          sessionId,
          slide: slides[i],
          visual: visuals[i],
          instruction,
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "修正に失敗しました");
      setSlides((prev) => prev.map((s, idx) => (idx === i ? d.slide : s)));
      setVisuals((prev) => prev.map((v, idx) => (idx === i ? d.visual : v)));
      setFixingSlide((prev) => ({ ...prev, [i]: false }));
      setFixInstructions((prev) => ({ ...prev, [i]: "" }));
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setFixBusyIndex(null);
    }
  }

  // 登録済みの成果物を記憶から取り消す（誤り混入時のセーフティネット）。
  async function retractSave() {
    if (!sessionId) return;
    setError(null);
    setRetracting(true);
    try {
      const r = await fetch("/api/slide-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retract", sessionId }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "取り消しに失敗しました");
      setSaved(null);
      loadSessions();
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setRetracting(false);
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

  // /weapons と同じ起票方式（kind: "slides"）に乗せる。実際の.pptx清書はMacの
  // Claude Code（integration-workerスキル・slide-architectスキル）が担う。
  // 図解(SVG)はこの起票には含まれない — 本文(タイトル・箇条書き)のみが引き継がれる。
  async function orderPptx() {
    setError(null);
    setOrderingPptx(true);
    try {
      const finalSlides = keptIndices.map((i) => ({
        title: slides[i].title,
        bullets: slides[i].bullets,
      }));
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "slides",
          params: {
            organization: organization || undefined,
            title: saved ?? theme,
            slides: finalSlides,
          },
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        return setError(d?.error ?? "起票に失敗しました");
      }
      setQueuedPptx(true);
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setOrderingPptx(false);
    }
  }

  return (
    <div>
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
            <label className="block text-sm font-medium text-gray-600">構成案の型</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={loading}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            >
              {SLIDE_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">{template.description}</p>
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

          {/* ⑤ 既存スライドから始める（ゼロから作らず、登録した構成・台本を改善する） */}
          <button
            type="button"
            onClick={() => setUseBase((v) => !v)}
            disabled={loading}
            className="flex w-full items-center gap-2 text-left disabled:opacity-50"
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
                useBase ? "border-indigo-500 bg-indigo-500 text-white" : "border-gray-300 text-transparent"
              }`}
            >
              ✓
            </span>
            <span className="text-sm font-medium text-gray-600">
              既存スライドから始める（改善・完成が目的）
            </span>
          </button>

          {useBase && (
            <div className="space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
              {/* ファイルから流し込む。貼り付けと同じ欄に入れるので、読み込んだ後に
                  手で直せる（AIに渡す前に確かめられる形にしておく）。 */}
              <DocUpload
                label="スライドのファイルから読み込む（任意）"
                hint="pptx・pdf・docx・txt。読み込むと下の「スライド構成」に流し込みます"
                disabled={loading}
                onExtracted={(text) => {
                  if (text) setBaseSlides(text);
                }}
              />
              <div>
                <label className="block text-sm font-medium text-gray-600">スライド構成</label>
                <textarea
                  value={baseSlides}
                  onChange={(e) => setBaseSlides(e.target.value)}
                  rows={6}
                  disabled={loading}
                  placeholder={
                    "1枚ごとに「タイトル＋箇条書き」で貼り付け。全文テキストのままでもOK\n例:\n1. 課題の整理\n- 窓口の待ち時間が長い\n- 職員の手作業が多い"
                  }
                  className="mt-2 block w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
                />
              </div>
              <DocUpload
                label="台本のファイルから読み込む（任意）"
                hint="docx・pdf・txt など。読み込むと下の「台本・スクリプト」に流し込みます"
                disabled={loading}
                onExtracted={(text) => {
                  if (text) setBaseScript(text);
                }}
              />
              <div>
                <label className="block text-sm font-medium text-gray-600">
                  台本・スクリプト（任意）
                </label>
                <textarea
                  value={baseScript}
                  onChange={(e) => setBaseScript(e.target.value)}
                  rows={4}
                  disabled={loading}
                  placeholder="発表時に話す内容があれば貼り付け（無ければ空欄でOK）"
                  className="mt-2 block w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
                />
              </div>
              <p className="text-xs leading-relaxed text-gray-500">
                登録した内容は壁打ちの土台になります。ゼロから作り直すのではなく、既存スライドの改善・完成を目的に深掘りします。
              </p>
            </div>
          )}

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
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
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
                      <span className="mt-0.5 shrink-0 rounded-md bg-indigo-100 px-2 py-1 text-sm font-bold text-indigo-700">
                        {q.label}
                      </span>
                      <p className="text-lg font-bold leading-relaxed text-gray-900">{q.heading}</p>
                    </div>
                    {q.body && (
                      <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-gray-700">{q.body}</p>
                    )}
                    <textarea
                      value={answers[q.label] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.label]: e.target.value }))}
                      rows={5}
                      disabled={isSkipped}
                      placeholder="ここに答える（箇条書き・音声入力そのままでOK）"
                      className="mt-3 block w-full resize-y rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-gray-50 disabled:opacity-50"
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

          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
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
                    className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${sectionBadgeClass(template, s.section)}`}
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
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
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
                    className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${sectionBadgeClass(template, s.section)}`}
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
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
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
                        className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${sectionBadgeClass(template, s.section)}`}
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

                  {!saved && textEditIndex === i && (
                    <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                      <p className="text-xs font-medium text-indigo-800">
                        図解内の文言をそのまま書き換えます（AIは使いません・即時反映）
                      </p>
                      <div className="mt-2 space-y-1.5">
                        {getSvgTextEntries(v.svg).length === 0 && (
                          <p className="text-xs text-gray-400">書き換え可能な文言が見つかりませんでした</p>
                        )}
                        {getSvgTextEntries(v.svg).map((entry) => (
                          <input
                            key={entry.path.join("-")}
                            type="text"
                            value={entry.value}
                            onChange={(e) => updateVisualSvgText(i, entry.path, e.target.value)}
                            className="block w-full rounded-md border border-indigo-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none"
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setTextEditIndex(null)}
                        className="mt-2 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700"
                      >
                        閉じる
                      </button>
                    </div>
                  )}

                  {!saved && !!fixingSlide[i] && (
                    <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 p-3">
                      <label className="block text-xs font-medium text-purple-800">
                        直したい内容を書いてください（それ以外はできる限り維持します）
                      </label>
                      <textarea
                        value={fixInstructions[i] ?? ""}
                        onChange={(e) =>
                          setFixInstructions((prev) => ({ ...prev, [i]: e.target.value }))
                        }
                        rows={2}
                        placeholder="例: SVG内の「郵便小為替」を「定額小為替」に直して"
                        className="mt-2 block w-full rounded-lg border border-purple-300 bg-white px-2.5 py-2 text-sm text-gray-900 focus:outline-none"
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => fixSlide(i)}
                          disabled={fixBusyIndex === i}
                          className="flex-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white active:bg-purple-700 disabled:opacity-40"
                        >
                          {fixBusyIndex === i ? "修正中..." : "この内容で直す"}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleFixing(i)}
                          disabled={fixBusyIndex === i}
                          className="rounded-lg border border-purple-200 bg-white px-3 py-1.5 text-xs font-medium text-purple-700 disabled:opacity-40"
                        >
                          やめる
                        </button>
                      </div>
                    </div>
                  )}

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
                        onClick={() => toggleTextEdit(i)}
                        disabled={isRegenerating}
                        className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 active:bg-indigo-50 disabled:opacity-40"
                      >
                        🔤 文言を直す
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleFixing(i)}
                        disabled={isRegenerating}
                        className="rounded-lg border border-purple-200 px-3 py-1.5 text-xs font-medium text-purple-700 active:bg-purple-50 disabled:opacity-40"
                      >
                        🩹 ここを直す
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
                        className="ml-auto rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 active:bg-rose-50 disabled:opacity-40"
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
              {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
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
              <Link
                href="/search"
                className="mt-3 inline-block text-sm font-medium text-emerald-700 underline active:opacity-70"
              >
                登録した内容を見る →
              </Link>

              <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3 text-left">
                <button
                  type="button"
                  onClick={orderPptx}
                  disabled={orderingPptx || queuedPptx}
                  className="w-full rounded-xl bg-gray-800 px-4 py-2.5 text-sm font-semibold text-white transition active:bg-gray-900 disabled:opacity-40"
                >
                  {queuedPptx
                    ? "注文しました"
                    : orderingPptx
                      ? "起票しています..."
                      : `この${keptIndices.length}枚をpptxで清書する（注文）`}
                </button>
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  本文（タイトル・箇条書き）を本物のテンプレートで清書します。図解(SVG)はこの起票には含まれません
                  — Macの実行役（Claude Code）が処理するので、次に「取込ジョブを処理して」と言うと.pptxが作られます。
                </p>
                {queuedPptx && (
                  <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    ✅ 注文を積みました。ホームのジョブ一覧で状態を確認できます。
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={retractSave}
                disabled={retracting}
                className="mt-3 text-xs font-medium text-rose-600 underline decoration-dotted active:opacity-70 disabled:opacity-40"
              >
                {retracting ? "取り消しています..." : "この登録を取り消す（記憶から削除）"}
              </button>
              {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
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

    </div>
  );
}
