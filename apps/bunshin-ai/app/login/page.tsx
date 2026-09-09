"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 合言葉＋名前の入力画面。名前は相談ログに残すために取る（誰の相談かを見えるようにする）。
// 認証の本体は proxy.ts / app/api/login/route.ts。

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = params.get("next") ?? "/";

  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !passphrase.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase, name }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError((d && d.error) || "ログインに失敗しました");
        return;
      }
      router.replace(nextPath.startsWith("/") ? nextPath : "/");
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[85vh] max-w-sm flex-col justify-center px-6">
      <h1 className="text-center text-2xl font-bold tracking-tight">法人請求オンラインサービス相談AI</h1>
      <p className="mt-2 text-center text-sm text-slate-500">
        お名前と合言葉を入力してください
      </p>

      <form
        className="mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="お名前（例：山田）"
          autoComplete="name"
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base outline-none focus:border-blue-600"
        />
        <div className="relative">
          <input
            type={show ? "text" : "password"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="合言葉"
            autoComplete="current-password"
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 pr-16 text-base outline-none focus:border-blue-600"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-sm text-slate-500"
          >
            {show ? "隠す" : "表示"}
          </button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading || !name.trim() || !passphrase.trim()}
          className="w-full rounded-xl bg-blue-800 px-4 py-3 text-base font-semibold text-white disabled:opacity-40"
        >
          {loading ? "確認中..." : "入る"}
        </button>
      </form>

      <p className="mt-8 text-center text-xs leading-relaxed text-slate-400">
        ここでの相談内容とお名前は記録され、吉井さんが見られる形で残ります。
        <br />
        評価や査定には使いません。
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
