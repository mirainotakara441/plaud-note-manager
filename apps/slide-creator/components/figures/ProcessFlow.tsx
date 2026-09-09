"use client";

interface Props {
  steps: string[];
}

export default function ProcessFlow({ steps }: Props) {
  return (
    <div className="flex flex-col items-center gap-1 w-full">
      {steps.slice(0, 5).map((step, i) => (
        <div key={i} className="flex flex-col items-center w-full">
          <div
            className="w-full px-3 py-2 rounded-lg text-white text-sm font-bold text-center"
            style={{ background: i % 2 === 0 ? "#4F46E5" : "#7C3AED" }}
          >
            {step}
          </div>
          {i < steps.length - 1 && (
            <div className="text-pink-500 text-lg leading-tight">▼</div>
          )}
        </div>
      ))}
    </div>
  );
}
