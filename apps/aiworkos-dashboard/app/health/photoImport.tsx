"use client";

import { useRef, useState } from "react";
import { fmtDay } from "./charts";

// 健康アプリのスクショから数字を入れるカード。歩数と体重で同じ部品を使う。
//
// 設計の前提: 「読み取った数字をそのまま書かない」。
//   health_range_summary は source='photo' を最優先で採るので、誤読が1件入ると
//   それがその日の値として居座る。だから読み取り(POST)と登録(PUT)を分け、
//   間に必ず確認の表を挟む。数字はその場で直せる。
//
// 平均を1日ぶんとして入れない:
//   画面上部の「平均」を日別として取り込むと、実際には量っていない日に数字が立つ。
//   2026年7月に歩数で同じ壊れ方をしている。サーバ側で集計値は分けているが、
//   読み取った集計値も画面に出して「これは入れていない」と分かるようにしている。

const MAX_EDGE = 1568; // これ以上大きくしてもモデルの読み取り精度は上がらない
const JPEG_QUALITY = 0.85;
const MAX_IMAGES = 6;

type Field = { key: string; label: string; unit: string; decimals: number };

type Row = {
  day: string;
  weekday: string;
  values: Record<string, number>;
  current: Record<string, number>;
  warning?: string;
};

type ReadResponse = {
  fields?: Field[];
  rows?: Row[];
  summaries?: { label: string; text: string }[];
  notes?: string[];
  error?: string;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("画像を読み込めませんでした"));
    r.readAsDataURL(file);
  });
}

// canvas に描き直すので iPhone の HEIC も JPEG になる。
// 原寸のまま送ると Vercel のリクエスト上限(4.5MB)に当たるため、縮小は必須。
async function downscaleToJpeg(file: File): Promise<string> {
  const original = await fileToDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("画像を読み込めませんでした"));
    el.src = original;
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasが使えませんでした");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

function fmtValue(v: number | undefined, f: Field): string {
  if (v == null) return "—";
  return `${v.toFixed(f.decimals)}${f.unit === "count" ? "" : f.unit}`;
}

export function PhotoImportCard({
  kind,
  title,
  hint,
  today,
  onSaved,
}: {
  kind: "steps" | "weight";
  title: string;
  hint: string;
  today: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [summaries, setSummaries] = useState<{ label: string; text: string }[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputId = `photo-input-${kind}`;

  function reset() {
    setRows([]);
    setPicked(new Set());
    setSummaries([]);
    setNotes([]);
    setError(null);
    setSavedMsg(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  /** 読み取った値が、今入っている値と全部同じか（＝入れ直す必要がない行か） */
  function sameAsCurrent(r: Row, fs: Field[]): boolean {
    return fs.every((f) => r.values[f.key] == null || r.current[f.key] === r.values[f.key]);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (files.length > MAX_IMAGES) {
      setError(`一度に読めるのは${MAX_IMAGES}枚までです`);
      return;
    }
    setBusy("reading");
    setError(null);
    setSavedMsg(null);
    try {
      const images = await Promise.all(Array.from(files).map(downscaleToJpeg));
      const res = await fetch("/api/health/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, images, today }),
      });
      const json = (await res.json()) as ReadResponse;
      if (!res.ok || json.error) throw new Error(json.error ?? "読み取りに失敗しました");
      const got = json.rows ?? [];
      const fs = json.fields ?? [];
      setFields(fs);
      setRows(got);
      // 既に同じ数字が入っている日は既定でチェックを外す（入れ直す必要がない）。
      setPicked(new Set(got.filter((r) => !sameAsCurrent(r, fs)).map((r) => r.day)));
      setSummaries(json.summaries ?? []);
      setNotes(json.notes ?? []);
      if (got.length === 0) {
        setError("日付ごとの記録を読み取れませんでした。一覧が写った画面を送ってください。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み取りに失敗しました");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    const targets = rows.filter((r) => picked.has(r.day));
    if (targets.length === 0) return;
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch("/api/health/photo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          today,
          rows: targets.map((r) => ({ day: r.day, values: r.values })),
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "登録に失敗しました");
      setSavedMsg(`${json?.days ?? targets.length}日ぶんを登録しました`);
      reset();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  const pickedCount = rows.filter((r) => picked.has(r.day)).length;

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span>
          <span className="text-sm font-bold text-gray-900">📷 {title}</span>
          <span className="mt-0.5 block text-xs text-gray-500">{hint}</span>
        </span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
            id={inputId}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={inputId}
              className={`inline-flex min-h-[2.75rem] cursor-pointer items-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition active:scale-95 ${
                busy ? "pointer-events-none opacity-50" : ""
              }`}
            >
              {busy === "reading" ? "読み取り中…" : "写真を選ぶ"}
            </label>
            <span className="text-xs text-gray-400">一度に{MAX_IMAGES}枚まで</span>
            {(rows.length > 0 || error) && (
              <button
                type="button"
                onClick={reset}
                className="ml-auto text-sm text-gray-500 active:opacity-70"
              >
                やり直す
              </button>
            )}
          </div>

          {error && (
            <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
          )}
          {savedMsg && (
            <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {savedMsg}
            </p>
          )}

          {rows.length > 0 && (
            <>
              <div className="mt-4 flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-gray-700">読み取った{rows.length}日ぶん</p>
                <button
                  type="button"
                  onClick={() =>
                    setPicked((p) =>
                      p.size === rows.length ? new Set() : new Set(rows.map((r) => r.day))
                    )
                  }
                  className="text-xs font-medium text-indigo-600 active:opacity-70"
                >
                  {picked.size === rows.length ? "全部外す" : "全部選ぶ"}
                </button>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                数字が違っていたらその場で直せます。チェックを入れた日だけ登録します。
              </p>

              <ul className="mt-2 divide-y divide-gray-100">
                {rows.map((r) => {
                  const on = picked.has(r.day);
                  const same = sameAsCurrent(r, fields);
                  return (
                    <li key={r.day} className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setPicked((p) => {
                              const next = new Set(p);
                              if (next.has(r.day)) next.delete(r.day);
                              else next.add(r.day);
                              return next;
                            })
                          }
                          aria-label={`${r.day}を登録する`}
                          className="h-5 w-5 shrink-0 rounded border-gray-300 text-indigo-600"
                        />
                        <span className="w-20 shrink-0 text-sm tabular-nums text-gray-700">
                          {fmtDay(r.day)}({r.weekday})
                        </span>
                        {fields.map((f) => (
                          <span key={f.key} className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              inputMode="decimal"
                              step={f.decimals > 0 ? "0.1" : "1"}
                              value={r.values[f.key] ?? ""}
                              placeholder="—"
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) => {
                                    if (x.day !== r.day) return x;
                                    const values = { ...x.values };
                                    if (e.target.value === "") delete values[f.key];
                                    else values[f.key] = Number(e.target.value);
                                    return { ...x, values };
                                  })
                                )
                              }
                              className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-right text-base tabular-nums text-gray-900 focus:border-indigo-500 focus:outline-none"
                            />
                            <span className="text-xs text-gray-400">
                              {f.unit === "count" ? "歩" : f.unit}
                            </span>
                          </span>
                        ))}
                      </div>
                      <p className="mt-0.5 pl-7 text-xs tabular-nums text-gray-500">
                        {same ? (
                          "同じ値が入っています"
                        ) : (
                          <>
                            今:{" "}
                            {fields
                              .map((f) => `${f.label} ${fmtValue(r.current[f.key], f)}`)
                              .join("・")}
                          </>
                        )}
                        {r.warning && <span className="block text-amber-600">⚠️ {r.warning}</span>}
                      </p>
                    </li>
                  );
                })}
              </ul>

              {summaries.length > 0 && (
                <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2">
                  <p className="text-xs font-semibold text-gray-600">
                    画面にあった集計（これは登録しません）
                  </p>
                  {summaries.map((s, i) => (
                    <p key={i} className="mt-0.5 text-xs text-gray-500">
                      {s.label}：{s.text}
                    </p>
                  ))}
                  <p className="mt-1 text-xs leading-relaxed text-gray-400">
                    平均を1日ぶんとして入れると、量っていない日に数字が立ちます。日別の行だけを登録します。
                  </p>
                </div>
              )}

              {notes.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {notes.map((n, i) => (
                    <li key={i} className="text-xs leading-relaxed text-amber-700">
                      ・{n}
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                disabled={pickedCount === 0 || busy !== null}
                onClick={save}
                className="mt-3 min-h-[2.75rem] w-full rounded-xl bg-indigo-600 text-sm font-semibold text-white transition disabled:opacity-40 active:scale-[0.99]"
              >
                {busy === "saving" ? "登録中…" : `チェックした${pickedCount}日ぶんを登録する`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
