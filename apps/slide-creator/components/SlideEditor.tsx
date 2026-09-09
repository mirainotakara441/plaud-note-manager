"use client";

import { useState } from "react";
import type { Slide, Figure } from "@/lib/types";
import ProcessFlow from "./figures/ProcessFlow";
import ComparisonBox from "./figures/ComparisonBox";
import IconGrid from "./figures/IconGrid";
import SimpleChart from "./figures/SimpleChart";

interface Props {
  slide: Slide;
  onChange: (updated: Slide) => void;
}

function EditableText({
  value,
  onChange,
  className,
  multiline,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    const shared = {
      className: `w-full border-2 border-indigo-400 rounded px-2 py-1 text-inherit font-inherit bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 ${className}`,
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(e.target.value),
      onBlur: () => setEditing(false),
      autoFocus: true,
    };
    return multiline ? (
      <textarea rows={2} {...shared} />
    ) : (
      <input type="text" {...shared} />
    );
  }

  return (
    <span
      className={`cursor-text hover:bg-indigo-50 hover:underline decoration-dotted rounded px-0.5 ${className}`}
      onClick={() => setEditing(true)}
      title="クリックして編集"
    >
      {value || <span className="text-gray-400 italic">（空）</span>}
    </span>
  );
}

function FigureView({ figure }: { figure: Figure }) {
  if (figure.kind === "process_flow") return <ProcessFlow steps={figure.steps} />;
  if (figure.kind === "comparison") return <ComparisonBox left={figure.left} right={figure.right} />;
  if (figure.kind === "icon_grid") return <IconGrid items={figure.items} />;
  if (figure.kind === "bar_chart") return <SimpleChart bars={figure.bars} />;
  return null;
}

export default function SlideEditor({ slide, onChange }: Props) {
  if (slide.type === "title") {
    return (
      <div className="w-full aspect-video bg-indigo-600 rounded-2xl flex flex-col items-center justify-center p-8 gap-4">
        <div className="w-24 h-1 bg-pink-400 rounded" />
        <EditableText
          value={slide.title}
          onChange={(v) => onChange({ ...slide, title: v })}
          className="text-white text-4xl font-bold text-center"
        />
        <div className="w-24 h-1 bg-pink-400 rounded" />
        <EditableText
          value={slide.subtitle}
          onChange={(v) => onChange({ ...slide, subtitle: v })}
          className="text-indigo-200 text-xl text-center"
        />
      </div>
    );
  }

  if (slide.type === "closing") {
    return (
      <div className="w-full aspect-video bg-violet-700 rounded-2xl flex flex-col p-8">
        <EditableText
          value={slide.title}
          onChange={(v) => onChange({ ...slide, title: v })}
          className="text-white text-3xl font-bold text-center mb-2"
        />
        <div className="w-16 h-1 bg-pink-400 rounded mx-auto mb-4" />
        <div className="flex-1 space-y-2">
          {slide.summary.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-green-300 font-bold text-lg shrink-0">✓</span>
              <EditableText
                value={s}
                onChange={(v) => {
                  const summary = [...slide.summary];
                  summary[i] = v;
                  onChange({ ...slide, summary });
                }}
                className="text-white text-base"
              />
            </div>
          ))}
        </div>
        <p className="text-violet-300 text-sm text-center italic mt-4">
          ご清聴ありがとうございました！
        </p>
      </div>
    );
  }

  const hasFigure = !!slide.figure;

  return (
    <div className="w-full aspect-video bg-slate-50 rounded-2xl flex flex-col overflow-hidden shadow-lg">
      <div className="bg-indigo-600 px-6 py-3 shrink-0">
        <EditableText
          value={slide.title}
          onChange={(v) => onChange({ ...slide, title: v })}
          className="text-white text-2xl font-bold"
        />
      </div>
      <div className="flex-1 flex gap-4 p-4 min-h-0">
        <div className={`flex flex-col gap-2 ${hasFigure ? "w-1/2" : "w-full"}`}>
          {slide.bullets.map((b, i) => (
            <div
              key={i}
              className="bg-white border border-indigo-200 rounded-lg px-3 py-2 flex items-center gap-2 shadow-sm"
            >
              <span className="text-indigo-500 font-bold shrink-0">
                {["①", "②", "③", "④"][i]}
              </span>
              <EditableText
                value={b}
                onChange={(v) => {
                  const bullets = [...slide.bullets];
                  bullets[i] = v;
                  onChange({ ...slide, bullets });
                }}
                className="text-gray-700 text-sm flex-1"
              />
            </div>
          ))}
          <button
            onClick={() => {
              if (slide.bullets.length < 4) {
                onChange({ ...slide, bullets: [...slide.bullets, "新しいポイント"] });
              }
            }}
            disabled={slide.bullets.length >= 4}
            className="text-xs text-indigo-400 hover:text-indigo-600 disabled:opacity-30 text-left mt-1"
          >
            ＋ 箇条書きを追加
          </button>
        </div>
        {hasFigure && (
          <div className="w-1/2 flex items-center justify-center bg-white rounded-xl p-3 border border-gray-100">
            <FigureView figure={slide.figure!} />
          </div>
        )}
      </div>
      {slide.speakerNote && (
        <div className="bg-yellow-50 border-t border-yellow-200 px-4 py-1.5 text-xs text-yellow-700 shrink-0">
          📝 <EditableText
            value={slide.speakerNote}
            onChange={(v) => onChange({ ...slide, speakerNote: v })}
            className="text-yellow-700"
          />
        </div>
      )}
    </div>
  );
}
