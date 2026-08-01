"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartTitle, StatTile } from "@/app/health/charts";
import { FAMILY_MEMBERS, PLACE_KINDS, PLACE_KIND_ICON } from "@/lib/family";

// ファミリー（ライフOS側の第2ブロック）。1行＝1つのお出かけ。
// 「いつ・誰と・どこへ・何をしたか」と写真を残す場所。
// ラーメンが外（食べログ・X）へ出す記録なのに対して、ここは完全に内向き。
// 写真は非公開バケットに置き、表示は /api/family/photo 経由（合言葉認証の内側だけ）。

type Log = {
  id: number;
  happened_on: string; // YYYY-MM-DD
  title: string;
  place: string | null;
  place_kind: string | null;
  area: string | null;
  members: string[];
  memo: string | null;
  highlight: string | null;
  stars: number | null;
  cost: number | null;
  photo_paths: string[];
  photo_count: number;
};

// ラーメンのオレンジ・健康の青緑と混ざらない暖色（ローズ）をファミリーの色にする。
const C_FAMILY = "#c2417f";
const C_SUB = "#4a3aa7";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const MAX_EDGE = 1600; // 送信前に長辺をこのpxまで縮める
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${m}/${day}（${wd}）`;
}

function fmtMonthHead(ym: string) {
  const [y, m] = ym.split("-");
  return `${y}年${Number(m)}月`;
}

function todayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60 * 1000);
  const m = `${jst.getMonth() + 1}`.padStart(2, "0");
  const d = `${jst.getDate()}`.padStart(2, "0");
  return `${jst.getFullYear()}-${m}-${d}`;
}

function photoUrl(path: string) {
  return `/api/family/photo?path=${encodeURIComponent(path)}`;
}

// iPhoneの写真はそのままだと数MBあり、Vercelのボディ上限に当たる。
// 送る前にcanvasで長辺1600pxのJPEGへ落とす。HEICなどcanvasが読めない形式は
// 原本のまま送り、それも大きすぎる時だけ諦めてもらう。
async function toUploadable(file: File): Promise<{ data: string; content_type: string }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas未対応");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const data = dataUrl.split(",")[1] ?? "";
    if (!data) throw new Error("変換失敗");
    return { data, content_type: "image/jpeg" };
  } catch {
    if (file.size > 4_000_000) {
      throw new Error(`${file.name} は大きすぎて送れませんでした`);
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("読み込み失敗"));
      reader.readAsDataURL(file);
    });
    const type = ALLOWED_TYPES.includes(file.type) ? file.type : "image/jpeg";
    return { data, content_type: type };
  }
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {children}
    </section>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
        active ? "text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"
      }`}
      style={active ? { backgroundColor: C_FAMILY } : undefined}
    >
      {label}
    </button>
  );
}

type Draft = {
  happened_on: string;
  title: string;
  place: string;
  place_kind: string;
  area: string;
  members: string[];
  memo: string;
  highlight: string;
  stars: number | null;
};

function emptyDraft(): Draft {
  return {
    happened_on: todayJst(),
    title: "",
    place: "",
    place_kind: "",
    area: "",
    members: [],
    memo: "",
    highlight: "",
    stars: null,
  };
}

function CaptureForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => {
    return () => previews.forEach((u) => URL.revokeObjectURL(u));
  }, [previews]);

  const toggleMember = (m: string) =>
    setDraft((d) => ({
      ...d,
      members: d.members.includes(m)
        ? d.members.filter((x) => x !== m)
        : [...d.members, m],
    }));

  const submit = async () => {
    if (!draft.title.trim()) {
      setError("何をしたか（タイトル）だけは入れてください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 写真を先に上げてパスを集め、最後に1件として登録する。
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`写真をアップロード中… ${i + 1}/${files.length}`);
        const payload = await toUploadable(files[i]);
        const res = await fetch("/api/family/photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.path) {
          throw new Error(json.error ?? `写真の保存に失敗しました（${res.status}）`);
        }
        paths.push(json.path);
      }

      setProgress("記録を保存中…");
      const res = await fetch("/api/family/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, photo_paths: paths }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `保存に失敗しました（${res.status}）`);

      setDraft(emptyDraft());
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      setOpen(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-300 bg-white p-4 text-sm font-bold text-gray-600 shadow-sm transition active:bg-gray-50"
      >
        <span style={{ color: C_FAMILY }}>＋</span> 思い出を記録する
      </button>
    );
  }

  return (
    <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-800">思い出を記録</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-gray-400 active:opacity-70"
        >
          閉じる
        </button>
      </div>

      <div className="space-y-3">
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-medium text-gray-500">日付</span>
            <input
              type="date"
              value={draft.happened_on}
              onChange={(e) => setDraft({ ...draft, happened_on: e.target.value })}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900"
            />
          </label>
          <label className="w-28">
            <span className="mb-1 block text-xs font-medium text-gray-500">★（任意）</span>
            <select
              value={draft.stars ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, stars: e.target.value ? Number(e.target.value) : null })
              }
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900"
            >
              <option value="">—</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {"★".repeat(n)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            何をしたか（必須）
          </span>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="例：4人で『◯◯』を観に行った"
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900"
          />
        </label>

        <div className="flex gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-medium text-gray-500">場所</span>
            <input
              value={draft.place}
              onChange={(e) => setDraft({ ...draft, place: e.target.value })}
              placeholder="例：光が丘公園"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900"
            />
          </label>
          <label className="w-32">
            <span className="mb-1 block text-xs font-medium text-gray-500">エリア</span>
            <input
              value={draft.area}
              onChange={(e) => setDraft({ ...draft, area: e.target.value })}
              placeholder="練馬"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900"
            />
          </label>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">行き先の種別</span>
          <div className="flex flex-wrap gap-1.5">
            {PLACE_KINDS.map((k) => (
              <Chip
                key={k}
                label={`${PLACE_KIND_ICON[k] ?? ""} ${k}`}
                active={draft.place_kind === k}
                onClick={() =>
                  setDraft({ ...draft, place_kind: draft.place_kind === k ? "" : k })
                }
              />
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">一緒に行った人</span>
          <div className="flex flex-wrap gap-1.5">
            {FAMILY_MEMBERS.map((m) => (
              <Chip
                key={m}
                label={m}
                active={draft.members.includes(m)}
                onClick={() => toggleMember(m)}
              />
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            その日の出来事（メモ）
          </span>
          <textarea
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
            rows={3}
            placeholder="誰が何を言った、どんな顔をしていた、など"
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-900"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">
            そうか（気づき・残したい一言）
          </span>
          <input
            value={draft.highlight}
            onChange={(e) => setDraft({ ...draft, highlight: e.target.value })}
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900"
          />
        </label>

        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">写真</span>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-full file:border-0 file:bg-gray-100 file:px-4 file:py-2 file:text-sm file:font-bold file:text-gray-700"
          />
          {previews.length > 0 && (
            <div className="mt-2 grid grid-cols-4 gap-2">
              {previews.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={src}
                  src={src}
                  alt={`選択した写真 ${i + 1}`}
                  className="aspect-square w-full rounded-lg object-cover"
                />
              ))}
            </div>
          )}
        </div>

        {error && (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="w-full rounded-xl px-4 py-3 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
          style={{ backgroundColor: C_FAMILY }}
        >
          {busy ? (progress ?? "保存中…") : "この思い出を残す"}
        </button>
      </div>
    </section>
  );
}

function LogCard({ log, onDeleted }: { log: Log; onDeleted: () => void }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    const res = await fetch(`/api/family/capture?id=${log.id}`, { method: "DELETE" });
    setBusy(false);
    setConfirming(false);
    if (res.ok) onDeleted();
  };

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-bold text-gray-900">{fmtDate(log.happened_on)}</span>
        {log.place_kind && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
            style={{ backgroundColor: C_FAMILY }}
          >
            {PLACE_KIND_ICON[log.place_kind] ?? ""} {log.place_kind}
          </span>
        )}
        {log.stars != null && (
          <span className="ml-auto text-xs font-bold text-amber-600">
            {"★".repeat(log.stars)}
          </span>
        )}
      </div>

      <h3 className="mt-2 text-base font-bold leading-snug text-gray-900">{log.title}</h3>
      {(log.place || log.area) && (
        <p className="mt-0.5 text-xs text-gray-500">
          📍 {[log.place, log.area].filter(Boolean).join(" / ")}
        </p>
      )}

      {log.members.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {log.members.map((m) => (
            <span
              key={m}
              className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-100"
            >
              {m}
            </span>
          ))}
        </div>
      )}

      {log.photo_paths.length > 0 && (
        <div
          className={`mt-3 grid gap-1.5 ${
            log.photo_paths.length === 1 ? "grid-cols-1" : "grid-cols-3"
          }`}
        >
          {log.photo_paths.map((p, i) => (
            <button
              key={p}
              type="button"
              onClick={() => setZoom(p)}
              className="overflow-hidden rounded-lg active:opacity-80"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoUrl(p)}
                alt={`${log.title} の写真 ${i + 1}`}
                loading="lazy"
                className={`w-full object-cover ${
                  log.photo_paths.length === 1 ? "max-h-72" : "aspect-square"
                }`}
              />
            </button>
          ))}
        </div>
      )}

      {log.memo && (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-600">
          {log.memo}
        </p>
      )}
      {log.highlight && (
        <p
          className="mt-2 border-l-2 pl-3 text-sm leading-relaxed text-gray-700"
          style={{ borderColor: C_SUB }}
        >
          {log.highlight}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        {log.photo_count > 0 && (
          <span className="text-xs text-gray-400">📷 {log.photo_count}枚</span>
        )}
        {log.cost != null && (
          <span className="text-xs text-gray-400">{log.cost.toLocaleString()}円</span>
        )}
        {confirming ? (
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="text-xs font-bold text-rose-600 active:opacity-70 disabled:opacity-40"
            >
              本当に消す
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-xs text-gray-400 active:opacity-70"
            >
              やめる
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="ml-auto text-xs text-gray-300 active:opacity-70"
          >
            削除
          </button>
        )}
      </div>

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(zoom)}
            alt={log.title}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </article>
  );
}

export default function FamilyPage() {
  const [items, setItems] = useState<Log[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [member, setMember] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/family", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setError(null);
          setItems(d.items ?? []);
        }
      })
      .catch(() => setError("ファミリー記録の取得に失敗しました"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const all = items ?? [];
    const thisYear = String(new Date().getFullYear());
    const yearRows = all.filter((i) => i.happened_on.startsWith(thisYear));
    const photos = all.reduce((a, i) => a + i.photo_count, 0);

    // 誰と一番出かけているか。同率なら家族の並び順で先の人を出す。
    const byMember = new Map<string, number>();
    for (const i of all) for (const m of i.members) byMember.set(m, (byMember.get(m) ?? 0) + 1);
    const ranked = FAMILY_MEMBERS.map((m) => ({ m, n: byMember.get(m) ?? 0 })).sort(
      (a, b) => b.n - a.n
    );

    return {
      total: all.length,
      thisYear: yearRows.length,
      photos,
      top: ranked[0]?.n ? ranked[0] : null,
      ranked: ranked.filter((r) => r.n > 0),
    };
  }, [items]);

  const shown = useMemo(() => {
    const all = items ?? [];
    return member ? all.filter((i) => i.members.includes(member)) : all;
  }, [items, member]);

  // 月ごとに区切って並べる。思い出は「いつ頃の話か」で辿ることが多い。
  const grouped = useMemo(() => {
    const map = new Map<string, Log[]>();
    for (const i of shown) {
      const ym = i.happened_on.slice(0, 7);
      map.set(ym, [...(map.get(ym) ?? []), i]);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [shown]);

  const loading = !items && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          👨‍👩‍👧‍👦 ファミリー
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          子どもたちとどこへ行き、何があったか。写真ごと残して、家族の記録として辿る
        </p>
      </header>

      <CaptureForm onSaved={load} />

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
              className="h-32 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {items && items.length === 0 && !error && (
        <p className="mt-4 rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm leading-relaxed text-gray-500">
          まだ記録がありません。
          <br />
          上の「＋ 思い出を記録する」から最初の1件を残しましょう。
        </p>
      )}

      {items && items.length > 0 && (
        <>
          <Section>
            <ChartTitle color={C_FAMILY} title="いまの積み上げ" hint={`記録 ${stats.total}件`} />
            <div className="flex gap-2">
              <StatTile
                label="今年"
                value={`${stats.thisYear}`}
                sub="回のお出かけ"
                color={C_FAMILY}
              />
              <StatTile label="通算" value={`${stats.total}`} sub="回" />
              <StatTile label="写真" value={`${stats.photos}`} sub="枚" />
              <StatTile
                label="一番一緒に"
                value={stats.top ? stats.top.m : "—"}
                sub={stats.top ? `${stats.top.n}回` : undefined}
                color={C_SUB}
              />
            </div>
          </Section>

          {stats.ranked.length > 0 && (
            <Section>
              <ChartTitle color={C_FAMILY} title="誰とどれだけ出かけたか" />
              <div className="space-y-2">
                {stats.ranked.map((r) => (
                  <div key={r.m} className="flex items-center gap-3">
                    <span className="w-10 shrink-0 text-right text-xs font-medium text-gray-500">
                      {r.m}
                    </span>
                    <div className="h-5 flex-1 overflow-hidden rounded-md bg-gray-100">
                      <div
                        className="h-full rounded-md"
                        style={{
                          width: `${(r.n / (stats.ranked[0]?.n || 1)) * 100}%`,
                          backgroundColor: C_FAMILY,
                        }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-xs text-gray-500">
                      <span className="font-bold text-gray-900">{r.n}</span>回
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <div className="mb-3 mt-6 flex flex-wrap items-center gap-2">
            <Chip label="全員" active={member === null} onClick={() => setMember(null)} />
            {FAMILY_MEMBERS.map((m) => (
              <Chip
                key={m}
                label={m}
                active={member === m}
                onClick={() => setMember(member === m ? null : m)}
              />
            ))}
            <span className="ml-auto text-xs text-gray-400">{shown.length}件</span>
          </div>

          <div className="space-y-6">
            {grouped.map(([ym, rows]) => (
              <div key={ym}>
                <h2 className="mb-2 text-sm font-bold text-gray-500">{fmtMonthHead(ym)}</h2>
                <div className="space-y-3">
                  {rows.map((log) => (
                    <LogCard key={log.id} log={log} onDeleted={load} />
                  ))}
                </div>
              </div>
            ))}
          </div>
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
