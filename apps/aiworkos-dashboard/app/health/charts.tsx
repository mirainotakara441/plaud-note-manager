"use client";

import { useMemo, useRef, useState } from "react";

// 健康ダッシュボード用の軽量チャート部品（外部チャートライブラリ非依存・SVG手書き）。
// 配色・線幅・ギャップの扱いは dataviz skill のルールに従う:
//   - 1系列のみのチャートは凡例なし（タイトル横の色ドットが識別）
//   - 移動平均は太い実線（2px）、生値は薄い点+細線。欠測はnullのまま繋がない
//   - 目盛りは最小限、ラベルは端に間引いて表示
//   - ホバーでクロスヘア＋ツールチップ

export type Point = { day: string; value: number | null };

const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function fmtDay(d: string, withWeekday = false): string {
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  if (!withWeekday) return `${m}/${day}`;
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${y}年${m}月${day}日（${wd}）`;
}

export function movingAverage(points: Point[], window: number): (number | null)[] {
  const minRequired = Math.max(1, Math.ceil(window / 2));
  return points.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = points
      .slice(start, i + 1)
      .map((p) => p.value)
      .filter((v): v is number => v != null);
    if (slice.length < minRequired) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

// 欠測が一定日数以上連続する区間を検出（グラフ上に「データなし」帯を出すため）
function findGapRuns(values: (number | null)[], minLen = 5): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let runStart: number | null = null;
  values.forEach((v, i) => {
    if (v == null) {
      if (runStart == null) runStart = i;
    } else {
      if (runStart != null && i - runStart >= minLen) runs.push({ start: runStart, end: i - 1 });
      runStart = null;
    }
  });
  if (runStart != null && values.length - runStart >= minLen) {
    runs.push({ start: runStart, end: values.length - 1 });
  }
  return runs;
}

function buildPathSegments(
  values: (number | null)[],
  xOf: (i: number) => number,
  yOf: (v: number) => number
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) {
        segments.push(current.join(" "));
        current = [];
      }
      return;
    }
    const x = xOf(i);
    const y = yOf(v);
    current.push(current.length === 0 ? `M ${x} ${y}` : `L ${x} ${y}`);
  });
  if (current.length) segments.push(current.join(" "));
  return segments;
}

function niceTicks(min: number, max: number, count = 3): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

const WIDTH = 600;
const PAD = { top: 10, right: 10, bottom: 20, left: 34 };

export function LineChart({
  points,
  color,
  height = 160,
  maWindow,
  unit = "",
  valueFormat,
  gapLabel = "データなし",
}: {
  points: Point[];
  color: string;
  height?: number;
  maWindow?: number;
  unit?: string;
  valueFormat?: (v: number) => string;
  gapLabel?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const raw = points.map((p) => p.value);
  const ma = maWindow ? movingAverage(points, maWindow) : null;
  const displayValues = ma ?? raw;

  const definedForScale = (ma ?? raw).filter((v): v is number => v != null);
  const rawDefined = raw.filter((v): v is number => v != null);
  const allDefined = [...definedForScale, ...rawDefined];

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const n = points.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const xOf = (i: number) => PAD.left + xStep * i;

  const dataMin = allDefined.length ? Math.min(...allDefined) : 0;
  const dataMax = allDefined.length ? Math.max(...allDefined) : 1;
  const pad = (dataMax - dataMin) * 0.12 || Math.abs(dataMax) * 0.1 || 1;
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;
  const yOf = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const maSegments = ma ? buildPathSegments(ma, xOf, yOf) : [];
  const rawSegments = buildPathSegments(raw, xOf, yOf);
  const gapRuns = findGapRuns(raw, 5);
  const ticks = niceTicks(yMin, yMax, 3);

  const fmt = valueFormat ?? ((v: number) => v.toFixed(1));

  // ラベルは間引いて数箇所だけ
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const xUser = (e.clientX - rect.left) * scaleX;
    const i = Math.round((xUser - PAD.left) / (xStep || 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, i)));
  }

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoverRaw = hoverIdx != null ? raw[hoverIdx] : null;
  const hoverMa = hoverIdx != null && ma ? ma[hoverIdx] : null;
  const hoverLeftPct = hoverIdx != null && n > 0 ? (xOf(hoverIdx) / WIDTH) * 100 : 0;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        className="block touch-none"
      >
        {/* グリッド線 + Y軸ラベル */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="#e1e0d9"
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={yOf(t) + 3} textAnchor="end" fontSize={9} fill="#898781">
              {fmt(t)}
            </text>
          </g>
        ))}

        {/* 欠測帯 */}
        {gapRuns.map((r, i) => {
          const x1 = xOf(r.start) - xStep / 2;
          const x2 = xOf(r.end) + xStep / 2;
          const w = Math.max(0, x2 - x1);
          return (
            <g key={i}>
              <rect
                x={x1}
                y={PAD.top}
                width={w}
                height={plotH}
                fill="#898781"
                fillOpacity={0.07}
              />
              {w > 60 && (
                <text
                  x={(x1 + x2) / 2}
                  y={PAD.top + plotH / 2}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#898781"
                >
                  {gapLabel}
                </text>
              )}
            </g>
          );
        })}

        {/* 生値（薄い細線・移動平均がある時のみ背景として表示） */}
        {ma &&
          rawSegments.map((d, i) => (
            <path key={`raw-${i}`} d={d} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.28} />
          ))}

        {/* メインライン（移動平均 or 生値） */}
        {(ma ? maSegments : rawSegments).map((d, i) => (
          <path
            key={`main-${i}`}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* X軸ラベル */}
        {points.map((p, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text key={i} x={xOf(i)} y={height - 4} textAnchor="middle" fontSize={9} fill="#898781">
              {fmtDay(p.day)}
            </text>
          ) : null
        )}

        {/* ホバー: クロスヘア＋マーカー */}
        {hoverIdx != null && (
          <g>
            <line
              x1={xOf(hoverIdx)}
              x2={xOf(hoverIdx)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="#c3c2b7"
              strokeWidth={1}
              strokeDasharray="3,3"
            />
            {hoverRaw != null && (
              <circle
                cx={xOf(hoverIdx)}
                cy={yOf(hoverRaw)}
                r={4}
                fill={color}
                fillOpacity={ma ? 0.35 : 1}
                stroke="#fcfcfb"
                strokeWidth={2}
              />
            )}
            {hoverMa != null && (
              <circle cx={xOf(hoverIdx)} cy={yOf(hoverMa)} r={4} fill={color} stroke="#fcfcfb" strokeWidth={2} />
            )}
          </g>
        )}
      </svg>

      {hoverPoint && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs shadow-md"
          style={{
            left: `${Math.min(92, Math.max(8, hoverLeftPct))}%`,
          }}
        >
          <p className="font-medium text-gray-500">{fmtDay(hoverPoint.day, true)}</p>
          {hoverRaw != null ? (
            <p className="font-semibold text-gray-900">
              {fmt(hoverRaw)}
              {unit}
              {ma && hoverMa != null && (
                <span className="ml-1 font-normal text-gray-400">
                  (7日平均 {fmt(hoverMa)}
                  {unit})
                </span>
              )}
            </p>
          ) : (
            <p className="text-gray-400">記録なし</p>
          )}
        </div>
      )}
    </div>
  );
}

export function BarChart({
  points,
  color,
  height = 140,
  unit = "",
  valueFormat,
  gapLabel = "データなし",
}: {
  points: Point[];
  color: string;
  height?: number;
  unit?: string;
  valueFormat?: (v: number) => string;
  gapLabel?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const values = points.map((p) => p.value);
  const defined = values.filter((v): v is number => v != null);
  const max = defined.length ? Math.max(...defined) : 1;

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const n = points.length;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, Math.min(20, slot - 2));
  const xCenter = (i: number) => PAD.left + slot * i + slot / 2;
  const yOf = (v: number) => PAD.top + plotH - (v / (max || 1)) * plotH;

  const gapRuns = findGapRuns(values, 5);
  const fmt = valueFormat ?? ((v: number) => Math.round(v).toLocaleString());
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const xUser = (e.clientX - rect.left) * scaleX;
    const i = Math.floor((xUser - PAD.left) / (slot || 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, i)));
  }

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoverLeftPct = hoverIdx != null ? (xCenter(hoverIdx) / WIDTH) * 100 : 0;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        className="block touch-none"
      >
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={yOf(0)} y2={yOf(0)} stroke="#c3c2b7" strokeWidth={1} />
        <text x={PAD.left - 6} y={yOf(max) + 3} textAnchor="end" fontSize={9} fill="#898781">
          {fmt(max)}
        </text>

        {gapRuns.map((r, i) => {
          const x1 = PAD.left + slot * r.start;
          const x2 = PAD.left + slot * (r.end + 1);
          const w = Math.max(0, x2 - x1);
          return (
            <g key={i}>
              <rect x={x1} y={PAD.top} width={w} height={plotH} fill="#898781" fillOpacity={0.07} />
              {w > 60 && (
                <text x={(x1 + x2) / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize={9} fill="#898781">
                  {gapLabel}
                </text>
              )}
            </g>
          );
        })}

        {points.map((p, i) => {
          if (p.value == null) return null;
          const h = Math.max(1, plotH - (yOf(p.value) - PAD.top));
          const isHover = hoverIdx === i;
          return (
            <rect
              key={i}
              x={xCenter(i) - barW / 2}
              y={yOf(p.value)}
              width={barW}
              height={h}
              rx={2}
              fill={color}
              fillOpacity={isHover ? 1 : 0.85}
            />
          );
        })}

        {points.map((p, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text key={i} x={xCenter(i)} y={height - 4} textAnchor="middle" fontSize={9} fill="#898781">
              {fmtDay(p.day)}
            </text>
          ) : null
        )}

        {hoverIdx != null && (
          <line
            x1={xCenter(hoverIdx)}
            x2={xCenter(hoverIdx)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="#c3c2b7"
            strokeWidth={1}
            strokeDasharray="3,3"
          />
        )}
      </svg>

      {hoverPoint && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs shadow-md"
          style={{ left: `${Math.min(92, Math.max(8, hoverLeftPct))}%` }}
        >
          <p className="font-medium text-gray-500">{fmtDay(hoverPoint.day, true)}</p>
          <p className="font-semibold text-gray-900">
            {hoverPoint.value != null ? `${fmt(hoverPoint.value)}${unit}` : (
              <span className="font-normal text-gray-400">記録なし</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="flex-1 rounded-xl bg-gray-50 p-3 text-center">
      <p className="text-xl font-bold text-gray-900">{value}</p>
      <p className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-gray-500">
        {color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
        {label}
      </p>
      {sub && <p className="mt-0.5 text-[10px] text-gray-400">{sub}</p>}
    </div>
  );
}

export function ChartTitle({ color, title, hint }: { color: string; title: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

// dataviz skillの検証済みパレット（カテゴリカル配色・光モード）から役割を固定割当。
// このアプリはダークモード非対応（既存ページも全てライト固定）のためライト値のみ使用。
export const HEALTH_COLORS = {
  weight: "#2a78d6", // slot1 blue
  bodyFat: "#1baf7a", // slot5 aqua
  steps: "#008300", // slot2 green
  kcal: "#eb6834", // slot6 orange
  walking: "#4a3aa7", // slot7 violet
};

export function average(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v != null);
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}
