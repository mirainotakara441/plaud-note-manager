"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// 成果物壁打ち（対象との関係の熟成）。統合入口 /refine の「🗨 成果物」モードの本体。
// 旧 app/refine/page.tsx の中身をそのまま移した（3つのチャットエンジンの統合はスコープ外）。
import StakeholderPicker, {
  rememberStakeholder,
  type Category,
} from "@/app/components/StakeholderPicker";
import DocUpload from "@/app/components/refine/DocUpload";
import { parseCategoryWideName } from "@/lib/categories";
import { composeReply, parseQuestions, stripBold } from "@/lib/parseQuestions";

type Msg = { role: "user" | "assistant"; content: string };
type Session = {
  id: string;
  organization: string;
  category: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  // クローズ＝一覧から引っ込めただけ。会話も成果物も残っている。
  closed_at: string | null;
  message_count: number;
  // 「熟成して登録」で記憶層に成果物が入っているか
  has_deliverable: boolean;
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DeliverableRefine() {
  const searchParams = useSearchParams();
  const presetOrg = searchParams.get("org") ?? "";

  const [sessions, setSessions] = useState<Session[]>([]);
  const [organization, setOrganization] = useState(presetOrg);
  const [category, setCategory] = useState<Category>("自治体");
  const [theme, setTheme] = useState("");
  // 元になる資料（任意）。ブラウザで抽出したテキストだけを持つ。
  const [baseDoc, setBaseDoc] = useState("");
  const [baseDocName, setBaseDocName] = useState("");
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
  // 一覧の整理まわり
  const [showClosed, setShowClosed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 開いているセッションがクローズ済みかどうか
  const [currentClosed, setCurrentClosed] = useState(false);

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
          baseDoc: baseDoc || undefined,
          baseDocName: baseDocName || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d?.error ?? "開始に失敗しました");
      setSessionId(d.sessionId);
      setMessages(d.messages ?? []);
      setCurrentClosed(false);
      // 「自治体全般」は実在の団体ではないので団体マスタへ入れない。
      // 入れると次回から本物の候補に混ざって見分けがつかなくなる。
      if (!parseCategoryWideName(organization)) {
        rememberStakeholder(category, organization.trim());
      }
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
      setCurrentClosed(!!s.closed_at);
      setMessages(Array.isArray(d?.messages) ? d.messages : []);
    } catch {
      setError("読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  // クローズ／再開／削除。いずれも Claude を呼ばない軽い操作。
  async function mutateSession(
    id: string,
    action: "close" | "reopen" | "delete"
  ): Promise<boolean> {
    setError(null);
    setBusyId(id);
    try {
      const r = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionId: id }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d?.error ?? "操作に失敗しました");
        return false;
      }
      await loadSessions();
      return true;
    } catch {
      setError("通信エラーが発生しました");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  // 削除は戻せないので必ず確認を挟む。
  // 「消えるのは会話ログだけで、熟成して登録した成果物は残る」ことを文言で明示する。
  function askDelete(s: Session) {
    const text = [
      `「${s.organization}」の壁打ちを削除します。`,
      "",
      `・この会話（${s.message_count}発言）が消えます。元には戻せません。`,
      s.has_deliverable
        ? "・「熟成して登録」した内容は消えません。記憶に残り、検索や提案でこれまで通り使えます。"
        : "・このセッションはまだ「熟成して登録」していないため、記憶に残るものはありません。",
      "",
      "削除しますか？",
    ].join("\n");
    if (!window.confirm(text)) return;
    void mutateSession(s.id, "delete");
  }

  // 開いているセッションをクローズして一覧へ戻る
  async function closeCurrent() {
    if (!sessionId) return;
    const ok = await mutateSession(sessionId, "close");
    if (!ok) return;
    setSessionId(null);
    setMessages([]);
    setSaved(null);
    setCurrentClosed(false);
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

  const openSessions = sessions.filter((s) => !s.closed_at);
  const closedSessions = sessions.filter((s) => s.closed_at);
  const visibleSessions = showClosed ? sessions : openSessions;

  return (
    <div>
      {/* 対象選択 */}
      {!sessionId && (
        <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <StakeholderPicker
            category={category}
            onCategoryChange={setCategory}
            name={organization}
            onNameChange={setOrganization}
            disabled={loading}
            allowCategoryWide
          />

          <DocUpload
            label="元になる資料（任意）"
            hint="pptx・docx・pdf・txt・md。登録すると、記憶層の内容に加えてこの資料を土台に深掘りします"
            disabled={loading}
            onExtracted={(text, filename) => {
              setBaseDoc(text);
              setBaseDocName(filename);
            }}
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-semibold text-indigo-700">
              {/* 「自治体全般（自治体）」は同じことを二度言っていて読みにくい */}
              {parseCategoryWideName(organization)
                ? organization
                : `${organization}（${category}）`}
            </span>
            {currentClosed && (
              <span className="rounded-full bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600">
                クローズ済み
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setSessionId(null);
                setMessages([]);
                setSaved(null);
                setCurrentClosed(false);
              }}
              className="ml-auto text-sm font-medium text-gray-500 active:opacity-70"
            >
              対象を変える
            </button>
            {currentClosed ? (
              <button
                type="button"
                onClick={async () => {
                  if (!sessionId) return;
                  if (await mutateSession(sessionId, "reopen")) setCurrentClosed(false);
                }}
                disabled={busyId === sessionId}
                className="text-sm font-medium text-indigo-600 active:opacity-70 disabled:opacity-40"
              >
                再開する
              </button>
            ) : (
              <button
                type="button"
                onClick={closeCurrent}
                disabled={busyId === sessionId}
                className="text-sm font-medium text-gray-500 active:opacity-70 disabled:opacity-40"
              >
                クローズ
              </button>
            )}
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
                <p className="px-1 text-base leading-relaxed whitespace-pre-wrap text-gray-600">
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
                      <p className="text-lg font-bold leading-relaxed text-gray-900">
                        {q.heading}
                      </p>
                    </div>
                    {q.body && (
                      <p className="mt-2 text-base leading-relaxed whitespace-pre-wrap text-gray-700">
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

      {/* 過去の壁打ち：既定ではクローズ済みを隠し、必要なときだけ出す */}
      {!sessionId && sessions.length > 0 && (
        <section className="mt-6">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1">
            <h2 className="text-sm font-semibold text-gray-500">過去の壁打ち</h2>
            <span className="text-xs text-gray-400">
              進行中 {openSessions.length}件
              {closedSessions.length > 0 && `・クローズ済み ${closedSessions.length}件`}
            </span>
            {closedSessions.length > 0 && (
              <button
                type="button"
                onClick={() => setShowClosed((v) => !v)}
                className="ml-auto text-xs font-medium text-indigo-600 active:opacity-70"
              >
                {showClosed ? "クローズ済みを隠す" : "クローズ済みも表示"}
              </button>
            )}
          </div>

          {visibleSessions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-400">
              進行中の壁打ちはありません
            </p>
          ) : (
            <div className="space-y-2">
              {visibleSessions.map((s) => {
                const busy = busyId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`overflow-hidden rounded-xl border bg-white shadow-sm transition ${
                      s.closed_at ? "border-gray-200 opacity-70" : "border-gray-200"
                    } ${busy ? "opacity-40" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => resume(s)}
                      disabled={busy}
                      className="block w-full px-4 py-3 text-left active:bg-gray-50"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-gray-800">
                          {s.organization}
                        </span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          {s.category}
                        </span>
                        {s.has_deliverable ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            熟成済み
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                            熟成の登録なし
                          </span>
                        )}
                        {s.closed_at && (
                          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                            クローズ済み
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-gray-500">
                        {s.title ?? "（成果物の名前はまだ付いていません）"}
                      </p>
                      <p className="mt-1 text-xs text-gray-400">
                        {s.message_count}発言・最終更新 {formatWhen(s.updated_at)}
                      </p>
                    </button>
                    <div className="flex items-center gap-3 border-t border-gray-100 px-4 py-2">
                      <button
                        type="button"
                        onClick={() => resume(s)}
                        disabled={busy}
                        className="text-xs font-medium text-indigo-600 active:opacity-70 disabled:opacity-40"
                      >
                        続きから →
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void mutateSession(s.id, s.closed_at ? "reopen" : "close")
                        }
                        disabled={busy}
                        className="ml-auto text-xs font-medium text-gray-500 active:opacity-70 disabled:opacity-40"
                      >
                        {s.closed_at ? "再開する" : "クローズ"}
                      </button>
                      <button
                        type="button"
                        onClick={() => askDelete(s)}
                        disabled={busy}
                        className="text-xs font-medium text-red-600 active:opacity-70 disabled:opacity-40"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="mt-2 px-1 text-xs leading-relaxed text-gray-400">
            「クローズ」は一覧から引っ込めるだけで、会話も成果物も残ります。「削除」で消えるのは会話だけで、
            熟成して登録した内容は記憶に残ります。「熟成の登録なし」は、まだ成果物にしていないやり取りです。
          </p>
        </section>
      )}

    </div>
  );
}
