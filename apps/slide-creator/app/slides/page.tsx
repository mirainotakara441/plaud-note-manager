"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SlideData, Slide } from "@/lib/types";
import SlidePreview from "@/components/SlidePreview";
import SlideEditor from "@/components/SlideEditor";

export default function SlidesPage() {
  const router = useRouter();
  const [slideData, setSlideData] = useState<SlideData | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    const raw = sessionStorage.getItem("slideData");
    if (!raw) {
      router.push("/");
      return;
    }
    try {
      setSlideData(JSON.parse(raw));
    } catch {
      router.push("/");
    }
  }, [router]);

  function updateSlide(index: number, updated: Slide) {
    if (!slideData) return;
    const slides = [...slideData.slides];
    slides[index] = updated;
    const next = { ...slideData, slides };
    setSlideData(next);
    sessionStorage.setItem("slideData", JSON.stringify(next));
  }

  function addSlide() {
    if (!slideData) return;
    const newSlide: Slide = {
      type: "content",
      title: "新しいスライド",
      bullets: ["ポイント1", "ポイント2"],
    };
    const slides = [...slideData.slides];
    const insertAt = selectedIndex + 1;
    slides.splice(insertAt, 0, newSlide);
    const next = { ...slideData, slides };
    setSlideData(next);
    sessionStorage.setItem("slideData", JSON.stringify(next));
    setSelectedIndex(insertAt);
  }

  function deleteSlide() {
    if (!slideData || slideData.slides.length <= 1) return;
    const slides = [...slideData.slides];
    slides.splice(selectedIndex, 1);
    const next = { ...slideData, slides };
    setSlideData(next);
    sessionStorage.setItem("slideData", JSON.stringify(next));
    setSelectedIndex(Math.min(selectedIndex, slides.length - 1));
  }

  async function handleDownload() {
    if (!slideData) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slideData),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "ダウンロードに失敗しました");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slideData.meta.title || "slides"}.pptx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setDownloading(false);
    }
  }

  if (!slideData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-indigo-50">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-10 w-10 text-indigo-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-indigo-600 font-medium">読み込み中...</p>
        </div>
      </div>
    );
  }

  const currentSlide = slideData.slides[selectedIndex];

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="text-gray-400 hover:text-gray-600 transition-colors text-sm"
          >
            ← 戻る
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center">
            <span className="text-white font-bold text-xs">S</span>
          </div>
          <span className="font-bold text-gray-700 truncate max-w-xs">
            {slideData.meta.title}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {downloadError && (
            <span className="text-red-500 text-sm">{downloadError}</span>
          )}
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-bold px-5 py-2 rounded-xl text-sm flex items-center gap-2 transition-colors"
          >
            {downloading ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                生成中…
              </>
            ) : (
              <>📥 PowerPointでダウンロード</>
            )}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 bg-white border-r flex flex-col">
          <div className="p-3 border-b flex items-center justify-between">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">
              スライド一覧
            </span>
            <span className="text-xs text-gray-400">{slideData.slides.length}枚</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {slideData.slides.map((slide, i) => (
              <SlidePreview
                key={i}
                slide={slide}
                index={i}
                isSelected={i === selectedIndex}
                onClick={() => setSelectedIndex(i)}
              />
            ))}
          </div>
          <div className="p-2 border-t flex gap-2">
            <button
              onClick={addSlide}
              className="flex-1 text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-bold py-2 rounded-lg transition-colors"
            >
              ＋ 追加
            </button>
            <button
              onClick={deleteSlide}
              disabled={slideData.slides.length <= 1}
              className="flex-1 text-xs bg-red-50 hover:bg-red-100 text-red-500 font-bold py-2 rounded-lg transition-colors disabled:opacity-30"
            >
              🗑 削除
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-8 flex flex-col items-center justify-center bg-gray-100">
          <div className="w-full max-w-4xl">
            <p className="text-xs text-gray-400 mb-3 text-center">
              テキストをクリックして編集できます
            </p>
            <SlideEditor
              key={selectedIndex}
              slide={currentSlide}
              onChange={(updated) => updateSlide(selectedIndex, updated)}
            />
            {currentSlide.type === "content" && currentSlide.speakerNote && (
              <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-sm text-yellow-700">
                📝 発表者メモ: {currentSlide.speakerNote}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
