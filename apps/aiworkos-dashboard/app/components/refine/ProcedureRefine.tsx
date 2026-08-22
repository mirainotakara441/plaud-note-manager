"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import StakeholderPicker, { type Category } from "@/app/components/StakeholderPicker";
import DocUpload from "@/app/components/refine/DocUpload";
import { composeReply, parseQuestions, stripBold } from "@/lib/parseQuestions";
import {
  PROCEDURE_TEMPLATES,
  findProcedureTemplate,
  hasTable,
  procedureSectionBadgeClass,
  procedureToMarkdown,
  type ProcedureItem,
} from "@/lib/procedureTemplates";

// 提出文書 壁打ち。統合入口 /refine?mode=procedure の「📋 提出文書」モードの本体
// （旧 app/procedure-refine/page.tsx の中身を移した。旧URLはリダイレクトとして残っている）。
// スライド壁打ちの文書版。
// 実施理由書・実施要領書・スキーム整理など、相手方に出して判断・合意を得る文書を扱う。
// お題（何の文書か）→ 文書の型ごとの急所の深掘り →
// 章立て案（本文＋表）→ 章ごとの手直し → 成果物として記憶に登録、という一本の流れ。
//
// スライド壁打ちと違い、生成物は文書なので図解のステージが無い。代わりに
// 「要確認事項（まだ決まっていないこと）」を画面上で潰していけるようにしている。

type Msg = { role: "user" | "assistant"; content: string };
type Session = {
  id: string;
  theme: string;
  organization: string | null;
  category: string | null;
  title: string | null;
  purpose: string | null;
  template_id: string | null;
  period: string | null;
  updated_at: string;
};
type Stage = "form" | "chat" | "draft";

// この文書を何のために出すか。スライド壁打ちの「壁打ちの目的」と同じ、ローカルのプリセット。
// 先頭は最頻出の用途（庁内の稟議・首長レクを通すための実施理由書）。
const PURPOSE_PRESETS = [
  "庁内の稟議・首長レクを通す",
  "相手方との合意形成（提示して合意を取る）",
  "現場・職員への周知",
  "契約・稟議の添付資料",
  "社内の運用ルール整備",
  "その他",
] as const;

// 表の編集は「1行目が列名、2行目以降が行、セルは | 区切り」の1枚のテキストで行う。
// スマホでもセル1つずつ触らずに直せる形を優先した。
function tableToText(item: ProcedureItem): string {
  if (!hasTable(item.table)) return "";
  const lines = [item.table.headers.join(" | ")];
  (item.table.rows ?? []).forEach((r) => lines.push(r.join(" | ")));
  return lines.join("\n");
}

function textToTable(text: string, caption: string): ProcedureItem["table"] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { caption: "", headers: [], rows: [] };
  const headers = lines[0].split("|").map((c) => c.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split("|").map((c) => c.trim());
    return headers.map((_, i) => cells[i] ?? "");
  });
  return { caption, headers, rows };
}

function TablePreview({ table }: { table: ProcedureItem["table"] }) {
  if (!hasTable(table)) return null;
  return (
    <div className="mt-3">
      {table.caption && (
        <p className="mb-1 text-sm font-semibold text-gray-600">{table.caption}</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50">
              {table.headers.map((h, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-gray-200 px-2.5 py-1.5 text-left font-semibold text-gray-700"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(table.rows ?? []).map((row, ri) => (
              <tr key={ri} className="border-b border-gray-100 last:border-0">
                {table.headers.map((_, ci) => (
                  <td key={ci} className="px-2.5 py-1.5 align-top text-gray-700">
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ProcedureRefine() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [theme, setTheme] = useState("");
  // 元になる文書（任意）。既存の実施理由書などを土台にして直す使い方。
  const [baseDoc, setBaseDoc] = useState("");
  const [baseDocName, setBaseDocName] = useState("");
  const [templateId, setTemplateId] = useState<string>(PROCEDURE_TEMPLATES[0].id);
  const [purposeCategory, setPurposeCategory] = useState<string>(PURPOSE_PRESETS[0]);
  const [purposeCustom, setPurposeCustom] = useState("");
  const [period, setPeriod] = useState("");
  const [linkTarget, setLinkTarget] = useState(false);
  const [category, setCategory] = useState<Category>("自治体");
  const [organization, setOrganization] = useState("");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("form");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});

  const [items, setItems] = useState<ProcedureItem[]>([]);
  const [openItems, setOpenItems] = useState<string[]>([]);
  const [resolvedOpen, setResolvedOpen] = useState<Record<number, boolean>>({});
  const [deleted, setDeleted] = useState<Record<number, boolean>>({});
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const [fixing, setFixing] = useState<Record<number, boolean>>({});
  const [fixInstructions, setFixInstructions] = useState<Record<number, string>>({});
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [showFullText, setShowFullText] = useState(false);
  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftProgress, setDraftProgress] = useState<{
    done: number;
    total: number;
    label: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [retracting, setRetracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const purpose = purposeCategory === "その他" ? purposeCustom.trim() : purposeCategory;
  const template = findProcedureTemplate(templateId);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/procedure-refine", { cache: "no-store" });
      const d = await r.json();
      setSessions(Array.isArray(d?.sessions) ? d.sessions : []);
    } catch {
      // 一覧が取れなくても壁打ちはできる
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // ステージが変わったら先頭へ戻す（前の位置が残ると新ステージの頭が画面外になる）。
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stage]);

  const keptIndices = useMemo(
    () => items.map((_, i) => i).filter((i) => !deleted[i]),
    [items, deleted]
  );
  const remainingOpen = useMemo(
    () => openItems.filter((_, i) => !resolvedOpen[i]),
    [openItems, resolvedOpen]
  );
  const fullText = useMemo(
    () =>
      procedureToMarkdown(
        saved ?? theme ?? template.label,
        keptIndices.map((i) => items[i]),
        remainingOpen
      ),
    [saved, theme, template.label, keptIndices, items, remainingOpen]
  );

  function resetToForm() {
    // 登録前の成果（チャット・章立て）が1つでもあるうちは、確認なしで破棄しない。
    // 登録済み（saved）からの「新しい壁打ちを始める」は成果が保存済みなので確認不要。
    const hasUnsaved = !saved && (messages.length > 0 || items.length > 0);
    if (hasUnsaved && !window.confirm("作り直した内容は保存されていません。破棄しますか？")) {
      return;
    }
    setSessionId(null);
    setStage("form");
    setMessages([]);
    setAnswers({});
    setSkipped({});
    setItems([]);
    setOpenItems([]);
    setResolvedOpen({});
    setDeleted({});
    setEditing({});
    setFixing({});
    setFixInstructions({});
    setShowFullText(false);
    setSaved(null);
    setError(null);
    setInput("");
    // 入力系も初期値へ戻す。前回の団体・元資料（baseDoc）が残ったまま次の壁打ちに入ると、
    // A市の資料を土台にB市の文書が作られる事故につながる。
    setTheme("");
    setBaseDoc("");
    setBaseDocName("");
    setTemplateId(PROCEDURE_TEMPLATES[0].id);
    setPurposeCategory(PURPOSE_PRESETS[0]);
    setPurposeCustom("");
    setPeriod("");
    setLinkTarget(false);
    setCategory("自治体");
    setOrganization("");
  }

  async function start() {
    if (!theme.trim()) return setError("どんな文書を作るか（お題）を入力してください");
    if (!purpose) return setError("この文書の位置づけを入力してください");
    if (linkTarget && !organization.trim()) return setError(`${category}名を選んでください`);
    setError(null);
    setSaved(null);
    setLoading(true);
    try {
      const r = await fetch("/api/procedure-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          theme: theme.trim(),
          templateId,
          purpose,
          period: period.trim() || undefined,
          baseDoc: baseDoc || undefined,
          baseDocName: baseDocName || undefined,
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
      const r = await fetch(`/api/procedure-refine?sessionId=${s.id}`, { cache: "no-store" });
      const d = await r.json();
      setSessionId(s.id);
      setTheme(s.theme);
      setTemplateId(findProcedureTemplate(d?.templateId ?? s.template_id).id);
      setPeriod(d?.period ?? s.period ?? "");
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
      const loadedItems: ProcedureItem[] = Array.isArray(d?.items) ? d.items : [];
      setItems(loadedItems);
      setOpenItems(Array.isArray(d?.openItems) ? d.openItems : []);
      setResolvedOpen({});
      setDeleted({});
      setEditing({});
      setFixing({});
      setFixInstructions({});
      setShowFullText(false);
      // 登録済み（titleが付いている）なら完了パネルから再開する。
      if (loadedItems.length > 0 && s.title) setSaved(s.title);
      setStage(loadedItems.length > 0 ? "draft" : "chat");
    } catch {
      setError("読み込みに失敗しました");
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

  async function send() {
    if (!sessionId) return;
    const msg =
      questions.length > 0 ? composeReply(questions, answers, skipped, input) : input.trim();
    if (!msg || !canSend) return;
    setError(null);
    setInput("");
    setAnswers({});
    setSkipped({});
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);
    try {
      const r = await fetch("/api/procedure-refine", {
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

  // 章立ては数章ずつに分けて作る。1回で全章を作らせるとサーバー側の実行時間上限(60秒)を
  // 超えて失敗するため（2026-07-30、8章の実測で62.6秒。API側のコメント参照）。
  // 1バッチ = SECTIONS_PER_BATCH 章。途中で失敗しても、そこまでの章はサーバーに保存済みで、
  // 「続きから」開き直せば残っている。
  const SECTIONS_PER_BATCH = 3;

  async function goDraft() {
    if (!sessionId) return;
    setError(null);
    setDrafting(true);

    const names = template.sections.map((s) => s.name);
    const batches: string[][] = [];
    for (let i = 0; i < names.length; i += SECTIONS_PER_BATCH) {
      batches.push(names.slice(i, i + SECTIONS_PER_BATCH));
    }
    // 最後の1手は要確認事項の抽出なので、進捗の分母は バッチ数 + 1。
    const total = batches.length + 1;
    let acc: ProcedureItem[] = [];

    // 時間切れ（JSONではなくエラーページが返る）を「通信エラー」で済ませず、原因が分かる形で出す。
    async function post(payload: Record<string, unknown>) {
      const r = await fetch("/api/procedure-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => null);
      if (!d) throw new Error("timeout");
      if (!r.ok) throw new Error(d?.error ?? "章立て案の生成に失敗しました");
      return d;
    }

    try {
      for (let i = 0; i < batches.length; i++) {
        setDraftProgress({ done: i, total, label: batches[i].join("・") });
        const d = await post({
          action: "draft",
          sessionId,
          templateId,
          sectionNames: batches[i],
          priorItems: acc,
        });
        acc = acc.concat(Array.isArray(d.items) ? d.items : []);
        // 1章も返らないと以降の重複回避が効かなくなるため、その場で気づけるようにする。
        setItems(acc);
      }

      setDraftProgress({ done: batches.length, total, label: "要確認事項の洗い出し" });
      const o = await post({ action: "draft-open", sessionId, items: acc });
      setOpenItems(Array.isArray(o.openItems) ? o.openItems : []);
      setResolvedOpen({});
      setDeleted({});
      setEditing({});
      setStage("draft");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "timeout") {
        setError(
          acc.length > 0
            ? `章立ての生成が時間切れになりました。${acc.length}章までは保存できています。もう一度「もう章立て案を作る」を押してください（会話も残っています）`
            : "章立ての生成が時間切れになりました。もう一度「もう章立て案を作る」を押してください（会話は残っています）"
        );
      } else {
        setError(msg || "通信エラーが発生しました");
      }
      // 途中まで出来ていれば、それを見ながら続けられるように章立て画面へ進める。
      if (acc.length > 0) setStage("draft");
    } finally {
      setDrafting(false);
      setDraftProgress(null);
    }
  }

  function updateItem(i: number, patch: Partial<ProcedureItem>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  // 作り直す（instruction無し）／ここを直す（instruction有り）は同じAPIに寄せている。
  async function rewriteItem(i: number, instruction?: string) {
    if (!sessionId) return;
    setError(null);
    setBusyIndex(i);
    try {
      const r = await fetch("/api/procedure-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rewrite-item",
          sessionId,
          item: items[i],
          items,
          instruction,
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "修正に失敗しました");
      setItems((prev) => prev.map((it, idx) => (idx === i ? d.item : it)));
      setFixing((prev) => ({ ...prev, [i]: false }));
      setFixInstructions((prev) => ({ ...prev, [i]: "" }));
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setBusyIndex(null);
    }
  }

  async function saveFinal() {
    if (!sessionId) return;
    if (keptIndices.length === 0) return setError("すべて削除されています。少なくとも1章は残してください");
    setError(null);
    setSaving(true);
    try {
      const r = await fetch("/api/procedure-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          sessionId,
          items: keptIndices.map((i) => items[i]),
          openItems: remainingOpen,
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "登録に失敗しました");
      setSaved(d.title ?? "提出文書");
      loadSessions();
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSaving(false);
    }
  }

  async function retractSave() {
    if (!sessionId) return;
    setError(null);
    setRetracting(true);
    try {
      const r = await fetch("/api/procedure-refine", {
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

  async function copyFullText() {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("コピーできませんでした。全文表示から手動で選択してください");
    }
  }

  return (
    <div>
      {/* Stage 1: お題入力 */}
      {stage === "form" && (
        <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div>
            <label className="block text-sm font-medium text-gray-600">
              どんな文書を作るか・お題
            </label>
            <textarea
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              rows={3}
              disabled={loading}
              placeholder="例: 政令市の事務センター向けに、法人請求オンラインサービスの実施理由書を作りたい。庁内の稟議を通すのが目的"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>

          <DocUpload
            label="元になる文書（任意）"
            hint="docx・pdf・pptx・txt。過去の実施理由書などを登録すると、ゼロからではなくそれを直す形で深掘りします"
            disabled={loading}
            onExtracted={(text, filename) => {
              setBaseDoc(text);
              setBaseDocName(filename);
            }}
          />

          <div>
            <label className="block text-sm font-medium text-gray-600">文書の種類（章立ての型）</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={loading}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            >
              {PROCEDURE_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-gray-500">{template.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {template.sections.map((s) => (
                <span
                  key={s.name}
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${procedureSectionBadgeClass(template, s.name)}`}
                >
                  {s.name}
                </span>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-600">この文書の位置づけ</label>
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
                placeholder="位置づけを入力してください"
                className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
              />
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-600">実施時期の目安（任意）</label>
            <input
              type="text"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={loading}
              placeholder="例: 2026年10月〜12月の3か月間"
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
                linkTarget
                  ? "border-indigo-500 bg-indigo-500 text-white"
                  : "border-gray-300 text-transparent"
              }`}
            >
              ✓
            </span>
            <span className="text-sm font-medium text-gray-600">相手方（団体）に紐付ける</span>
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

      {/* ヘッダー帯 */}
      {stage !== "form" && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate rounded-full bg-indigo-100 px-3 py-1 text-sm font-semibold text-indigo-700">
            {organization ? `${organization}（${category}）` : theme}
          </span>
          <span className="min-w-0 truncate rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700">
            {template.label}
          </span>
          {period && (
            <span className="min-w-0 truncate rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600">
              {period}
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
                  className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-base leading-relaxed ${
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
                <span className="text-base text-gray-500">考えています...</span>
              </div>
            )}
          </div>

          {!loading && questions.length > 0 && (
            <div className="space-y-3">
              {parsed?.intro && (
                <p className="whitespace-pre-wrap px-1 text-base leading-relaxed text-gray-600">
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
                      <span className="mt-0.5 shrink-0 rounded-md bg-indigo-100 px-2 py-1 text-sm font-bold text-indigo-700">
                        {q.label}
                      </span>
                      <p className="text-lg font-bold leading-relaxed text-gray-900">{q.heading}</p>
                    </div>
                    {q.body && (
                      <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-gray-700">
                        {q.body}
                      </p>
                    )}
                    <textarea
                      value={answers[q.label] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.label]: e.target.value }))}
                      rows={5}
                      disabled={isSkipped}
                      placeholder="ここに答える（箇条書き・音声入力そのままでOK）"
                      className="mt-3 block w-full resize-y rounded-lg border border-gray-300 px-3 py-2.5 text-lg leading-relaxed text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-gray-50 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setSkipped((prev) => ({ ...prev, [q.label]: !prev[q.label] }))}
                      className="mt-2 text-sm font-medium text-gray-500 active:opacity-70"
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
              <label className="mb-1 block px-1 text-sm font-medium text-gray-500">
                補足（任意・問い以外に伝えたいこと）
              </label>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={questions.length > 0 ? 2 : 3}
              placeholder={
                questions.length > 0 ? "例: 相手方は年度末が繁忙で動けない" : "質問に答える"
              }
              disabled={loading}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-lg leading-relaxed text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
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
                onClick={goDraft}
                disabled={drafting || loading || !hasAssistantTurn}
                className="flex-1 rounded-xl bg-purple-600 px-4 py-2.5 text-base font-semibold text-white transition active:bg-purple-700 disabled:opacity-40"
              >
                {drafting
                  ? draftProgress
                    ? `作成中 ${draftProgress.done + 1}/${draftProgress.total}（${draftProgress.label}）`
                    : "章立てを作成中..."
                  : "もう章立て案を作る"}
              </button>
            </div>
          </div>

          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </div>
      )}

      {/* Stage 3: 章立て案（編集・手直し・登録） */}
      {stage === "draft" && (
        <div className="space-y-4">
          {!saved && (
            <p className="text-sm leading-relaxed text-gray-500">
              章ごとに「編集する」「ここを直す」「作り直す」「削除」を選べます。本文は1行1項目、表は1行目が列名・セルは | 区切りです。
            </p>
          )}

          {/* 要確認事項（決まっていないこと）。ここを潰すのが実施要領書の肝。 */}
          {openItems.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-base font-bold text-amber-900">
                要確認事項（まだ決まっていないこと） {remainingOpen.length}/{openItems.length}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-amber-800">
                AIが創作せずに残した未確定の項目です。解決したものはチェックを入れると、登録・全文から外れます。
              </p>
              <div className="mt-3 space-y-2">
                {openItems.map((o, i) => {
                  const done = !!resolvedOpen[i];
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setResolvedOpen((prev) => ({ ...prev, [i]: !prev[i] }))}
                      disabled={!!saved}
                      className="flex w-full items-start gap-2 text-left disabled:opacity-60"
                    >
                      <span
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
                          done
                            ? "border-amber-600 bg-amber-600 text-white"
                            : "border-amber-300 bg-white text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                      <span
                        className={`text-base leading-relaxed ${done ? "text-amber-700 line-through" : "text-amber-900"}`}
                      >
                        {o}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-3">
            {items.map((item, i) => {
              const isDeleted = !!deleted[i];
              const isEditing = !!editing[i];
              const isBusy = busyIndex === i;

              if (isDeleted) {
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 p-4 opacity-60"
                  >
                    <span className="shrink-0 rounded-md bg-gray-200 px-2 py-0.5 text-xs font-bold text-gray-500">
                      {i + 1}章
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-500 line-through">
                      {item.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDeleted((prev) => ({ ...prev, [i]: false }))}
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
                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${procedureSectionBadgeClass(template, item.section)}`}
                    >
                      {item.section}
                    </span>
                    <span className="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                      {i + 1}章
                    </span>
                  </div>

                  {isEditing ? (
                    <div className="mt-2 space-y-2">
                      <input
                        type="text"
                        value={item.title}
                        onChange={(e) => updateItem(i, { title: e.target.value })}
                        className="block w-full rounded-md border border-purple-300 bg-purple-50 px-2 py-1.5 text-lg font-bold text-gray-900 focus:outline-none"
                      />
                      <textarea
                        value={item.body.join("\n")}
                        onChange={(e) => updateItem(i, { body: e.target.value.split("\n") })}
                        rows={Math.max(3, item.body.length)}
                        placeholder="本文を1行ずつ"
                        className="block w-full resize-y rounded-md border border-purple-300 bg-purple-50 px-2 py-1.5 text-base leading-relaxed text-gray-700 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={item.table?.caption ?? ""}
                        onChange={(e) =>
                          updateItem(i, {
                            table: { ...item.table, caption: e.target.value },
                          })
                        }
                        placeholder="表の見出し（表が不要なら空欄）"
                        className="block w-full rounded-md border border-purple-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:outline-none"
                      />
                      <textarea
                        value={tableToText(item)}
                        onChange={(e) =>
                          updateItem(i, {
                            table: textToTable(e.target.value, item.table?.caption ?? ""),
                          })
                        }
                        rows={Math.max(3, (item.table?.rows?.length ?? 0) + 1)}
                        placeholder={"表（1行目が列名／セルは | 区切り）\n時期 | 実施内容 | 担当"}
                        className="block w-full resize-y rounded-md border border-purple-200 bg-white px-2 py-1.5 font-mono text-xs leading-relaxed text-gray-700 focus:outline-none"
                      />
                    </div>
                  ) : (
                    <div className="mt-2">
                      <p className="text-lg font-bold text-gray-900">{item.title}</p>
                      <ul className="mt-1 space-y-0.5">
                        {item.body.filter(Boolean).map((b, bi) => (
                          <li key={bi} className="flex gap-2 text-base leading-relaxed text-gray-700">
                            <span className="text-gray-300">・</span>
                            <span>{b}</span>
                          </li>
                        ))}
                      </ul>
                      <TablePreview table={item.table} />
                    </div>
                  )}

                  {!saved && !!fixing[i] && (
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
                        placeholder="例: 役割分担表に「問い合わせ一次対応」の行を足して、担当は当社に"
                        className="mt-2 block w-full rounded-lg border border-purple-300 bg-white px-2.5 py-2 text-sm text-gray-900 focus:outline-none"
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const instruction = (fixInstructions[i] ?? "").trim();
                            if (!instruction) return setError("修正したい内容を入力してください");
                            rewriteItem(i, instruction);
                          }}
                          disabled={isBusy}
                          className="flex-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white active:bg-purple-700 disabled:opacity-40"
                        >
                          {isBusy ? "修正中..." : "この内容で直す"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setFixing((prev) => ({ ...prev, [i]: false }))}
                          disabled={isBusy}
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
                        onClick={() => setEditing((prev) => ({ ...prev, [i]: !prev[i] }))}
                        disabled={isBusy}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 active:bg-gray-50 disabled:opacity-40"
                      >
                        {isEditing ? "編集を終える" : "✏️ 編集する"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFixing((prev) => ({ ...prev, [i]: !prev[i] }))}
                        disabled={isBusy}
                        className="rounded-lg border border-purple-200 px-3 py-1.5 text-xs font-medium text-purple-700 active:bg-purple-50 disabled:opacity-40"
                      >
                        🩹 ここを直す
                      </button>
                      <button
                        type="button"
                        onClick={() => rewriteItem(i)}
                        disabled={isBusy}
                        className="rounded-lg border border-purple-200 px-3 py-1.5 text-xs font-medium text-purple-700 active:bg-purple-50 disabled:opacity-40"
                      >
                        {isBusy ? "作り直し中..." : "🔄 作り直す"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleted((prev) => ({ ...prev, [i]: true }))}
                        disabled={isBusy}
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

          {/* 全文（Markdown）。Wordに貼る・Claude Codeに渡す用。 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowFullText((v) => !v)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 active:bg-gray-50"
              >
                {showFullText ? "全文を閉じる" : "📄 全文を見る（Markdown）"}
              </button>
              <button
                type="button"
                onClick={copyFullText}
                className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 active:bg-indigo-50"
              >
                {copied ? "コピーしました" : "📋 全文をコピー"}
              </button>
            </div>
            {showFullText && (
              <textarea
                readOnly
                value={fullText}
                rows={20}
                className="mt-3 block w-full resize-y rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs leading-relaxed text-gray-700 focus:outline-none"
              />
            )}
          </div>

          {!saved ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <button
                type="button"
                onClick={saveFinal}
                disabled={saving || keptIndices.length === 0}
                className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
              >
                {saving ? "登録中..." : `この${keptIndices.length}章を確定して登録`}
              </button>
              {remainingOpen.length > 0 && (
                <p className="mt-2 text-xs leading-relaxed text-amber-700">
                  未確定の要確認事項が{remainingOpen.length}件あります。登録はできますが、相手方に出す前に潰してください。
                </p>
              )}
              {error && (
                <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center shadow-sm">
              <p className="text-2xl">✅</p>
              <p className="mt-2 text-base font-bold text-emerald-900">この壁打ちは完了です</p>
              <p className="mt-1 text-sm leading-relaxed text-emerald-800">
                「{saved}」として成果物に登録しました。
                {organization ? `${organization}向けの` : ""}
                次回の提案・文書の土台になります。
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
              <p className="mt-3 text-xs leading-relaxed text-emerald-800">
                Word化したいときは「全文をコピー」でMarkdownを持ち出し、Macの実行役（Claude
                Code）に渡してください。
              </p>
              <button
                type="button"
                onClick={retractSave}
                disabled={retracting}
                className="mt-3 text-xs font-medium text-rose-600 underline decoration-dotted active:opacity-70 disabled:opacity-40"
              >
                {retracting ? "取り消しています..." : "この登録を取り消す（記憶から削除）"}
              </button>
              {error && (
                <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 過去の実施要領書壁打ち */}
      {stage === "form" && sessions.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 px-1 text-sm font-semibold text-gray-500">過去の提出文書壁打ち</h2>
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
