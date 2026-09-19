"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PHOTO_RENDER_VERSION } from "@/lib/ramen";
import { BOWL_STYLES, BOWL_TASTES } from "@/lib/ramenBowlType.mjs";

// 味・系統が決まっていない杯を、1杯ずつ本人が選ぶ画面。
//
// 本文からの自動判定では6割しか決まらない（2026-09-19 時点で70杯が未設定）。
// 残りは本人しか分からないので、写真・店名・メニュー・本文の一部を見せて、
// 9つから押すだけで次へ進む形にする（iPhoneで電車の中で片づけられるように）。
//
// 選ぶと /api/ramen/update に bowl_taste として保存され、その杯は列から消える。
// 「分からない」は後回し（この画面を開いている間だけ末尾へ回す。保存はしない）。
// 形態（つけ麺・まぜそば…）の自動判定が違っていれば、ここで一緒に直せる。

type Row = {
  id: number;
  eaten_on: string;
  bowl_no: number | null;
  shop: string;
  area: string | null;
  genre: string | null;
  menu: string | null;
  title: string | null;
  excerpt: string | null;
  memo: string | null;
  photo_urls: string[] | null;
  style: string;
  bowl_style: string | null;
};

const C_BOWL = "#eb6834";
const WD = ["日", "月", "火", "水", "木", "金", "土"];

function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${y}/${m}/${day}（${WD[new Date(y, m - 1, day).getDay()] ?? ""}）`;
}

function photoUrl(path: string, width: 480 | 1280) {
  return `/api/ramen/photo?path=${encodeURIComponent(path)}&w=${width}&v=${PHOTO_RENDER_VERSION}`;
}

export default function RamenTastePage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  // 「分からない」で後回しにした id。列の末尾へ回す
  const [skipped, setSkipped] = useState<number[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/ramen?view=taste", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d?.error ?? `status ${res.status}`);
      const items: Row[] = d.items ?? [];
      setRows(items);
      setTotal((t) => (t === 0 ? items.length : t));
    } catch {
      setError("読み込めませんでした");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 後回しにした杯は末尾へ。全部後回しになったら先頭から再び出す
  const queue = useMemo(() => {
    if (!rows) return [];
    const head = rows.filter((r) => !skipped.includes(r.id));
    const tail = skipped.map((id) => rows.find((r) => r.id === id)).filter((r): r is Row => !!r);
    return [...head, ...tail];
  }, [rows, skipped]);
  const current = queue[0] ?? null;

  async function save(field: "bowl_taste" | "bowl_style", value: string) {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ramen/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: current.id, [field]: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `失敗しました（${res.status}）`);
      if (field === "bowl_taste") {
        // 味が付いた杯は列から外す（取り直さなくても次へ進める）
        setRows((prev) => (prev ?? []).filter((r) => r.id !== current.id));
        setSkipped((prev) => prev.filter((id) => id !== current.id));
        setDone((n) => n + 1);
      } else {
        setRows((prev) =>
          (prev ?? []).map((r) => (r.id === current.id ? { ...r, style: value, bowl_style: value } : r))
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function skip() {
    if (!current) return;
    setSkipped((prev) => [...prev.filter((id) => id !== current.id), current.id]);
  }

  const loading = !rows && !error;
  const photos = current?.photo_urls ?? [];
  const remaining = queue.length;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-4">
        <Link href="/ramen" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ラーメン
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">🍜 味を選ぶ</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          本文から味が読み取れなかった杯。写真とメニューを見て、味・系統を押すと次の杯へ進みます。
        </p>
      </header>

      {error && (
        <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
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

      {loading && <div className="h-96 animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />}

      {rows && (
        <div className="mb-3 flex items-center gap-3" data-testid="taste-progress">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full transition-all"
              style={{ width: `${total ? (done / total) * 100 : 0}%`, backgroundColor: C_BOWL }}
            />
          </div>
          <span className="shrink-0 text-xs text-gray-500">
            <span className="font-bold text-gray-900">{done}</span> / {total} 済み・残り {remaining}
          </span>
        </div>
      )}

      {rows && !current && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="text-lg font-bold text-emerald-800">全部つきました 🎉</p>
          <p className="mt-1 text-sm text-emerald-700">
            <Link href="/ramen" className="underline">
              ラーメンの「ジャンル別」
            </Link>
            で集計に入っています。
          </p>
        </section>
      )}

      {current && (
        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm" data-testid="taste-card">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="font-bold text-gray-700">{fmtDate(current.eaten_on)}</span>
            {current.bowl_no != null && (
              <span className="rounded-full px-2 py-0.5 font-bold text-white" style={{ backgroundColor: C_BOWL }}>
                {current.bowl_no}杯目
              </span>
            )}
            <span className="ml-auto text-gray-400">#{current.id}</span>
          </div>
          <h2 className="mt-1 text-lg font-bold leading-snug text-gray-900">{current.shop}</h2>
          <p className="mt-0.5 text-xs text-gray-500">{[current.area, current.genre].filter(Boolean).join(" / ")}</p>

          {photos.length > 0 && (
            <div className={`mt-3 grid gap-1 ${photos.length === 1 ? "grid-cols-1" : "grid-cols-3"}`}>
              {photos.slice(0, 3).map((p) => (
                <button key={p} type="button" onClick={() => setZoom(p)} className="active:opacity-80">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoUrl(p, photos.length === 1 ? 1280 : 480)}
                    alt={current.shop}
                    loading="eager"
                    className={`w-full rounded-lg bg-gray-100 object-cover ${
                      photos.length === 1 ? "max-h-72" : "aspect-square"
                    }`}
                  />
                </button>
              ))}
            </div>
          )}

          {current.menu && (
            <p className="mt-3 text-sm font-medium text-gray-800">
              <span className="mr-1 text-xs font-bold text-gray-400">メニュー</span>
              {current.menu}
            </p>
          )}
          {current.title && <p className="mt-2 text-sm font-bold leading-snug text-gray-800">「{current.title}」</p>}
          {current.memo && (
            <p className="mt-1 rounded-lg bg-gray-50 p-2 text-sm leading-relaxed text-gray-600">
              <span className="mr-1 text-xs font-bold text-gray-400">メモ</span>
              {current.memo.length > 160 ? `${current.memo.slice(0, 160)}…` : current.memo}
            </p>
          )}
          {current.excerpt && (
            <p className="mt-1 text-sm leading-relaxed text-gray-600">
              {current.excerpt.length > 200 ? `${current.excerpt.slice(0, 200)}…` : current.excerpt}
            </p>
          )}

          {/* 形態はだいたい自動で合っているので小さく。違っていればここで直す */}
          <div className="mt-4 flex flex-wrap items-center gap-1">
            <span className="text-[0.625rem] font-bold text-gray-400">形態</span>
            {BOWL_STYLES.map((st) => (
              <button
                key={st}
                type="button"
                disabled={busy}
                onClick={() => save("bowl_style", st)}
                className={`rounded-full px-2 py-0.5 text-xs font-medium active:scale-95 disabled:opacity-50 ${
                  st === current.style ? "bg-gray-800 text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <p className="mb-2 mt-4 text-xs font-bold text-gray-700">この一杯の味・系統は？</p>
          <div className="grid grid-cols-3 gap-2" data-testid="taste-choices">
            {BOWL_TASTES.map((t) => (
              <button
                key={t}
                type="button"
                disabled={busy}
                onClick={() => save("bowl_taste", t)}
                className="rounded-xl bg-orange-50 px-2 py-3 text-sm font-bold text-orange-900 ring-1 ring-orange-200 active:scale-95 disabled:opacity-50"
              >
                {t}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={skip}
            className="mt-3 w-full rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-600 active:scale-95 disabled:opacity-50"
          >
            分からない（後回し）
          </button>
        </section>
      )}

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(zoom, 1280)} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </main>
  );
}
