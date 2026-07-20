"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// ホーム上部の「朝のリマインダー」。未完の やってみよう/本日のポイント を出す。
// 携帯でアプリを開いた時に、その日やることが自然に目に入るようにするのが目的。
// 未完が0件のときは何も出さない（余計なノイズを増やさない）。

type Item = {
  id: string;
  entry_date: string;
  kind: "action" | "point";
  content: string;
  done: boolean;
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${m}/${day}（${wd}）`;
}

export default function TodoReminder() {
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/actions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => {
        if (alive) setItems(Array.isArray(d.items) ? d.items : []);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!items) return null; // 読み込み中は出さない（レイアウトのちらつき防止）
  const undone = items.filter((x) => !x.done);
  if (undone.length === 0) return null; // 未完なし＝リマインダー不要

  // 古い順（前からの積み残しを上に）に最大4件プレビュー
  const preview = [...undone]
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0))
    .slice(0, 4);

  return (
    <Link
      href="/actions"
      className="mb-6 block rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm transition active:bg-amber-100"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-base font-bold text-amber-900">
          🔔 未完のやってみよう
          <span className="rounded-full bg-amber-600 px-2 py-0.5 text-xs font-bold text-white">
            {undone.length}
          </span>
        </span>
        <span className="text-sm font-medium text-amber-600">すべて見る →</span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {preview.map((it) => (
          <li key={it.id} className="flex items-start gap-2 text-sm text-amber-900">
            <span className="mt-0.5 text-amber-400" aria-hidden>
              {it.kind === "point" ? "📌" : "◻︎"}
            </span>
            <span className="min-w-0 flex-1 leading-relaxed">
              <span className="mr-1.5 font-mono text-xs text-amber-500">
                {fmtDate(it.entry_date)}
              </span>
              {it.content}
            </span>
          </li>
        ))}
      </ul>
      {undone.length > preview.length && (
        <p className="mt-2 text-xs text-amber-600">
          ほか {undone.length - preview.length} 件
        </p>
      )}
    </Link>
  );
}
