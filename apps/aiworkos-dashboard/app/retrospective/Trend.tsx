"use client";

import {
  CATEGORIES,
  averageRating,
  formatStars,
  ratingBarColor,
  ratingColor,
  shortPeriodLabel,
  type PeriodType,
  type RetroRow,
} from "@/lib/retrospective";

// 節ごとの★評価が、週（月）を追ってどう動いたかを見るところ。
// このページで一番の価値はここ。ただし1件しか無いうちは推移ではないので、
// グラフに見えるものは一切出さず、その旨をはっきり書く。

const MAX_PERIODS = 12;

type Props = {
  items: RetroRow[]; // 同じ period_type のものだけ
  periodType: PeriodType;
};

export default function Trend({ items, periodType }: Props) {
  // 古い順に並べ、直近 MAX_PERIODS 件だけを見る。
  const asc = [...items].sort((a, b) => a.period_start.localeCompare(b.period_start));
  const periods = asc.slice(-MAX_PERIODS);

  // 節の並び順は正準カテゴリー順。それ以外は後ろに登場順で。
  const known = CATEGORIES.filter((c) =>
    periods.some((p) => p.sections.some((s) => s.category === c))
  );
  const extra: string[] = [];
  for (const p of periods) {
    for (const s of p.sections) {
      if (!known.includes(s.category as (typeof CATEGORIES)[number]) && !extra.includes(s.category)) {
        extra.push(s.category);
      }
    }
  }
  const categories: string[] = [...known, ...extra];

  const ratingAt = (p: RetroRow, cat: string): number | null =>
    p.sections.find((s) => s.category === cat)?.rating ?? null;

  // ---- 1件以下：推移は出せない ----
  if (periods.length < 2) {
    const only = periods[0];
    return (
      <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-bold text-gray-500">★評価の推移</h2>
        <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
          まだ推移は出せません（2件目から）。
          {periods.length === 1
            ? `いまは${periodType}が1件だけなので、線にも棒にもなりません。`
            : `${periodType}の振り返りがまだ1件もありません。`}
        </p>
        {only && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-gray-400">
              1件のみの評価（推移ではありません）・{shortPeriodLabel(only.period_start, periodType)}
            </p>
            <ul className="space-y-1">
              {categories.map((c) => {
                const r = ratingAt(only, c);
                return (
                  <li key={c} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-gray-700">{c}</span>
                    <span className={`shrink-0 tabular-nums ${ratingColor(r)}`}>
                      {formatStars(r)}
                      <span className="ml-1 text-xs text-gray-400">{r ?? ""}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    );
  }

  // ---- 2件以上：ここから本番 ----
  const latest = periods[periods.length - 1];
  const prev = periods[periods.length - 2];

  const ups: string[] = [];
  const downs: string[] = [];
  for (const c of categories) {
    const a = ratingAt(prev, c);
    const b = ratingAt(latest, c);
    if (a === null || b === null) continue;
    if (b > a) ups.push(c);
    if (b < a) downs.push(c);
  }

  const avgOf = (p: RetroRow) => averageRating(p.sections);

  return (
    <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-500">★評価の推移</h2>
        <span className="text-[0.6875rem] text-gray-400">
          直近{periods.length}件・{periodType}
        </span>
      </div>

      {/* 平均 */}
      <div className="mb-4 rounded-xl bg-gray-50 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-bold text-gray-900">平均評価</span>
          <span className="text-sm tabular-nums text-gray-600">
            {avgOf(latest)?.toFixed(1) ?? "—"}
            {(() => {
              const a = avgOf(prev);
              const b = avgOf(latest);
              if (a === null || b === null) return null;
              const d = b - a;
              const sign = d > 0.05 ? "↑" : d < -0.05 ? "↓" : "→";
              const cls = d > 0.05 ? "text-emerald-600" : d < -0.05 ? "text-rose-600" : "text-gray-400";
              return (
                <span className={`ml-1 text-xs ${cls}`}>
                  {sign}
                  {Math.abs(d) >= 0.05 ? Math.abs(d).toFixed(1) : ""}
                </span>
              );
            })()}
          </span>
        </div>
        <Bars
          values={periods.map((p) => avgOf(p))}
          labels={periods.map((p) => shortPeriodLabel(p.period_start, periodType))}
        />
      </div>

      {/* 節ごと */}
      <div className="space-y-3">
        {categories.map((c) => {
          const values = periods.map((p) => ratingAt(p, c));
          const a = ratingAt(prev, c);
          const b = ratingAt(latest, c);
          const d = a !== null && b !== null ? b - a : null;
          return (
            <div key={c} className="rounded-xl bg-gray-50 p-3">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-bold text-gray-900">{c}</span>
                <span className="shrink-0 text-sm tabular-nums">
                  <span className={ratingColor(b)}>{formatStars(b)}</span>
                  {d !== null && (
                    <span
                      className={`ml-1 text-xs ${
                        d > 0 ? "text-emerald-600" : d < 0 ? "text-rose-600" : "text-gray-400"
                      }`}
                    >
                      {d > 0 ? `↑${d}` : d < 0 ? `↓${Math.abs(d)}` : "→"}
                    </span>
                  )}
                </span>
              </div>
              <Bars
                values={values}
                labels={periods.map((p) => shortPeriodLabel(p.period_start, periodType))}
              />
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[0.6875rem] leading-relaxed text-gray-400">
        棒の高さは★の数（5段階）。前回と比べて
        {ups.length > 0 ? `上がったのは ${ups.join("・")}` : "上がった節はなし"}、
        {downs.length > 0 ? `下がったのは ${downs.join("・")}` : "下がった節はなし"}。
        ★が付いていない節・その期に無かった節は空欄です。
      </p>
    </section>
  );
}

// 期ごとの棒。値が無い期は点線の空枠にして、0と区別できるようにする。
function Bars({ values, labels }: { values: (number | null)[]; labels: string[] }) {
  return (
    <div>
      {/* 件数が少ないうちは棒が間延びして「大きな変化」に見えてしまうので幅に上限を置く。 */}
      <div className="flex h-14 items-end gap-1">
        {values.map((v, i) => (
          <div key={i} className="flex h-full max-w-[3.5rem] flex-1 items-end">
            {v === null ? (
              <div className="h-full w-full rounded border border-dashed border-gray-300" />
            ) : (
              <div
                className={`w-full rounded-t ${ratingBarColor(Math.round(v))}`}
                style={{ height: `${Math.max((v / 5) * 100, 8)}%` }}
                title={`${v}`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {labels.map((l, i) => (
          <span
            key={i}
            className={`max-w-[3.5rem] flex-1 truncate text-center text-[0.6875rem] tabular-nums ${
              i === labels.length - 1 ? "font-bold text-gray-700" : "text-gray-400"
            }`}
          >
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
