"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 合言葉の入力画面。初回だけ入力すれば cookie（1年）で以後は素通り。
// 認証の本体は proxy.ts / app/api/login/route.ts。

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "/";

  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!passphrase.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError((d && d.error) || "ログインに失敗しました");
        return;
      }
      // cookie が付いたので、来ようとしていたページへ
      router.replace(nextPath.startsWith("/") ? nextPath : "/");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-6 pt-[env(safe-area-inset-top)]">
      <h1 className="text-center text-2xl font-bold tracking-tight text-gray-900">
        AIワークOS
      </h1>
      <p className="mt-2 text-center text-sm text-gray-500">合言葉を入力してください</p>

      <form
        className="mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
          autoComplete="current-password"
          placeholder="合言葉"
          disabled={loading}
          className="block w-full rounded-xl border border-gray-300 px-4 py-3 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !passphrase.trim()}
          className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
        >
          {loading ? "確認中..." : "入る"}
        </button>
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </form>

      <p className="mt-6 text-center text-xs leading-relaxed text-gray-400">
        一度入力すればこの端末では1年間有効です
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}>
      <LoginInner />
    </Suspense>
  );
}
