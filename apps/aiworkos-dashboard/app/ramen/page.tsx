"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartTitle, StatTile } from "@/app/health/charts";

// ラーメン（ライフOS側の第1ブロック）。1行＝1杯（1訪問）。
// データは /api/ramen（Supabase ramen_logs・読み取り専用）。
//
// この画面が引き受けている流れ:
//   ① 店で「一杯を記録」（店名＋その場の一言）→ status=captured
//   ② 「文章を作る」で食べログ用とX用を同時生成 → status=drafted
//   ③ 食べログは本文をコピーして貼る（投稿ボタンは本人が押す・半自動）
//      Xは「Xへ投稿」でAPI経由そのまま出る → status=posted
// 月次の4本立て（まとめ／特徴／金賞・殿堂／思い出の4枚）も同じ画面から生成する。

type Log = {
  id: number;
  eaten_on: string;
  bowl_no: number | null;
  bowl_label: string | null;
  shop: string;
  area: string | null;
  genre: string | null;
  visit_count: number | null;
  menu: string | null;
  price: number | null;
  score: number | null;
  score_time: string | null;
  stars: number | null;
  title: string | null;
  excerpt: string | null;
  memo: string | null;
  status: "captured" | "drafted" | "posted";
  draft_tabelog: string | null;
  draft_x: string | null;
  photo_count: number;
  photo_urls: string[] | null;
  tabelog_url: string | null;
  tabelog_shop_url: string | null;
  x_url: string | null;
  x_posted_on: string | null;
  x_excerpt: string | null;
  is_ramen: boolean;
  note: string | null;
};

const C_BOWL = "#eb6834";
const C_X = "#4a3aa7";

type FilterKey = "all" | "ramen" | "no_x";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "ramen", label: "ラーメンのみ" },
  { key: "no_x", label: "X未リンク" },
];

const MONTHLY_KINDS = [
  { key: "summary", label: "ラーメンまとめ" },
  { key: "feature", label: "今月の特徴" },
  { key: "awards", label: "金賞・殿堂入り" },
  { key: "memories", label: "思い出の4枚" },
] as const;

const WD = ["日", "月", "火", "水", "木", "金", "土"];

function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${m}/${day}（${WD[new Date(y, m - 1, day).getDay()] ?? ""}）`;
}

function fmtMonth(ym: string) {
  return `${Number(ym.split("-")[1])}月`;
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {children}
    </section>
  );
}

function MonthlyBars({ rows }: { rows: { ym: string; ramen: number; other: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.ramen + r.other));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.ym} className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-right text-xs font-medium text-gray-500">
            {fmtMonth(r.ym)}
          </span>
          <div className="flex h-5 flex-1 items-stretch overflow-hidden rounded-md bg-gray-100">
            <div style={{ width: `${(r.ramen / max) * 100}%`, backgroundColor: C_BOWL }} />
            <div style={{ width: `${(r.other / max) * 100}%`, backgroundColor: "#d8d3cd" }} />
          </div>
          <span className="w-16 shrink-0 text-xs text-gray-500">
            <span className="font-bold text-gray-900">{r.ramen}</span>杯
            {r.other > 0 && <span className="text-gray-400"> +{r.other}</span>}
          </span>
        </div>
      ))}
      <p className="pt-1 text-[0.625rem] text-gray-400">
        オレンジ＝ラーメン／グレー＝それ以外（うどん・そば・とんかつ等）
      </p>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-700 active:scale-95"
    >
      {done ? "コピーしました" : label}
    </button>
  );
}

function LogCard({ log, onChanged }: { log: Log; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function call(path: string, body: unknown, what: string) {
    setBusy(what);
    setErr(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `失敗しました（${res.status}）`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "失敗しました");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-bold text-gray-900">{fmtDate(log.eaten_on)}</span>
        {log.bowl_label && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
            style={{ backgroundColor: C_BOWL }}
          >
            {log.bowl_label}
          </span>
        )}
        {log.status !== "posted" && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
            {log.status === "captured" ? "文章まち" : "投稿まち"}
          </span>
        )}
        <span className="ml-auto">
          {log.score != null && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200">
              ★{log.score.toFixed(1)}
              {log.score_time && (
                <span className="ml-1 font-normal text-amber-600">{log.score_time}</span>
              )}
            </span>
          )}
        </span>
      </div>

      <h3 className="mt-2 text-base font-bold leading-snug text-gray-900">{log.shop}</h3>
      <p className="mt-0.5 text-xs text-gray-500">
        {[log.area, log.genre].filter(Boolean).join(" / ")}
        {log.visit_count != null && (
          <span className="ml-1 text-gray-400">・{log.visit_count}回目</span>
        )}
      </p>

      {log.menu && (
        <p className="mt-2 text-sm font-medium text-gray-700">
          🍜 {log.menu}
          {log.price != null && (
            <span className="ml-1 text-gray-400">{log.price.toLocaleString()}円</span>
          )}
        </p>
      )}

      {log.memo && (
        <p className="mt-2 rounded-lg bg-gray-50 p-2 text-sm leading-relaxed text-gray-600">
          <span className="mr-1 text-xs font-bold text-gray-400">メモ</span>
          {log.memo}
        </p>
      )}

      {log.title && (
        <p className="mt-2 text-sm font-bold leading-snug text-gray-800">「{log.title}」</p>
      )}
      {log.excerpt && <p className="mt-1 text-sm leading-relaxed text-gray-600">{log.excerpt}</p>}

      {log.x_excerpt && (
        <p
          className="mt-2 border-l-2 pl-3 text-sm leading-relaxed text-gray-500"
          style={{ borderColor: C_X }}
        >
          {log.x_excerpt}
        </p>
      )}

      {/* 下書きができている一杯だけ、貼り付け用の本文と投稿ボタンを出す */}
      {(log.draft_tabelog || log.draft_x) && (
        <div className="mt-3 space-y-3 rounded-xl bg-gray-50 p-3">
          {log.draft_tabelog && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-bold text-orange-700">食べログ用</span>
                <CopyButton text={log.draft_tabelog} label="本文をコピー" />
                <a
                  href={log.tabelog_shop_url ?? "https://tabelog.com/"}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-indigo-500 underline active:opacity-70"
                >
                  店ページを開く →
                </a>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {log.draft_tabelog}
              </p>
            </div>
          )}
          {log.draft_x && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-bold text-violet-700">X用</span>
                <CopyButton text={log.draft_x} label="本文をコピー" />
                {!log.x_url && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => call("/api/ramen/post-x", { id: log.id }, "x")}
                    className="rounded-full bg-violet-600 px-3 py-1 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
                  >
                    {busy === "x" ? "投稿中…" : "Xへ投稿"}
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {log.draft_x}
              </p>
            </div>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {log.status === "captured" && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => call("/api/ramen/draft", { id: log.id }, "draft")}
            className="rounded-full bg-gray-900 px-3 py-1 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
          >
            {busy === "draft" ? "書いています…" : "文章を作る"}
          </button>
        )}
        {log.tabelog_url && (
          <a
            href={log.tabelog_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700 ring-1 ring-orange-200 active:opacity-70"
          >
            食べログ口コミ →
          </a>
        )}
        {log.x_url ? (
          <a
            href={log.x_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200 active:opacity-70"
          >
            X投稿 →
          </a>
        ) : (
          <span className="rounded-full bg-gray-50 px-3 py-1 text-xs text-gray-400 ring-1 ring-gray-200">
            X未リンク
          </span>
        )}
        {log.photo_count > 0 && (
          <span className="text-xs text-gray-400">📷 {log.photo_count}枚</span>
        )}
      </div>
    </article>
  );
}

const MAX_PHOTOS = 4;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

function CaptureForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [shop, setShop] = useState("");
  const [menu, setMenu] = useState("");
  const [memo, setMemo] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function onPickPhotos(files: FileList | null) {
    if (!files) return;
    setPhotos((prev) => [...prev, ...Array.from(files)].slice(0, MAX_PHOTOS));
  }

  function removePhoto(i: number) {
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    if (!shop.trim()) {
      setErr("店名を入れてください");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // 写真は先にStorageへ上げてパスだけ受け取り、その後の記録本体にpathを渡す
      // （Xへの投稿時にはこのpathからサーバーが写真を取り出す）。
      const photo_urls: string[] = [];
      for (const file of photos) {
        const dataUrl = await fileToDataUrl(file);
        const up = await fetch("/api/ramen/photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl, content_type: file.type || "image/jpeg" }),
        });
        const upJson = await up.json();
        if (!up.ok) throw new Error(upJson?.error ?? "写真の保存に失敗しました");
        photo_urls.push(upJson.path);
      }

      const res = await fetch("/api/ramen/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, menu, memo, photo_urls }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "記録に失敗しました");
      setShop("");
      setMenu("");
      setMemo("");
      setPhotos([]);
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "記録に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-6 w-full rounded-2xl border border-dashed border-orange-300 bg-orange-50 p-4 text-sm font-bold text-orange-700 active:bg-orange-100"
      >
        ＋ 一杯を記録する
      </button>
    );
  }

  return (
    <Section>
      <ChartTitle color={C_BOWL} title="一杯を記録" hint="文章は後から生成する" />
      <div className="space-y-2">
        <input
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          placeholder="店名（必須）"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />
        <input
          value={menu}
          onChange={(e) => setMenu(e.target.value)}
          placeholder="注文したもの"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={4}
          placeholder="その場の一言（音声入力でOK）。ここが文章の一次情報になります"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />

        <div className="space-y-1">
          <label className="block">
            <span className="inline-block w-full cursor-pointer rounded-xl border border-dashed border-gray-300 px-3 py-2 text-center text-sm text-gray-500 active:bg-gray-50">
              📷 写真を選ぶ（最大{MAX_PHOTOS}枚・Xに添付されます）
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={photos.length >= MAX_PHOTOS}
              onChange={(e) => {
                onPickPhotos(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photos.map((f, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 rounded-lg bg-orange-50 px-2 py-1 text-xs text-orange-700"
                >
                  {f.name.slice(0, 14)}
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    className="font-bold text-orange-400"
                    aria-label="この写真を外す"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {err && <p className="text-xs text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex-1 rounded-xl bg-gray-900 py-2 text-sm font-bold text-white active:scale-95 disabled:opacity-50"
          >
            {saving ? "保存中…" : "記録する"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-xl px-4 py-2 text-sm text-gray-500"
          >
            やめる
          </button>
        </div>
      </div>
    </Section>
  );
}

function MonthlyDrafts({ months }: { months: string[] }) {
  const [month, setMonth] = useState(months[0] ?? "");
  const [drafts, setDrafts] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    setDrafts(null);
    try {
      const res = await fetch("/api/ramen/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "生成に失敗しました");
      setDrafts(json.drafts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "生成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section>
      <ChartTitle color={C_X} title="月次振り返り（Xの4本立て）" hint="まとめ / 特徴 / 金賞・殿堂 / 思い出の4枚" />
      <div className="flex items-center gap-2">
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-xl border border-gray-200 px-3 py-2 text-sm"
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {m.replace("-", "年")}月
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={generate}
          disabled={busy || !month}
          className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-bold text-white active:scale-95 disabled:opacity-50"
        >
          {busy ? "書いています…" : "4本つくる"}
        </button>
      </div>
      {err && <p className="mt-2 text-sm text-rose-600">{err}</p>}
      {drafts && (
        <div className="mt-4 space-y-4">
          {MONTHLY_KINDS.map((k) =>
            drafts[k.key] ? (
              <div key={k.key} className="rounded-xl bg-gray-50 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-xs font-bold text-gray-700">{k.label}</span>
                  <CopyButton text={drafts[k.key]} label="コピー" />
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {drafts[k.key]}
                </p>
              </div>
            ) : null
          )}
        </div>
      )}
    </Section>
  );
}

export default function RamenPage() {
  const [items, setItems] = useState<Log[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [month, setMonth] = useState<string>("");

  const load = useCallback(async () => {
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

  const months = useMemo(() => {
    const set = new Set((items ?? []).map((i) => i.eaten_on.slice(0, 7)));
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [items]);

  useEffect(() => {
    if (!month && months.length > 0) setMonth(months[0]);
  }, [months, month]);

  const stats = useMemo(() => {
    const all = items ?? [];
    const ramen = all.filter((i) => i.is_ramen);
    const bowls = ramen.map((i) => i.bowl_no).filter((n): n is number => n != null);
    const scored = all.map((i) => i.score).filter((s): s is number => s != null);
    const posted = ramen.filter((i) => i.x_url).length;
    return {
      latestBowl: bowls.length ? Math.max(...bowls) : null,
      ramenCount: ramen.length,
      total: all.length,
      avgScore: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      posted,
      postRate: ramen.length ? Math.round((posted / ramen.length) * 100) : null,
    };
  }, [items]);

  const monthly = useMemo(() => {
    const map = new Map<string, { ym: string; ramen: number; other: number }>();
    for (const i of items ?? []) {
      const ym = i.eaten_on.slice(0, 7);
      const row = map.get(ym) ?? { ym, ramen: 0, other: 0 };
      if (i.is_ramen) row.ramen += 1;
      else row.other += 1;
      map.set(ym, row);
    }
    return Array.from(map.values()).sort((a, b) => (a.ym < b.ym ? 1 : -1));
  }, [items]);

  // 食べログの「何回目」は行ったカレンダー経由では取れないため、
  // ここに溜まっている記録そのものを数える＝今年の訪問回数。通算ではない。
  const repeats = useMemo(() => {
    const map = new Map<string, { shop: string; count: number; url: string | null }>();
    for (const i of items ?? []) {
      const cur = map.get(i.shop);
      if (cur) cur.count += 1;
      else map.set(i.shop, { shop: i.shop, count: 1, url: i.tabelog_shop_url });
    }
    return Array.from(map.values())
      .filter((r) => r.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [items]);

  // 未処理（文章まち・投稿まち）はいつでも最上段。埋もれると運用が止まるため。
  const pending = useMemo(
    () => (items ?? []).filter((i) => i.status !== "posted"),
    [items]
  );

  const shown = useMemo(() => {
    let all = (items ?? []).filter((i) => i.status === "posted");
    if (month) all = all.filter((i) => i.eaten_on.slice(0, 7) === month);
    if (filter === "ramen") all = all.filter((i) => i.is_ramen);
    if (filter === "no_x") all = all.filter((i) => !i.x_url);
    return all;
  }, [items, filter, month]);

  const loading = !items && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">🍜 ラーメン</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          食べログ（mirainotakara）とX（@0kara1_man）を一杯ごとに1本の線でつなぎ、
          記録から投稿までをここで回す
        </p>
      </header>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />
          ))}
        </div>
      )}

      {items && items.length > 0 && (
        <>
          <Section>
            <ChartTitle color={C_BOWL} title="いまの積み上げ" hint={`記録 ${stats.total}件`} />
            <div className="flex gap-2">
              <StatTile
                label="通算杯数"
                value={stats.latestBowl != null ? `${stats.latestBowl}` : "—"}
                sub="杯目（最新）"
                color={C_BOWL}
              />
              <StatTile
                label="ラーメン"
                value={`${stats.ramenCount}`}
                sub={`／記録${stats.total}件`}
              />
              <StatTile
                label="平均点"
                value={stats.avgScore != null ? stats.avgScore.toFixed(2) : "—"}
                sub="食べログ総合"
              />
              <StatTile
                label="X投稿率"
                value={stats.postRate != null ? `${stats.postRate}%` : "—"}
                sub={`${stats.posted}／${stats.ramenCount}杯`}
                color={C_X}
              />
            </div>
          </Section>

          <CaptureForm onSaved={load} />

          {pending.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-bold text-gray-500">🕒 いま手を動かす一杯</h2>
              <div className="space-y-3">
                {pending.map((log) => (
                  <LogCard key={log.id} log={log} onChanged={load} />
                ))}
              </div>
            </div>
          )}

          <Section>
            <ChartTitle color={C_BOWL} title="月別の杯数" />
            <MonthlyBars rows={monthly} />
          </Section>

          {repeats.length > 0 && (
            <Section>
              <ChartTitle color={C_BOWL} title="通っている店" hint="2026年の訪問回数" />
              <ol className="space-y-2">
                {repeats.map((r, i) => (
                  <li key={r.shop} className="flex items-center gap-3">
                    <span className="w-4 shrink-0 text-xs font-bold text-gray-400">{i + 1}</span>
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 underline decoration-gray-300 active:opacity-70"
                      >
                        {r.shop}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                        {r.shop}
                      </span>
                    )}
                    <span className="shrink-0 text-sm text-gray-500">
                      <span className="font-bold text-gray-900">{r.count}</span>回
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          <MonthlyDrafts months={months} />

          <div className="mb-3 mt-8 flex flex-wrap items-center gap-2">
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {m.replace("-", "年")}月
                </option>
              ))}
            </select>
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

          <div className="space-y-3">
            {shown.map((log) => (
              <LogCard key={log.id} log={log} onChanged={load} />
            ))}
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-gray-400">
            食べログ{" "}
            <a
              href="https://tabelog.com/rvwr/000776165/"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 underline active:opacity-70"
            >
              mirainotakara
            </a>{" "}
            ／ X{" "}
            <a
              href="https://x.com/0kara1_man"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 underline active:opacity-70"
            >
              @0kara1_man
            </a>
          </p>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホームに戻る
        </Link>
      </div>
    </main>
  );
}
