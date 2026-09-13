"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { starsText } from "@/lib/ramen";

// 食べたものを1枚で見渡すページ。/ramen の「通算杯数」から来る。
//
// /ramen 本体は「いま手を動かす一杯」を回すための画面で、1杯あたりの情報が多く、
// 過去を遡るには延々スクロールすることになる。こちらは逆に、1杯あたりを
// 日付・杯番号・★・店名・写真1枚だけに絞って、並べて見るためのもの。
//
// 写真が複数ある杯は1枚目だけを使う（月次の「思い出の4枚」と違い、
// ここは探すための一覧なので、1杯1枚に揃っている方が目で追える）。

type Log = {
  id: number;
  eaten_on: string;
  bowl_no: number | null;
  bowl_label: string | null;
  shop: string;
  area: string | null;
  menu: string | null;
  stars: number | null;
  stars_label: string | null;
  score: number | null;
  photo_urls: string[] | null;
  is_ramen: boolean;
};

const C_BOWL = "#eb6834";

type FilterKey = "all" | "ramen" | "photo";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "ramen", label: "ラーメンのみ" },
  { key: "photo", label: "写真ありのみ" },
];

const WD = ["日", "月", "火", "水", "木", "金", "土"];

function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${m}/${day}（${WD[new Date(y, m - 1, day).getDay()] ?? ""}）`;
}

function fmtMonthHead(ym: string) {
  const [y, m] = ym.split("-");
  return `${y}年${Number(m)}月`;
}

// 一覧は縮小版で出す。原寸は1枚0.7〜1MBあり、200件並べると端末が持たない。
function photoUrl(path: string, width?: 480 | 1280) {
  const w = width ? `&w=${width}` : "";
  return `/api/ramen/photo?path=${encodeURIComponent(path)}${w}`;
}

function Card({ log, onZoom }: { log: Log; onZoom: (p: string) => void }) {
  const photo = (log.photo_urls ?? [])[0] ?? null;
  const star = starsText(log.stars, log.stars_label);

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {photo ? (
        <button
          type="button"
          onClick={() => onZoom(photo)}
          className="block w-full active:opacity-80"
          aria-label={`${log.shop} の写真を大きく見る`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(photo, 480)}
            alt={log.shop}
            loading="lazy"
            decoding="async"
            className="aspect-square w-full bg-gray-100 object-cover"
          />
        </button>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center bg-gray-50 text-2xl text-gray-300">
          {log.is_ramen ? "🍜" : "🍽"}
        </div>
      )}

      <div className="p-2">
        <div className="flex items-center gap-1">
          <span className="text-[0.6875rem] font-bold text-gray-500">
            {fmtDate(log.eaten_on)}
          </span>
          {log.bowl_no != null && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[0.625rem] font-bold text-white"
              style={{ backgroundColor: C_BOWL }}
            >
              {log.bowl_no}杯目
            </span>
          )}
        </div>
        {star && (
          <p className="mt-0.5 text-[0.6875rem] font-bold leading-none text-orange-700">
            {star}
          </p>
        )}
        <p className="mt-1 text-xs font-bold leading-snug text-gray-900">{log.shop}</p>
      </div>
    </div>
  );
}

export default function RamenAllPage() {
  const [items, setItems] = useState<Log[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/ramen", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d?.error ?? `status ${res.status}`);
      setItems(d.items ?? []);
    } catch {
      setError("ラーメン記録の取得に失敗しました");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    let all = items ?? [];
    if (filter === "ramen") all = all.filter((i) => i.is_ramen);
    if (filter === "photo") all = all.filter((i) => (i.photo_urls ?? []).length > 0);
    // 新しい順。同じ日に複数あるときは杯番号の大きい方（後に食べた方）を先に出す
    return [...all].sort((a, b) => {
      if (a.eaten_on !== b.eaten_on) return a.eaten_on < b.eaten_on ? 1 : -1;
      return (b.bowl_no ?? 0) - (a.bowl_no ?? 0);
    });
  }, [items, filter]);

  // 月ごとに区切る。1枚で見渡すページなので、どこを見ているか分かる目印が要る
  const byMonth = useMemo(() => {
    const map = new Map<string, Log[]>();
    for (const i of shown) {
      const ym = i.eaten_on.slice(0, 7);
      const list = map.get(ym) ?? [];
      list.push(i);
      map.set(ym, list);
    }
    return Array.from(map.entries());
  }, [shown]);

  const stats = useMemo(() => {
    const all = items ?? [];
    const bowls = all.map((i) => i.bowl_no).filter((n): n is number => n != null);
    return {
      total: all.length,
      latestBowl: bowls.length ? Math.max(...bowls) : null,
      withPhoto: all.filter((i) => (i.photo_urls ?? []).length > 0).length,
    };
  }, [items]);

  const loading = !items && !error;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-4">
        <Link href="/ramen" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ラーメン
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          🍜 食べたもの全部
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          {stats.latestBowl != null && (
            <>
              通算<span className="font-bold text-gray-900">{stats.latestBowl}</span>杯目まで・
            </>
          )}
          記録{stats.total}件・写真つき{stats.withPhoto}杯
        </p>
      </header>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <p>{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-full bg-rose-600 px-3 py-1 text-xs font-bold text-white active:scale-95"
          >
            再読み込み
          </button>
        </div>
      )}

      {/* 一覧の上に固定。200件をスクロールしている途中でも絞り込みに戻れる */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 flex items-center gap-2 bg-white/90 px-4 py-2 backdrop-blur">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
              filter === f.key
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 ring-1 ring-gray-200"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-400">{shown.length}件</span>
      </div>

      {loading && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      )}

      {byMonth.map(([ym, rows]) => (
        <section key={ym} className="mb-6">
          <h2 className="mb-2 text-sm font-bold text-gray-500">
            {fmtMonthHead(ym)}
            <span className="ml-2 font-normal text-gray-400">{rows.length}件</span>
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {rows.map((log) => (
              <Card key={log.id} log={log} onZoom={setZoom} />
            ))}
          </div>
        </section>
      ))}

      {!loading && shown.length === 0 && !error && (
        <p className="py-12 text-center text-sm text-gray-400">この条件の記録はありません</p>
      )}

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(zoom, 1280)}
            alt=""
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}

      <div className="mt-8 text-center">
        <Link href="/ramen" className="text-sm text-indigo-500 active:opacity-70">
          ← ラーメンに戻る
        </Link>
      </div>
    </main>
  );
}
