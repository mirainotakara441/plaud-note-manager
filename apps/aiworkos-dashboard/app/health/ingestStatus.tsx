"use client";

import { useState } from "react";
import { fmtDay } from "./charts";

// 取り込み状況の表示。
//
// 見せ方の方針:
//   グラフだけ見ていると「値は出ているが中身の出どころが入れ替わっている」状態に
//   気づけない。だから指標ごとに「最終取得日・取得元・直近の値」を必ず出し、
//   気になるものを先頭にまとめる。
//
//   ここでは事実しか書かない。「◯◯が原因で止まった」とは書かず、
//   「◯◯由来のデータが△△以降入っていません」という観測結果だけを出す。
//   原因の切り分けは吉井さんが端末側を見て判断すること。

export type SourceStat = {
  source: string;
  lastDay: string;
  lastValue: number | null;
  count: number;
  median: number | null;
  behindDays: number;
};

export type MetricStat = {
  metric: string;
  label: string;
  unit: string | null;
  lastDay: string;
  lastValue: number | null;
  lastSource: string;
  staleDays: number;
  count: number;
  sources: SourceStat[];
  notes: string[];
  severity: "ok" | "warn" | "alert";
  manual: boolean;
};

export type StatusResponse = {
  from?: string;
  to?: string;
  windowDays?: number;
  metrics?: MetricStat[];
  summary?: { total: number; alert: number; warn: number };
  disclaimer?: string;
  error?: string;
};

function fmtValue(v: number | null, unit: string | null): string {
  if (v == null) return "—";
  return `${v.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

/** 上部に出す一行の警告。気になる指標があるときだけ表示する。 */
export function IngestAlertBanner({
  status,
  onJump,
}: {
  status: StatusResponse | null;
  onJump: () => void;
}) {
  const alerts = status?.metrics?.filter((m) => m.severity === "alert") ?? [];
  if (alerts.length === 0) return null;
  const first = alerts[0];
  return (
    <button
      type="button"
      onClick={onJump}
      className="mt-3 flex w-full items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-left active:scale-[0.99]"
    >
      <span className="shrink-0 leading-relaxed">⚠️</span>
      <span className="min-w-0 text-xs leading-relaxed text-amber-900">
        <span className="font-semibold">
          取り込みに気になる点が {alerts.length}件あります
        </span>
        <br />
        {first.label}：{first.notes[0]}
        <span className="ml-1 font-medium text-amber-700 underline">詳しく見る</span>
      </span>
    </button>
  );
}

export function IngestStatusSection({ status }: { status: StatusResponse | null }) {
  const [showAll, setShowAll] = useState(false);

  if (!status || status.error || !status.metrics) {
    return (
      <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-gray-900">取り込み状況</h2>
        <p className="mt-2 text-sm text-gray-400">
          {status?.error ?? "取り込み状況を取得できませんでした。"}
        </p>
      </section>
    );
  }

  const metrics = status.metrics;
  const flagged = metrics.filter((m) => m.severity !== "ok");
  const ok = metrics.filter((m) => m.severity === "ok");

  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-gray-900">取り込み状況</h2>
        <span className="text-xs text-gray-400">直近{status.windowDays ?? 90}日</span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-gray-500">
        指標ごとに、いつ・どこから・いくつ入っているかの実績です。
        {flagged.length > 0
          ? `${metrics.length}指標のうち ${flagged.length}件に気になる点があります。`
          : `${metrics.length}指標すべて、直近まで記録が入っています。`}
      </p>

      {/* 気になるもの。数が少ないので畳まず全部出す。 */}
      {flagged.map((m) => (
        <div
          key={m.metric}
          className={`mb-2 rounded-xl border px-3 py-2.5 ${
            m.severity === "alert"
              ? "border-amber-200 bg-amber-50"
              : "border-gray-200 bg-gray-50"
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-bold text-gray-900">{m.label}</span>
            <span className="text-xs text-gray-500">
              最終 {fmtDay(m.lastDay)}（{m.lastSource}）／直近の値 {fmtValue(m.lastValue, m.unit)}
            </span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {m.notes.map((n, i) => (
              <li
                key={i}
                className={`text-xs leading-relaxed ${
                  m.severity === "alert" ? "text-amber-900" : "text-gray-600"
                }`}
              >
                ・{n}
              </li>
            ))}
          </ul>
          {/* ソースが複数ある指標は、どれが生きていてどれが止まっているかを並べて出す。
              「止まった」ではなく「別のソースだけ続いている」が見えるようにするため。 */}
          {m.sources.length > 1 && (
            <ul className="mt-1.5 space-y-0.5 border-t border-black/5 pt-1.5">
              {m.sources.map((s) => (
                <li key={s.source} className="flex items-baseline gap-2 text-xs text-gray-600">
                  <span className="min-w-0 flex-1 truncate">{s.source}</span>
                  <span className="shrink-0 tabular-nums text-gray-500">
                    〜{fmtDay(s.lastDay)}
                  </span>
                  <span className="w-24 shrink-0 text-right tabular-nums">
                    中央値 {s.median != null ? s.median.toLocaleString() : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={() => setShowAll((v) => !v)}
        className="mt-2 flex w-full items-center justify-between text-sm font-semibold text-gray-700"
      >
        すべての指標を見る（{metrics.length}件）
        <span className="text-gray-400">{showAll ? "▲" : "▼"}</span>
      </button>

      {showAll && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-1.5 pr-3 font-medium">指標</th>
                <th className="py-1.5 pr-3 font-medium">最終取得日</th>
                <th className="py-1.5 pr-3 font-medium">取得元</th>
                <th className="py-1.5 pr-3 text-right font-medium">直近の値</th>
              </tr>
            </thead>
            <tbody>
              {[...flagged, ...ok].map((m) => (
                <tr key={m.metric} className="border-b border-gray-100 text-gray-700">
                  <td className="py-1.5 pr-3">
                    {m.severity === "alert" && <span className="mr-1">⚠️</span>}
                    {m.label}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {fmtDay(m.lastDay)}
                    {m.staleDays > 0 && (
                      <span className="ml-1 text-gray-400">({m.staleDays}日前)</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{m.lastSource}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {fmtValue(m.lastValue, m.unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-gray-400">{status.disclaimer}</p>
    </section>
  );
}
