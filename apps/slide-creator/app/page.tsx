"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [audience, setAudience] = useState("");
  const [purpose, setPurpose] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!audience.trim() || !purpose.trim() || !message.trim()) {
      setError("すべての項目を入力してください");
      return;
    }
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, purpose, message }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "生成に失敗しました");
      }

      const slideData = await res.json();
      sessionStorage.setItem("slideData", JSON.stringify(slideData));
      router.push("/slides");
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 flex flex-col">
      <header className="py-6 px-6 flex items-center gap-3">
        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
          <span className="text-white font-bold text-sm">S</span>
        </div>
        <span className="text-indigo-700 font-bold text-lg">SlideCreator AI</span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-10">
            <h1 className="text-4xl font-bold text-gray-800 mb-3">
              スライド、AIに任せよう✨
            </h1>
            <p className="text-gray-500 text-lg">
              3つの質問に答えるだけで、わかりやすい発表スライドを自動生成！
            </p>
          </div>

          <form onSubmit={handleSubmit} className="bg-white rounded-3xl shadow-xl p-8 space-y-6">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">
                👥 誰に発表しますか？
              </label>
              <input
                type="text"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="例：クラスの同級生、先生、保護者"
                className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-gray-700 focus:outline-none focus:border-indigo-400 transition-colors"
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">
                🎯 発表の目的は？
              </label>
              <input
                type="text"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="例：環境問題について知ってもらう、文化祭の企画を提案する"
                className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-gray-700 focus:outline-none focus:border-indigo-400 transition-colors"
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">
                💡 一番伝えたいことは？
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="例：プラスチックごみを減らすために、学校でのマイボトル持参を推進したい"
                rows={3}
                className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-gray-700 focus:outline-none focus:border-indigo-400 transition-colors resize-none"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-bold py-4 rounded-xl text-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  AIがスライドを作成中…
                </>
              ) : (
                <>✨ スライドを生成する</>
              )}
            </button>
          </form>

          <div className="mt-8 grid grid-cols-3 gap-4 text-center">
            {[
              { icon: "🤖", text: "AIが自動生成" },
              { icon: "✏️", text: "ブラウザで編集" },
              { icon: "📥", text: "PPTXでダウンロード" },
            ].map(({ icon, text }) => (
              <div key={text} className="bg-white/60 rounded-2xl p-4">
                <div className="text-3xl mb-1">{icon}</div>
                <div className="text-sm font-medium text-gray-600">{text}</div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
