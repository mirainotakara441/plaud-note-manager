"use client";

interface Bar {
  label: string;
  value: number;
}

interface Props {
  bars: Bar[];
}

const BAR_COLORS = ["#4F46E5", "#7C3AED", "#EC4899", "#10B981", "#F59E0B"];

export default function SimpleChart({ bars }: Props) {
  const maxVal = Math.max(...bars.map((b) => b.value), 1);

  return (
    <div className="flex flex-col w-full h-full justify-end gap-1">
      <div className="flex items-end gap-2 flex-1">
        {bars.slice(0, 5).map((bar, i) => {
          const pct = (bar.value / maxVal) * 100;
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-0.5">
              <span className="text-xs font-bold text-gray-700">{bar.value}</span>
              <div
                className="w-full rounded-t-md transition-all"
                style={{
                  height: `${Math.max(pct, 4)}%`,
                  background: BAR_COLORS[i % BAR_COLORS.length],
                  minHeight: "8px",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="h-0.5 bg-gray-300 rounded" />
      <div className="flex gap-2">
        {bars.slice(0, 5).map((bar, i) => (
          <div key={i} className="flex-1 text-center text-xs text-gray-600 leading-tight truncate">
            {bar.label}
          </div>
        ))}
      </div>
    </div>
  );
}
