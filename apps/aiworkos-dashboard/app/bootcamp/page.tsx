"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  BootcampLog,
  OFFICIAL_APP_URL,
  PHASES,
  PHASE_LABEL,
  Phase,
  QaChapter,
  Quiz,
  SPRINTS,
  countByPhase,
  logsOf,
  matches,
  qaCount,
  shortDate,
  totalQaCount,
} from "@/lib/bootcamp";

// ブートキャンプ学習ページ。SALT2 AIサマーブートキャンプ（2026年8月〜9月）用。
//
// 運営の「ブートキャンプアプリ」が教材・提出・公式クイズ・進捗率を持っているので、
// 同じものは作らない。ここは運営アプリに無い3つだけを引き受ける。
//   1. 学習内容を自分の手元に溜める
//   2. 溜めた内容から自分専用のテストを作る（未実装。qa_session を材料にする）
//   3. 学んだことを公共事業0→1の仕事にどう繋げるか
//
// 3つ目が本命なので、カードの一番目立つ位置に「応用」を置いている。
// 学びのタイトルより応用ポイントの方が、後から読み返したときの値打ちが大きい。
//
// 並びは運営アプリの進捗表と同じ Learn → Design → Build → Review → Presentation。
// 往復しても迷わないことを優先した。
//
// データは数十件と小さいので /api/bootcamp で全件を受け取り、
// 絞り込みと検索はこの中で行う（/salt2・家庭訪問と同じ流儀）。

const C_SPRINT = "#4f46e5"; // 藍。SALT2人脈DBの青と近すぎない位置
const C_APPLY = "#c2410c"; // 応用ポイント（この画面の主役なので暖色で目を引く）
const C_DECIDE = "#0d7c8a"; // 判断と理由

type ApiResponse = { logs: BootcampLog[]; error?: string };

export default function BootcampPage() {
  const [logs, setLogs] = useState<BootcampLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sprint, setSprint] = useState<string>("Sprint1");
  const [phase, setPhase] = useState<Phase>("Learn");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function addLog(log: BootcampLog) {
    setLogs((prev) => [log, ...(prev ?? [])]);
  }

  function updateLog(id: string, patch: Partial<BootcampLog>) {
    setLogs((prev) => (prev ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  useEffect(() => {
    let alive = true;
    fetch("/api/bootcamp")
      .then((r) => r.json())
      .then((d: ApiResponse) => {
        if (!alive) return;
        if (d.error) setError(d.error);
        else setLogs(d.logs ?? []);
      })
      .catch(() => alive && setError("学習ログを取得できませんでした"));
    return () => {
      alive = false;
    };
  }, []);

  const all = logs ?? [];
  const counts = useMemo(() => countByPhase(all, sprint), [all, sprint]);

  // 検索中はフェーズの枠を越えて探す。「あのとき何て判断したっけ」で
  // 戻ってこられることの方が、フェーズの整理より優先度が高い。
  const searching = query.trim() !== "";
  const shown = useMemo(() => {
    if (searching) return all.filter((l) => matches(l, query));
    return logsOf(all, sprint, phase);
  }, [all, sprint, phase, query, searching]);

  const loading = !logs && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          📘 ブートキャンプ学習
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          Sprintごとの学びとQ&amp;Aを溜めて、新規事業への応用に変える。
          提出と公式クイズは運営アプリ側
        </p>
      </header>

      {/* 学習中は教材と進捗で何度も往復するので、毎回ブックマークを探さずに済むよう常設する */}
      <a
        href={OFFICIAL_APP_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 flex items-center justify-between rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 transition active:bg-sky-100"
      >
        <span className="flex items-center gap-3">
          <span className="text-xl" aria-hidden>
            🚀
          </span>
          <span>
            <span className="block text-sm font-semibold text-sky-900">
              運営アプリを開く
            </span>
            <span className="block text-xs text-sky-700">
              教材・課題の提出・進捗・公式クイズはこちら
            </span>
          </span>
        </span>
        <span className="text-sm text-sky-500" aria-hidden>
          ↗
        </span>
      </a>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {logs && (
        <>
          <div className="mt-5 flex gap-2">
            {SPRINTS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSprint(s)}
                className="flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition active:opacity-70"
                style={
                  sprint === s
                    ? { borderColor: C_SPRINT, background: C_SPRINT, color: "#fff" }
                    : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                }
              >
                {s}
              </button>
            ))}
          </div>

          {/* フェーズ選択。運営アプリの進捗表と同じ並びにしてある */}
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {PHASES.map((p) => {
              const n = counts[p] ?? 0;
              const active = !searching && phase === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setPhase(p);
                  }}
                  className="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition active:opacity-70"
                  style={
                    active
                      ? { borderColor: C_SPRINT, background: "#eef2ff", color: C_SPRINT }
                      : { borderColor: "#e5e7eb", background: "#fff", color: "#9ca3af" }
                  }
                >
                  {p}
                  {n > 0 && <span className="ml-1 opacity-70">{n}</span>}
                </button>
              );
            })}
          </div>

          {!searching && (
            <p className="mt-2 text-xs text-gray-400">{PHASE_LABEL[phase]}</p>
          )}

          <div className="mt-4 flex gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="学び・判断・応用ポイントから探す"
              className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm outline-none focus:border-indigo-400"
            />
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white active:opacity-80"
            >
              ＋ 登録
            </button>
          </div>

          {searching && (
            <p className="mt-2 text-xs text-gray-500">
              全Sprint・全フェーズから {shown.length} 件
            </p>
          )}

          <div className="mt-4 space-y-3">
            {shown.map((log) => (
              <LogCard
                key={log.id}
                log={log}
                open={openId === log.id}
                onToggle={() => setOpenId(openId === log.id ? null : log.id)}
                showPhase={searching}
                onQuizSaved={(id, quiz) => updateLog(id, { quiz })}
              />
            ))}
          </div>

          {shown.length === 0 && (
            <div className="mt-6 rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
              <p className="text-sm text-gray-500">
                {searching
                  ? "見つかりませんでした"
                  : `${sprint} の ${phase} はまだ空です`}
              </p>
              {!searching && (
                <p className="mt-2 text-xs leading-relaxed text-gray-400">
                  学んだ内容とQ&amp;AはClaude Codeから登録できます
                </p>
              )}
            </div>
          )}

          {all.length > 0 && (
            <p className="mt-6 text-xs leading-relaxed text-gray-400">
              学びの記録 {all.length} 件・Q&amp;A {totalQaCount(all)} 問ぶん。
              応用ポイントは必須項目にしてあるので、全ての記録に「事業にどう効くか」が付いています。
            </p>
          )}
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホームに戻る
        </Link>
      </div>

      {showForm && (
        <RegisterSheet
          sprint={sprint}
          phase={phase}
          onClose={() => setShowForm(false)}
          onSaved={(log) => {
            addLog(log);
            setShowForm(false);
          }}
        />
      )}
    </main>
  );
}

function RegisterSheet({
  sprint,
  phase,
  onClose,
  onSaved,
}: {
  sprint: string;
  phase: Phase;
  onClose: () => void;
  onSaved: (log: BootcampLog) => void;
}) {
  const [topic, setTopic] = useState("");
  const [sourceContent, setSourceContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [decisions, setDecisions] = useState("");
  const [application, setApplication] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    if (!topic.trim() || !application.trim()) {
      setError("学びのタイトルと、新規事業への応用ポイントは必須です");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/bootcamp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sprint,
          phase,
          topic: topic.trim(),
          source_content: sourceContent.trim() || undefined,
          source_url: sourceUrl.trim() || undefined,
          notes: notes.trim() || undefined,
          decisions: decisions.trim() || undefined,
          business_application: application.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "登録に失敗しました");
      onSaved(data.log as BootcampLog);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">学びを登録</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-sm text-gray-400 active:opacity-60"
          >
            閉じる
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          {sprint} / {phase} に登録します
        </p>

        <div className="mt-4 space-y-4">
          <Field label="学びのタイトル" required>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例：構造化出力"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </Field>

          <Field label="本文貼り付け" hint="ブートキャンプアプリの説明文などをそのままコピペしてよい">
            <textarea
              value={sourceContent}
              onChange={(e) => setSourceContent(e.target.value)}
              rows={5}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </Field>

          <Field label="元URL">
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://..."
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </Field>

          <Field label="気づき・メモ">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </Field>

          <Field label="決めたこと・その理由" hint="壁打ちで判断したことがあれば">
            <textarea
              value={decisions}
              onChange={(e) => setDecisions(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </Field>

          <Field label="新規事業への応用ポイント" required hint="1行でもよいので必ず書く">
            <textarea
              value={application}
              onChange={(e) => setApplication(e.target.value)}
              rows={2}
              className="w-full rounded-xl border border-orange-200 bg-orange-50/40 px-3 py-2 text-sm outline-none focus:border-orange-400"
            />
          </Field>
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="mt-5 w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white active:opacity-80 disabled:opacity-50"
        >
          {saving ? "登録中…" : "登録する"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-gray-600">
        {label}
        {required && <span className="ml-1 text-orange-500">必須</span>}
      </span>
      {hint && <span className="mt-0.5 block text-[11px] text-gray-400">{hint}</span>}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

function LogCard({
  log,
  open,
  onToggle,
  showPhase,
  onQuizSaved,
}: {
  log: BootcampLog;
  open: boolean;
  onToggle: () => void;
  showPhase: boolean;
  onQuizSaved: (id: string, quiz: Quiz) => void;
}) {
  const n = qaCount(log);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-4 text-left active:bg-gray-50"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex-1 text-base font-bold leading-snug text-gray-900">
            {log.topic}
          </h2>
          <span className="shrink-0 text-xs text-gray-400">
            {shortDate(log.created_at)}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {showPhase && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-600">
              {log.sprint} / {log.phase}
            </span>
          )}
          {n > 0 && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">
              Q&amp;A {n}問
            </span>
          )}
        </div>

        {/* この画面の主役。学びのタイトルより応用の方を目立たせる */}
        <p
          className="mt-2.5 text-sm leading-relaxed"
          style={{ color: C_APPLY }}
        >
          <span className="font-semibold">応用：</span>
          {log.business_application}
        </p>

        <span className="mt-2 block text-xs text-indigo-500">
          {open ? "閉じる" : "詳しく見る"}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-4">
          {log.decisions && (
            <section className="mb-4">
              <h3
                className="text-xs font-bold tracking-wide"
                style={{ color: C_DECIDE }}
              >
                決めたこと・その理由
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {log.decisions}
              </p>
            </section>
          )}

          {log.notes && (
            <section className="mb-4">
              <h3 className="text-xs font-bold tracking-wide text-gray-500">
                気づき・メモ
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {log.notes}
              </p>
            </section>
          )}

          {log.qa_session && (
            <section className="mb-4">
              <h3 className="text-xs font-bold tracking-wide text-gray-500">
                Q&amp;Aセッション
              </h3>
              <p className="mt-1 text-sm font-semibold text-gray-800">
                {log.qa_session.theme}
              </p>
              <div className="mt-3 space-y-4">
                {log.qa_session.chapters.map((c) => (
                  <ChapterBlock key={c.no} chapter={c} />
                ))}
              </div>
            </section>
          )}

          <section className="mb-1">
            <h3 className="text-xs font-bold tracking-wide text-gray-500">テスト</h3>
            <QuizSection log={log} onSaved={(quiz) => onQuizSaved(log.id, quiz)} />
          </section>

          {log.source_url && (
            <a
              href={log.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-indigo-500 active:opacity-70"
            >
              出典を開く ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function QuizSection({
  log,
  onSaved,
}: {
  log: BootcampLog;
  onSaved: (quiz: Quiz) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMaterial = !!(log.qa_session || log.source_content || log.notes);

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/bootcamp/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: log.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "テストの生成に失敗しました");
      onSaved(data.quiz as Quiz);
    } catch (e) {
      setError(e instanceof Error ? e.message : "テストの生成に失敗しました");
    } finally {
      setGenerating(false);
    }
  }

  if (!log.quiz) {
    return (
      <div className="mt-1.5">
        {!hasMaterial ? (
          <p className="text-xs text-gray-400">
            本文かQ&amp;Aセッションが無いのでテストを作れません
          </p>
        ) : (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white active:opacity-70 disabled:opacity-50"
          >
            {generating ? "作成中…" : "テストを作る"}
          </button>
        )}
        {error && <p className="mt-1.5 text-xs text-rose-600">{error}</p>}
      </div>
    );
  }

  return <QuizPlayer quiz={log.quiz} onRegenerate={generate} regenerating={generating} />;
}

function QuizPlayer({
  quiz,
  onRegenerate,
  regenerating,
}: {
  quiz: Quiz;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const [picked, setPicked] = useState<Record<number, number>>({});

  return (
    <div className="mt-1.5 space-y-3">
      {quiz.questions.map((q, qi) => {
        const chosen = picked[qi];
        const answered = chosen !== undefined;
        return (
          <div key={qi} className="rounded-lg border border-gray-150 bg-gray-50 p-3">
            <p className="text-sm font-semibold leading-snug text-gray-900">
              問{qi + 1}. {q.question}
            </p>
            <div className="mt-2 space-y-1.5">
              {q.choices.map((choice, ci) => {
                const isCorrect = ci === q.answer_index;
                const isChosen = ci === chosen;
                let style = "border-gray-200 bg-white text-gray-700";
                if (answered && isCorrect) {
                  style = "border-emerald-400 bg-emerald-50 text-emerald-800";
                } else if (answered && isChosen && !isCorrect) {
                  style = "border-rose-300 bg-rose-50 text-rose-700";
                }
                return (
                  <button
                    key={ci}
                    type="button"
                    disabled={answered}
                    onClick={() => setPicked((p) => ({ ...p, [qi]: ci }))}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs leading-relaxed transition active:opacity-70 ${style}`}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>
            {answered && q.explanation && (
              <p className="mt-2 text-xs leading-relaxed text-gray-500">
                {chosen === q.answer_index ? "正解。" : "不正解。"}
                {q.explanation}
              </p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onRegenerate}
        disabled={regenerating}
        className="text-xs text-indigo-500 active:opacity-70 disabled:opacity-50"
      >
        {regenerating ? "作り直し中…" : "作り直す"}
      </button>
    </div>
  );
}

function ChapterBlock({ chapter }: { chapter: QaChapter }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-gray-150 bg-gray-50 p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left active:opacity-70"
      >
        <span className="text-sm font-bold text-gray-800">
          第{chapter.no}講　{chapter.title}
        </span>
        {chapter.goal && (
          <span className="mt-0.5 block text-xs text-gray-500">{chapter.goal}</span>
        )}
        <span className="mt-1 block text-xs text-indigo-500">
          {open ? "閉じる" : `${chapter.qa.length}問を開く`}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {chapter.qa.map((pair, i) => (
            <div key={i} className="rounded-lg bg-white p-3">
              <p className="text-sm font-semibold leading-snug text-gray-900">
                Q. {pair.q}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-700">{pair.a}</p>
              {pair.example && (
                <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
                  たとえ：{pair.example}
                </p>
              )}
            </div>
          ))}

          {chapter.summary && chapter.summary.length > 0 && (
            <div className="rounded-lg bg-indigo-50 p-3">
              <p className="text-xs font-bold text-indigo-700">この講のまとめ</p>
              <ul className="mt-1.5 space-y-1">
                {chapter.summary.map((s, i) => (
                  <li key={i} className="text-xs leading-relaxed text-indigo-900">
                    ・{s}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
