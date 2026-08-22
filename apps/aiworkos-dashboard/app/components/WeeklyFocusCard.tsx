"use client";

import { useCallback, useEffect, useState } from "react";

// ホーム最上部の「今週おこなうこと」。最大5件。中身は /api/weekly-focus。
//
// 日々のToDoとは別物。あちらは日記から自動で積み上がる「こなす一覧」で、
// こちらは自分で選んで書く「今週これだけはやる」。5点に絞ることそのものが目的なので、
// 5件に達したら入力欄を閉じて「消してから足す」と言う——上限を柔らかく破らせない。
//
// 書く・直す・消すをこの場で完結させる。別ページへ飛ばすと、思いついた時に
// 書き足す動きが止まる。

type FocusRow = {
  id: string;
  position: number;
  content: string;
  done: boolean;
};

type Res = {
  week_start: string;
  items: FocusRow[];
  max: number;
  carryover: string[];
  error?: string;
};

function weekLabel(week: string): string {
  const [, m, d] = week.split("-");
  const end = new Date(`${week}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const [, em, ed] = end.toISOString().slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}〜${Number(em)}/${Number(ed)}`;
}

export default function WeeklyFocusCard() {
  const [data, setData] = useState<Res | null>(null);
  const [failed, setFailed] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showCarry, setShowCarry] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/weekly-focus", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData(await r.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(text?: string) {
    const content = (text ?? input).trim();
    if (!content || adding) return;
    setAdding(true);
    setErr(null);
    try {
      const r = await fetch("/api/weekly-focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? "追加に失敗しました");
      if (!text) setInput("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: string, body: { content?: string; done?: boolean }) {
    setBusy(id);
    setErr(null);
    try {
      const r = await fetch("/api/weekly-focus", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      if (!r.ok) throw new Error("更新に失敗しました");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: FocusRow) {
    if (!window.confirm(`「${row.content}」を今週の一覧から消します。よろしいですか？`)) return;
    setBusy(row.id);
    setErr(null);
    try {
      const r = await fetch(`/api/weekly-focus?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("削除に失敗しました");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  // 取れない日もカードの枠は残す。今週の的を書き足す窓口はここにしか無いので、
  // 黙って消すと「書こうと思ったのに入口が無い」になる（消えた理由も分からない）。
  if (failed) {
    return (
      <section className="mb-6 rounded-2xl border-2 border-indigo-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-gray-900">🎯 今週おこなうこと</p>
        <p className="mt-1 text-sm text-gray-500">読み込めませんでした</p>
        <button
          type="button"
          onClick={load}
          className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-bold text-gray-600 transition active:bg-gray-50"
        >
          再読み込み
        </button>
      </section>
    );
  }
  if (!data) {
    return <div className="mb-6 h-[136px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />;
  }

  const { items, max, carryover } = data;
  const doneCount = items.filter((i) => i.done).length;
  const full = items.length >= max;

  return (
    <section className="mb-6 rounded-2xl border-2 border-indigo-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">🎯 今週おこなうこと</p>
        <p className="text-xs font-bold text-gray-400">
          {weekLabel(data.week_start)}
          <span className="ml-1.5 text-gray-500">
            {doneCount}/{items.length}
          </span>
        </p>
      </div>

      {items.length === 0 ? (
        <p className="mb-2 rounded-xl bg-gray-50 px-3 py-3 text-sm text-gray-500">
          今週やることをまだ決めていません。5つまで書けます。
        </p>
      ) : (
        <ol className="mb-2 space-y-1.5">
          {items.map((row) => (
            <li
              key={row.id}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                row.done ? "border-gray-100 bg-gray-50" : "border-indigo-100 bg-indigo-50/40"
              } ${busy === row.id ? "opacity-50" : ""}`}
            >
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => patch(row.id, { done: !row.done })}
                aria-label={row.done ? "未完に戻す" : "完了にする"}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs transition active:scale-90 ${
                  row.done
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-gray-300 bg-white text-transparent"
                }`}
              >
                ✓
              </button>

              {editId === row.id ? (
                <span className="flex min-w-0 flex-1 gap-1.5">
                  <input
                    type="text"
                    value={editText}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      // isComposing中のEnterは日本語変換の確定。ここで保存すると
                      // 変換を確定しただけのつもりが編集終了になってしまう
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && editText.trim()) {
                        patch(row.id, { content: editText.trim() });
                        setEditId(null);
                      }
                      if (e.key === "Escape") setEditId(null);
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-indigo-400 px-2 py-1 text-sm text-gray-900"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (editText.trim()) patch(row.id, { content: editText.trim() });
                      setEditId(null);
                    }}
                    className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-bold text-white"
                  >
                    保存
                  </button>
                </span>
              ) : (
                <span
                  onClick={() => {
                    setEditId(row.id);
                    setEditText(row.content);
                  }}
                  className={`min-w-0 flex-1 cursor-text text-sm leading-snug ${
                    row.done ? "text-gray-400 line-through" : "text-gray-900"
                  }`}
                >
                  {row.content}
                </span>
              )}

              {editId !== row.id && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => remove(row)}
                  aria-label="消す"
                  className="mt-0.5 shrink-0 rounded-md px-1 text-gray-300 transition active:bg-gray-100 active:text-rose-500"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* 5件そろったら入力欄を出さない。上限を柔らかく破らせない */}
      {full ? (
        <p className="text-xs text-gray-400">
          5件そろっています。入れ替えるときは、どれかを消してから足してください。
        </p>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 日本語変換の確定Enterで誤送信しない（isComposing中は無視）
              if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
            }}
            disabled={adding}
            placeholder={`今週やることを書く（あと${max - items.length}件）`}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => add()}
            disabled={adding || !input.trim()}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition active:bg-indigo-700 disabled:opacity-40"
          >
            追加
          </button>
        </div>
      )}

      {err && <p className="mt-1.5 text-xs text-red-600">{err}</p>}

      {/* 週が変わると一覧は空で始まる。やり残しが黙って消えたように見えないよう、
          先週の未完だけは名前で出して、押せば今週へ持ってこられるようにする。 */}
      {carryover.length > 0 && !full && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowCarry((v) => !v)}
            className="text-xs font-medium text-gray-400 underline active:opacity-70"
          >
            先週やり残した{carryover.length}件を見る
          </button>
          {showCarry && (
            <ul className="mt-1.5 space-y-1">
              {carryover.map((text, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-600">{text}</span>
                  <button
                    type="button"
                    disabled={adding}
                    onClick={() => add(text)}
                    className="shrink-0 rounded-full border border-indigo-300 px-2 py-0.5 text-[0.6875rem] font-semibold text-indigo-700 active:bg-indigo-50"
                  >
                    今週へ
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
