"use client";

import { useState } from "react";
import { HOJIN_SEIKYU_QA_URL } from "@/lib/externalLinks";

// 合言葉の入力フォーム。app/login/page.tsx と同じ作り。
// 成功したら外部のQA検索サイトへ移動する（cookieは/api/qa-gateが発行済み）。

export default function QaGateForm() {
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!passphrase.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/qa-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError((d && d.error) || "確認に失敗しました");
        return;
      }
      // cookie が付いたので実サイトへ。以後この端末では合言葉なしで通る
      // （/qa-gate を開き直すとサーバー側でcookieを見て自動で送り出す）。
      window.location.href = HOJIN_SEIKYU_QA_URL;
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-6 pt-[env(safe-area-inset-top)]">
      <h1 className="text-center text-2xl font-bold tracking-tight text-gray-900">
        法人請求QA検索
      </h1>
      <p className="mt-2 text-center text-sm text-gray-500">合言葉を入力してください</p>

      <form
        className="mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="relative">
          <input
            type={showPassphrase ? "text" : "password"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder="合言葉"
            disabled={loading}
            className="block w-full rounded-xl border border-gray-300 px-4 py-3 pr-12 text-base text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setShowPassphrase((v) => !v)}
            disabled={loading}
            aria-label={showPassphrase ? "合言葉を隠す" : "合言葉を表示する"}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-lg text-gray-400 active:opacity-70 disabled:opacity-40"
          >
            {showPassphrase ? "🙈" : "👁"}
          </button>
        </div>
        <button
          type="submit"
          disabled={loading || !passphrase.trim()}
          className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
        >
          {loading ? "確認中..." : "QAを開く"}
        </button>
        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        )}
      </form>

      <p className="mt-6 text-center text-xs leading-relaxed text-gray-400">
        一度入力すればこの端末では以後不要です
      </p>
    </main>
  );
}
