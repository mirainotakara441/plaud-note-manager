"use client";

import type { Slide, Figure } from "@/lib/types";
import ProcessFlow from "./figures/ProcessFlow";
import ComparisonBox from "./figures/ComparisonBox";
import IconGrid from "./figures/IconGrid";
import SimpleChart from "./figures/SimpleChart";

interface Props {
  slide: Slide;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}

function FigureView({ figure }: { figure: Figure }) {
  if (figure.kind === "process_flow") return <ProcessFlow steps={figure.steps} />;
  if (figure.kind === "comparison") return <ComparisonBox left={figure.left} right={figure.right} />;
  if (figure.kind === "icon_grid") return <IconGrid items={figure.items} />;
  if (figure.kind === "bar_chart") return <SimpleChart bars={figure.bars} />;
  return null;
}

function SlideContent({ slide }: { slide: Slide }) {
  if (slide.type === "title") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-indigo-600 rounded-lg p-4">
        <div className="w-16 h-0.5 bg-pink-400 mb-3" />
        <h1 className="text-white text-xl font-bold text-center leading-tight mb-3">
          {slide.title}
        </h1>
        <div className="w-16 h-0.5 bg-pink-400 mb-3" />
        <p className="text-indigo-200 text-sm text-center">{slide.subtitle}</p>
      </div>
    );
  }

  if (slide.type === "closing") {
    return (
      <div className="w-full h-full flex flex-col bg-violet-700 rounded-lg p-3">
        <h2 className="text-white text-base font-bold text-center mb-2">{slide.title}</h2>
        <div className="w-12 h-0.5 bg-pink-400 mx-auto mb-2" />
        <div className="flex-1 space-y-1">
          {slide.summary.map((s, i) => (
            <div key={i} className="text-white text-xs flex items-start gap-1">
              <span className="text-green-300 font-bold shrink-0">✓</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
        <p className="text-violet-300 text-xs text-center italic mt-1">
          ご清聴ありがとうございました！
        </p>
      </div>
    );
  }

  const hasFigure = !!slide.figure;

  return (
    <div className="w-full h-full flex flex-col bg-slate-50 rounded-lg overflow-hidden">
      <div className="bg-indigo-600 px-2 py-1.5 shrink-0">
        <h2 className="text-white text-sm font-bold truncate">{slide.title}</h2>
      </div>
      <div className="flex-1 flex gap-2 p-2 min-h-0">
        <div className={`flex flex-col gap-1 ${hasFigure ? "w-1/2" : "w-full"}`}>
          {slide.bullets.map((b, i) => (
            <div
              key={i}
              className="bg-white border border-indigo-200 rounded px-2 py-1 text-xs text-gray-700 flex items-center gap-1"
            >
              <span className="text-indigo-500 font-bold shrink-0">
                {["①", "②", "③", "④"][i]}
              </span>
              <span className="truncate">{b}</span>
            </div>
          ))}
        </div>
        {hasFigure && (
          <div className="w-1/2 flex items-center justify-center">
            <FigureView figure={slide.figure!} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function SlidePreview({ slide, index, isSelected, onClick }: Props) {
  return (
    <div
      className={`cursor-pointer rounded-xl overflow-hidden border-2 transition-all duration-150 ${
        isSelected
          ? "border-indigo-500 shadow-lg shadow-indigo-200 scale-[1.02]"
          : "border-transparent hover:border-indigo-200 hover:shadow"
      }`}
      onClick={onClick}
    >
      <div className="bg-gray-200 px-2 py-0.5 flex items-center gap-1">
        <span className="text-gray-500 text-xs">{index + 1}</span>
      </div>
      <div className="aspect-video bg-white">
        <SlideContent slide={slide} />
      </div>
    </div>
  );
}
