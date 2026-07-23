"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import NotificationOptIn from "@/app/components/NotificationOptIn";

// 日々のToDo：一行日記の「やってみよう」「本日のポイント」を週単位で積み上げ、
// チェックすると「済み」一覧へ移動して未完リストは行詰めされる。データは /api/actions（Supabase）。

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
function pad(x: number) {
  return String(x).padStart(2, "0");
}
function keyOf(dt: Date) {
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function todayStr() {
  return keyOf(new Date());
}
function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${m}/${day}（${wd}）`;
}
// その日が属する週の月曜日を返す
function weekMonday(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  const dow = (dt.getDay() + 6) % 7; // 月=0 … 日=6
  dt.setDate(dt.getDate() - dow);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
// 週見出しラベル（今週/先週/N週前 ＋ 範囲）
function weekLabel(mondayKey: string): string {
  const [y, m, d] = mondayKey.split("-").map(Number);
  const mon = new Date(y, m - 1, d);
  const sun = new Date(y, m - 1, d + 6);
  const thisMon = weekMonday(todayStr());
  const diff = Math.round((thisMon.getTime() - mon.getTime()) / (7 * 86400000));
  const range = `${mon.getMonth() + 1}/${mon.getDate()}〜${sun.getMonth() + 1}/${sun.getDate()}`;
  let prefix = "";
  if (diff === 0) prefix = "今週 ";
  else if (diff === 1) prefix = "先週 ";
  else if (diff > 1) prefix = `${diff}週前 `;
  else if (diff < 0) prefix = "来週 ";
  return prefix + range;
}

export default function ActionsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);

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

  // 一括完了
  const [bulkBusy, setBulkBusy] = useState(false);

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
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)));
    const res = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, done: !it.done }),
    });
    if (!res.ok) load();
  }

  async function saveEdit() {
    if (!editId) return;
    const text = editText.trim();
    if (!text) return;
    const id = editId;
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, content: text } : x)));
    setEditId(null);
    const res = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, content: text }),
    });
    if (!res.ok) load();
  }

  // 複数件をまとめて完了にする（楽観的更新→PATCH一括、失敗時はload()でロールバック）
  async function completeMany(ids: string[]) {
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    const idSet = new Set(ids);
    setItems((prev) => prev.map((x) => (idSet.has(x.id) ? { ...x, done: true } : x)));
    try {
      const res = await fetch("/api/actions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, done: true }),
      });
      if (!res.ok) throw new Error("一括更新に失敗しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : "一括更新に失敗しました");
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  function completeAll() {
    const ids = items.filter((x) => !x.done).map((x) => x.id);
    if (ids.length === 0) return;
    if (!window.confirm(`未完${ids.length}件をすべて完了にします。よろしいですか？`)) return;
    completeMany(ids);
  }

  function completeWeek(its: Item[]) {
    const ids = its.map((x) => x.id);
    if (ids.length === 0) return;
    if (!window.confirm(`この週の未完${ids.length}件を完了にします。よろしいですか？`)) return;
    completeMany(ids);
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
    const res = await fetch(`/api/actions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) load();
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

  // 未完＝週単位でグルーピング（新しい週が上）。週内は日付降順→種別。
  const activeWeeks = useMemo(() => {
    const active = items.filter((x) => !x.done);
    const byWeek = new Map<string, Item[]>();
    for (const it of active) {
      const wk = keyOf(weekMonday(it.entry_date));
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk)!.push(it);
    }
    for (const arr of byWeek.values()) {
      arr.sort((a, b) =>
        a.entry_date !== b.entry_date
          ? a.entry_date < b.entry_date
            ? 1
            : -1
          : a.kind < b.kind
            ? -1
            : a.kind > b.kind
              ? 1
              : 0
      );
    }
    return Array.from(byWeek.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [items]);

  const doneItems = useMemo(
    () => items.filter((x) => x.done).sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1)),
    [items]
  );
  const remaining = items.length - doneItems.length;

  function renderItem(it: Item) {
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
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${meta.klass}`}>
              {meta.icon} {meta.label}
            </span>
            <span className="text-[11px] text-gray-400">{fmtDate(it.entry_date)}</span>
          </div>
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
  }

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
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={syncDiary}
              disabled={syncing}
              className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700 transition active:bg-emerald-100 disabled:opacity-50"
            >
              {syncing ? "取込中…" : "📓 日記から取込"}
            </button>
            {remaining > 0 && (
              <button
                type="button"
                onClick={completeAll}
                disabled={bulkBusy}
                className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-600 transition active:bg-gray-100 disabled:opacity-50"
              >
                {bulkBusy ? "処理中…" : `✓ 未完${remaining}件をすべて完了に`}
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          「やってみよう」「本日のポイント」を週単位で積み上げ。チェックすると「済み」へ移動します。
        </p>
        {notice && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
        )}
      </header>

      <NotificationOptIn />

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

      <div className="mb-3 px-1 text-sm text-gray-500">
        未完 <b className="text-gray-800">{remaining}</b> 件 ・ 済み{" "}
        <b className="text-gray-800">{doneItems.length}</b> 件
      </div>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {error && <p className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
      {!loading && !error && activeWeeks.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-400">
          未完はありません。上のフォームから追加、または「日記から取込」できます。
        </p>
      )}

      {/* 未完：週単位 */}
      <div className="space-y-6">
        {activeWeeks.map(([wk, its]) => (
          <section key={wk}>
            <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold text-gray-700">
              {weekLabel(wk)}
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                {its.length}
              </span>
              <button
                type="button"
                onClick={() => completeWeek(its)}
                disabled={bulkBusy}
                className="ml-auto shrink-0 rounded-full border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-400 transition active:bg-gray-100 active:text-emerald-700 disabled:opacity-50"
              >
                この週をすべて完了
              </button>
            </h2>
            <div className="space-y-2">{its.map(renderItem)}</div>
          </section>
        ))}
      </div>

      {/* 済み一覧（折りたたみ） */}
      {doneItems.length > 0 && (
        <section className="mt-8">
          <button
            type="button"
            onClick={() => setDoneOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-sm font-bold text-gray-500 transition active:bg-gray-50"
          >
            <span>{doneOpen ? "▼" : "▶"}</span>
            ✓ 済み
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              {doneItems.length}
            </span>
          </button>
          {doneOpen && <div className="mt-2 space-y-2 opacity-80">{doneItems.map(renderItem)}</div>}
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
