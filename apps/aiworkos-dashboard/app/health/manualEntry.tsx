"use client";

import { useMemo, useState } from "react";
import { fmtDay } from "./charts";

// 手入力カード（睡眠・朝の散歩・出張）。
//
// 設計の前提: 「毎日続けられること」が最優先。
//   フォームを開いて数字を打つ設計にすると、3日で止まる。だから:
//     - 散歩・出張は トグル1つ = 1タップ
//     - 睡眠は よく使う値のボタン = 1タップ（端数は「その他」から）
//     - 対象日は既定で今日。過去日は日付チップ1タップで切替（= 過去日でも2タップ）
//     - 押した瞬間に画面へ反映（楽観更新）。通信の完了を待たせない
//     - 入っているかどうかは、チップの点と各行の状態でその場で分かる
//
// 保存先は health_metrics（source='manual'）。同じ日を何度押しても
// UNIQUE (metric, day, source) の upsert なので行は増えない。

export type ManualMetric = "sleep_hours" | "morning_walk" | "business_trip";
/** { "2026-08-03": { sleep_hours: 6.5, morning_walk: 1 } } */
export type ManualEntries = Record<string, Partial<Record<ManualMetric, number>>>;

// よく使う睡眠時間。4.5〜6.5 を 0.5 刻み。
// 当初は 5.0〜8.0 に置いていたが、実際は短い日が多く、下限の5時間が
// いちばん押される＝端に張り付いていた（2026-08-15に吉井さんの指定で下げた）。
// これで大半の日が1タップで入る。7時間以上や端数は「その他」から入れる。
const SLEEP_PRESETS = [4.5, 5, 5.5, 6, 6.5];

/** 日付チップに出す日数。前日の睡眠を翌朝入れる・数日ぶんまとめて入れる用途をこれで賄う。 */
const QUICK_DAYS = 7;

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
function weekday(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return WD[new Date(y, m - 1, d).getDay()] ?? "";
}

function chipLabel(day: string, today: string): string {
  if (day === today) return "今日";
  if (day === addDays(today, -1)) return "昨日";
  const [, m, d] = day.split("-").map(Number);
  return `${m}/${d}`;
}

/** その日に何か記録が入っているか（チップの点の判定に使う） */
function marksOf(entry: Partial<Record<ManualMetric, number>> | undefined) {
  return {
    sleep: entry?.sleep_hours != null,
    walk: entry?.morning_walk != null,
    trip: entry?.business_trip != null,
  };
}

export function ManualEntryCard({
  entries,
  onSave,
  error,
}: {
  entries: ManualEntries;
  /** value に null を渡すとその日の記録を消す。保存の成否を boolean で返す。 */
  onSave: (day: string, metric: ManualMetric, value: number | null) => Promise<boolean>;
  error: string | null;
}) {
  const today = useMemo(() => todayLocal(), []);
  const [day, setDay] = useState(today);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [busy, setBusy] = useState<ManualMetric | null>(null);

  const quickDays = useMemo(
    () => Array.from({ length: QUICK_DAYS }, (_, i) => addDays(today, -i)),
    [today]
  );

  const entry = entries[day];
  const sleep = entry?.sleep_hours ?? null;
  const walked = entry?.morning_walk != null;
  const tripped = entry?.business_trip != null;

  // 「直近7日でどれだけ入っているか」。続けられているかを自分で見るための数字。
  const filled = useMemo(() => {
    let s = 0;
    let w = 0;
    let t = 0;
    for (const d of quickDays) {
      const m = marksOf(entries[d]);
      if (m.sleep) s++;
      if (m.walk) w++;
      if (m.trip) t++;
    }
    return { sleep: s, walk: w, trip: t };
  }, [entries, quickDays]);

  async function save(metric: ManualMetric, value: number | null): Promise<boolean> {
    setBusy(metric);
    const ok = await onSave(day, metric, value);
    setBusy(null);
    return ok;
  }

  const isToday = day === today;

  return (
    <section className="mt-6 rounded-2xl border border-indigo-100 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-gray-900">記録をつける</h2>
        <span className="text-xs text-gray-400">睡眠・朝の散歩・出張（手入力）</span>
      </div>

      {/* 対象日。既定は今日なので、今日ぶんは日付を触らずそのまま1タップで入る。 */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
        {quickDays.map((d) => {
          const m = marksOf(entries[d]);
          const active = d === day;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDay(d)}
              aria-pressed={active}
              className={`flex min-w-[3.4rem] shrink-0 flex-col items-center gap-1 rounded-xl px-2 py-2 transition active:scale-95 ${
                active ? "bg-indigo-600 text-white" : "bg-gray-50 text-gray-600 ring-1 ring-gray-200"
              }`}
            >
              <span className="text-sm font-semibold leading-none">{chipLabel(d, today)}</span>
              <span className={`text-[0.625rem] leading-none ${active ? "text-indigo-100" : "text-gray-400"}`}>
                {weekday(d)}
              </span>
              {/* 入力済みの印。空欄の日はここが空くので、抜けがひと目で分かる。 */}
              <span className="flex h-1.5 items-center gap-0.5">
                {m.sleep && <i className="block h-1.5 w-1.5 rounded-full bg-amber-400" />}
                {m.walk && <i className="block h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                {m.trip && <i className="block h-1.5 w-1.5 rounded-full bg-sky-400" />}
              </span>
            </button>
          );
        })}
      </div>

      {/* もっと前の日。出張をまとめて入れるとき用の逃げ道。 */}
      <div className="mb-3 flex items-center gap-2">
        <label htmlFor="manual-day" className="text-xs text-gray-400">
          他の日
        </label>
        <input
          id="manual-day"
          type="date"
          value={day}
          max={today}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className="rounded-lg border border-gray-200 px-2 py-1 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none"
        />
        {!isToday && (
          <button
            type="button"
            onClick={() => setDay(today)}
            className="text-xs font-medium text-indigo-600 active:opacity-70"
          >
            今日に戻す
          </button>
        )}
      </div>

      <p className="mb-2 text-sm font-semibold text-gray-700">
        {fmtDay(day, true)}
        {!isToday && <span className="ml-1 text-xs font-normal text-amber-600">（過去の日を編集中）</span>}
      </p>

      {/* 朝の散歩・出張: トグル1つ = 1タップ */}
      <div className="space-y-2">
        <ToggleRow
          label="朝の散歩"
          emoji="🚶"
          on={walked}
          busy={busy === "morning_walk"}
          onColor="emerald"
          onToggle={() => save("morning_walk", walked ? null : 1)}
        />
        <ToggleRow
          label="出張"
          emoji="✈️"
          on={tripped}
          busy={busy === "business_trip"}
          onColor="sky"
          onToggle={() => save("business_trip", tripped ? null : 1)}
        />
      </div>

      {/* 睡眠: よく使う値をボタンで = 1タップ */}
      <div className="mt-3 rounded-xl bg-gray-50 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-medium text-gray-700">😴 睡眠時間</span>
          <span className="text-sm font-bold text-gray-900">
            {sleep != null ? `${sleep}時間` : <span className="font-normal text-gray-400">未記録</span>}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
          {SLEEP_PRESETS.map((v) => {
            const on = sleep === v;
            return (
              <button
                key={v}
                type="button"
                disabled={busy === "sleep_hours"}
                onClick={() => save("sleep_hours", on ? null : v)}
                aria-pressed={on}
                className={`min-h-[2.75rem] rounded-lg text-sm font-semibold tabular-nums transition active:scale-95 disabled:opacity-50 ${
                  on ? "bg-amber-500 text-white" : "bg-white text-gray-700 ring-1 ring-gray-200"
                }`}
              >
                {v.toFixed(1)}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setCustomValue(sleep != null ? String(sleep) : "");
              setCustomOpen((v) => !v);
            }}
            className="min-h-[2.75rem] rounded-lg bg-white text-sm font-medium text-gray-500 ring-1 ring-gray-200 transition active:scale-95"
          >
            その他
          </button>
        </div>

        {customOpen && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0.5"
              max="24"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              placeholder="例 4.5"
              className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-sm text-gray-500">時間</span>
            <button
              type="button"
              disabled={!customValue.trim() || busy === "sleep_hours"}
              onClick={async () => {
                const ok = await save("sleep_hours", Number(customValue));
                if (ok) setCustomOpen(false);
              }}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 active:scale-95"
            >
              保存
            </button>
            {sleep != null && (
              <button
                type="button"
                onClick={() => save("sleep_hours", null)}
                className="ml-auto text-sm text-rose-600 active:opacity-70"
              >
                記録を消す
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}

      <p className="mt-3 text-xs text-gray-400">
        直近{QUICK_DAYS}日の記録：睡眠 {filled.sleep}日／朝の散歩 {filled.walk}日／出張 {filled.trip}日
      </p>
    </section>
  );
}

function ToggleRow({
  label,
  emoji,
  on,
  busy,
  onColor,
  onToggle,
}: {
  label: string;
  emoji: string;
  on: boolean;
  busy: boolean;
  onColor: "emerald" | "sky";
  onToggle: () => void;
}) {
  // Tailwind は使う色名を静的に見つけるので、クラス名は組み立てずに書き出す
  const onClass = onColor === "emerald" ? "bg-emerald-500 text-white" : "bg-sky-500 text-white";
  const rowClass =
    onColor === "emerald"
      ? "bg-emerald-50 ring-1 ring-emerald-200"
      : "bg-sky-50 ring-1 ring-sky-200";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={on}
      className={`flex min-h-[3rem] w-full items-center gap-3 rounded-xl px-3 text-left transition active:scale-[0.99] disabled:opacity-60 ${
        on ? rowClass : "bg-gray-50 ring-1 ring-gray-200"
      }`}
    >
      <span className="text-lg">{emoji}</span>
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <span
        className={`ml-auto rounded-full px-3 py-1.5 text-sm font-semibold transition ${
          on ? onClass : "bg-white text-gray-400 ring-1 ring-gray-200"
        }`}
      >
        {busy ? "…" : on ? "やった" : "記録する"}
      </span>
    </button>
  );
}
