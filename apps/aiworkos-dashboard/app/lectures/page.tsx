"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

// 講座アーカイブ。受講した生成AI講座の録画URL・パスコード・学びを1枚で。
//
// 元は GitHub Pages の単体ページで、データが各端末の localStorage にしか
// 無かった（Macで登録した講座がiPhoneで見えない）。Supabaseへ移したので、
// どの端末からでも同じ一覧が見える。

type Lecture = {
  id: string;
  instructor: string;
  title: string;
  lecture_date: string | null;
  platform: string;
  url: string | null;
  passcode: string | null;
  material_url: string | null;
  audio_url: string | null;
  note: string | null;
  insight: string | null;
};

type Draft = {
  instructor: string;
  title: string;
  lecture_date: string;
  platform: string;
  url: string;
  passcode: string;
  material_url: string;
  audio_url: string;
  note: string;
  insight: string;
};

const EMPTY: Draft = {
  instructor: "",
  title: "",
  lecture_date: "",
  platform: "youtube",
  url: "",
  passcode: "",
  material_url: "",
  audio_url: "",
  note: "",
  insight: "",
};

const PLATFORMS = [
  { value: "youtube", label: "YouTube", icon: "▶️" },
  { value: "zoom", label: "Zoom", icon: "💻" },
  { value: "vimeo", label: "Vimeo", icon: "🎬" },
  { value: "other", label: "その他", icon: "🔗" },
] as const;

function iconOf(platform: string): string {
  return PLATFORMS.find((p) => p.value === platform)?.icon ?? "🔗";
}

function labelOf(platform: string): string {
  return PLATFORMS.find((p) => p.value === platform)?.label ?? "その他";
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${y}/${Number(m)}/${Number(day)}`;
}

export default function LecturesPage() {
  const [rows, setRows] = useState<Lecture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [instructorFilter, setInstructorFilter] = useState<string>("すべて");
  const [q, setQ] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 削除は取り返しがつかないので、対象を一度確認してから消す。
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/lectures", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setRows(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const instructors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.instructor, (counts.get(r.instructor) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (instructorFilter !== "すべて" && r.instructor !== instructorFilter) return false;
      if (!needle) return true;
      return [r.title, r.instructor, r.note, r.insight]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(needle));
    });
  }, [rows, instructorFilter, q]);

  function openNew() {
    setEditingId(null);
    setDraft(EMPTY);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(r: Lecture) {
    setEditingId(r.id);
    setDraft({
      instructor: r.instructor,
      title: r.title,
      lecture_date: r.lecture_date ?? "",
      platform: r.platform,
      url: r.url ?? "",
      passcode: r.passcode ?? "",
      material_url: r.material_url ?? "",
      audio_url: r.audio_url ?? "",
      note: r.note ?? "",
      insight: r.insight ?? "",
    });
    setFormError(null);
    setShowForm(true);
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/lectures", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { ...draft, id: editingId } : draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました");
      setShowForm(false);
      setEditingId(null);
      setDraft(EMPTY);
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/lectures?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました");
      setConfirmDelete(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  function field(
    key: keyof Draft,
    label: string,
    opts?: { type?: string; rows?: number; placeholder?: string }
  ) {
    const common =
      "mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50";
    return (
      <div>
        <label className="block text-sm font-medium text-gray-600">{label}</label>
        {opts?.rows ? (
          <textarea
            value={draft[key]}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
            disabled={saving}
            rows={opts.rows}
            placeholder={opts.placeholder}
            className={common}
          />
        ) : (
          <input
            type={opts?.type ?? "text"}
            value={draft[key]}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
            disabled={saving}
            placeholder={opts?.placeholder}
            className={common}
          />
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          講座アーカイブ
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          受講した生成AI講座の録画・資料・学びを1枚で。どの端末からでも同じ一覧が見えます
        </p>
      </header>

      <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-gray-700">{rows.length} 件</span>
          <button
            type="button"
            onClick={openNew}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white active:scale-95"
          >
            講座を登録
          </button>
        </div>

        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="講座名・講師名・メモで検索"
          className="mt-3 block w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />

        <div className="mt-3 flex flex-wrap gap-1.5">
          {[["すべて", rows.length] as const, ...instructors].map(([name, n]) => (
            <button
              key={name}
              type="button"
              onClick={() => setInstructorFilter(name)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                instructorFilter === name
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 active:bg-gray-200"
              }`}
            >
              {name} {n}
            </button>
          ))}
        </div>

        {showForm && (
          <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field("instructor", "講師名", { placeholder: "例: 越川慎司" })}
              {field("title", "講座名")}
              {field("lecture_date", "講義日（任意）", { type: "date" })}
              <div>
                <label className="block text-sm font-medium text-gray-600">種別</label>
                <select
                  value={draft.platform}
                  onChange={(e) => setDraft((d) => ({ ...d, platform: e.target.value }))}
                  disabled={saving}
                  className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
                >
                  {PLATFORMS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {field("url", "アーカイブURL")}
              {field("passcode", "パスコード（任意）")}
              {field("material_url", "資料URL（任意）")}
              {field("audio_url", "音声録画URL（任意）")}
            </div>
            {field("note", "メモ（任意）", { rows: 2 })}
            {field("insight", "学び・示唆（任意）", { rows: 3 })}

            {formError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {formError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white active:scale-95 disabled:opacity-50"
              >
                {saving ? "保存中…" : editingId ? "更新する" : "登録する"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                  setFormError(null);
                }}
                disabled={saving}
                className="rounded-full bg-gray-100 px-4 py-2 text-sm text-gray-600 active:scale-95 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {visible.length === 0 ? (
            <p className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-400 shadow-sm">
              該当する講座はありません
            </p>
          ) : (
            visible.map((r) => (
              <div
                key={r.id}
                className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold leading-snug text-gray-900">
                      {iconOf(r.platform)} {r.title}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {r.instructor}
                      <span className="mx-1.5 text-gray-300">|</span>
                      {labelOf(r.platform)}
                      {r.lecture_date && (
                        <>
                          <span className="mx-1.5 text-gray-300">|</span>
                          {fmtDate(r.lecture_date)}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => openEdit(r)}
                      className="text-xs text-indigo-500 active:opacity-70"
                    >
                      編集
                    </button>
                    <button
                      onClick={() => setConfirmDelete(r.id)}
                      className="text-xs text-gray-400 active:opacity-70"
                    >
                      削除
                    </button>
                  </div>
                </div>

                {r.passcode && (
                  <p className="mt-2 text-xs text-gray-600">
                    🔑 <span className="select-all font-mono">{r.passcode}</span>
                  </p>
                )}

                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 underline active:opacity-70"
                    >
                      録画を開く
                    </a>
                  )}
                  {r.material_url && (
                    <a
                      href={r.material_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 underline active:opacity-70"
                    >
                      資料
                    </a>
                  )}
                  {r.audio_url && (
                    <a
                      href={r.audio_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 underline active:opacity-70"
                    >
                      音声
                    </a>
                  )}
                </div>

                {r.note && <p className="mt-2 text-xs text-gray-400">{r.note}</p>}
                {r.insight && (
                  <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
                    🧠 {r.insight}
                  </div>
                )}

                {confirmDelete === r.id && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2">
                    <span className="text-xs text-rose-800">この講座を削除しますか？</span>
                    <button
                      onClick={() => remove(r.id)}
                      disabled={saving}
                      className="rounded-full bg-rose-600 px-3 py-1 text-xs font-medium text-white active:scale-95 disabled:opacity-50"
                    >
                      削除する
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      disabled={saving}
                      className="rounded-full bg-white px-3 py-1 text-xs text-gray-600 active:scale-95"
                    >
                      やめる
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}
