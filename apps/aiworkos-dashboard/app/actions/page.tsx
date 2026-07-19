"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

// 日々のToDo：一行日記の「やってみよう」「本日のポイント」を日付ごとに積み上げ、
// チェックで消し込み・編集・手動追加ができるページ。データは /api/actions（Supabase）。

type Kind = "action" | "point";
type Item = {
  id: string;
  entry_date: string; // YYYY-MM-DD
  kind: Kind;
  content: string;
  done: boolean;
  source: "diary" | "manual";
  source_id: string | null;
};

const KIND_META: Record<Kind, { label: string; icon: string; klass: string }> = {
  action: { label: "やってみよう", icon: "🎯", klass: "text-emerald-700 bg-emerald-50" },
  point: { label: "本日のポイント", icon: "📌", klass: "text-amber-700 bg-amber-50" },
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${m}/${day}（${wd}）`;
}
function todayStr(): string {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

export default function ActionsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(false);

  // 追加フォーム
  const [addDate, setAddDate] = useState(todayStr());
  const [addKind, setAddKind] = useState<Kind>("action");
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);

  // 編集中
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // 日記からの取込
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/actions", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleDone(it: Item) {
    // 楽観更新
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)));
    const res = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, done: !it.done }),
    });
    if (!res.ok) load(); // 失敗したらサーバ状態に戻す
  }

  async function saveEdit() {
    if (!editId) return;
    const text = editText.trim();
    if (!text) return;
    setItems((prev) => prev.map((x) => (x.id === editId ? { ...x, content: text } : x)));
    const id = editId;
    setEditId(null);
    const res = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, content: text }),
    });
    if (!res.ok) load();
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
    const res = await fetch(`/api/actions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) load();
  }

  async function syncDiary() {
    if (syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const res = await fetch("/api/actions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookback_days: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取込に失敗しました");
      setNotice(
        data.added > 0
          ? `日記から ${data.added} 件を取り込みました`
          : "新しく取り込む日記はありませんでした"
      );
      if (data.added > 0) await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "取込に失敗しました");
    } finally {
      setSyncing(false);
    }
  }

  async function addItem() {
    const text = addText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_date: addDate, kind: addKind, content: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "追加に失敗しました");
      setItems((prev) => [data.item, ...prev]);
      setAddText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setAdding(false);
    }
  }

  // 日付でグルーピング（新しい順）
  const groups = useMemo(() => {
    const shown = hideDone ? items.filter((x) => !x.done) : items;
    const byDate = new Map<string, Item[]>();
    for (const it of shown) {
      if (!byDate.has(it.entry_date)) byDate.set(it.entry_date, []);
      byDate.get(it.entry_date)!.push(it);
    }
    return Array.from(byDate.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [items, hideDone]);

  const remaining = items.filter((x) => !x.done).length;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/"
          className="rounded-lg px-2 py-1 text-sm font-medium text-gray-500 transition active:bg-gray-100"
        >
          ← ホーム
        </Link>
      </div>

      <header className="mb-5">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">日々のToDo</h1>
          <button
            type="button"
            onClick={syncDiary}
            disabled={syncing}
            className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700 transition active:bg-emerald-100 disabled:opacity-50"
          >
            {syncing ? "取込中…" : "📓 日記から取込"}
          </button>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          一行日記の「やってみよう」「本日のポイント」を積み上げ。チェックで消し込み、あとから編集も。
        </p>
        {notice && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </p>
        )}
      </header>

      {/* 追加フォーム */}
      <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700"
          />
          <div className="flex overflow-hidden rounded-lg border border-gray-300">
            {(["action", "point"] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setAddKind(k)}
                className={`px-3 py-1.5 text-sm font-medium transition ${
                  addKind === k ? "bg-emerald-600 text-white" : "bg-white text-gray-500"
                }`}
              >
                {KIND_META[k].icon} {KIND_META[k].label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addItem();
            }}
            placeholder="やること・ポイントを入力してEnter"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={addItem}
            disabled={adding || !addText.trim()}
            className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
          >
            追加
          </button>
        </div>
      </section>

      {/* フィルタ・件数 */}
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="text-sm text-gray-500">
          未完 <b className="text-gray-800">{remaining}</b> 件
        </span>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-500">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="h-4 w-4 accent-emerald-600"
          />
          完了を隠す
        </label>
      </div>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {error && (
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}
      {!loading && !error && groups.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-400">
          まだありません。上のフォームから追加できます。
        </p>
      )}

      <div className="space-y-6">
        {groups.map(([date, its]) => (
          <section key={date}>
            <h2 className="mb-2 px-1 text-sm font-bold text-gray-700">{fmtDate(date)}</h2>
            <div className="space-y-2">
              {its.map((it) => {
                const meta = KIND_META[it.kind];
                const editing = editId === it.id;
                return (
                  <div
                    key={it.id}
                    className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm"
                  >
                    <button
                      type="button"
                      onClick={() => toggleDone(it)}
                      aria-label={it.done ? "未完に戻す" : "完了にする"}
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition ${
                        it.done
                          ? "border-emerald-600 bg-emerald-600 text-white"
                          : "border-gray-300 text-transparent active:border-emerald-400"
                      }`}
                    >
                      ✓
                    </button>

                    <div className="min-w-0 flex-1">
                      <span
                        className={`mb-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${meta.klass}`}
                      >
                        {meta.icon} {meta.label}
                      </span>
                      {editing ? (
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={editText}
                            autoFocus
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveEdit();
                              if (e.key === "Escape") setEditId(null);
                            }}
                            className="min-w-0 flex-1 rounded-lg border border-emerald-400 px-2 py-1 text-sm"
                          />
                          <button
                            type="button"
                            onClick={saveEdit}
                            className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1 text-sm font-medium text-white"
                          >
                            保存
                          </button>
                        </div>
                      ) : (
                        <p
                          onClick={() => {
                            setEditId(it.id);
                            setEditText(it.content);
                          }}
                          className={`cursor-text text-sm leading-relaxed ${
                            it.done ? "text-gray-400 line-through" : "text-gray-800"
                          }`}
                        >
                          {it.content}
                        </p>
                      )}
                    </div>

                    {!editing && (
                      <button
                        type="button"
                        onClick={() => remove(it.id)}
                        aria-label="削除"
                        className="mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-gray-300 transition active:bg-gray-100 active:text-rose-500"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
