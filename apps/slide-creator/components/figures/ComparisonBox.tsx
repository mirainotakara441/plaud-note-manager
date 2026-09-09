"use client";

interface Side {
  label: string;
  points: string[];
}

interface Props {
  left: Side;
  right: Side;
}

export default function ComparisonBox({ left, right }: Props) {
  return (
    <div className="flex gap-2 w-full h-full">
      {[{ data: left, color: "#4F46E5" }, { data: right, color: "#7C3AED" }].map(
        ({ data, color }, i) => (
          <div key={i} className="flex-1 flex flex-col">
            <div
              className="text-white text-xs font-bold text-center py-1.5 rounded-t-lg"
              style={{ background: color }}
            >
              {data.label}
            </div>
            <div className="flex-1 bg-white border-2 rounded-b-lg p-2 space-y-1"
              style={{ borderColor: color }}>
              {data.points.slice(0, 4).map((pt, j) => (
                <div key={j} className="text-xs text-gray-700 flex items-start gap-1">
                  <span style={{ color }}>●</span>
                  <span>{pt}</span>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}
