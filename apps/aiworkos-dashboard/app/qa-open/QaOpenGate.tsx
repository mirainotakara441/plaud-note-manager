"use client";

import { useState } from "react";

// /qa-open の入口フォーム。名前・メールアドレス（・所属）を登録して閲覧を始める。
// 登録すると /api/qa-open/enter が来訪者 cookie を発行するので、フル遷移で読み直す。

export default function QaOpenGate({ total }: { total: number }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [org, setOrg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (loading) return;
    setError(null);
    if (!name.trim()) return setError("お名前を入力してください");
    if (!email.trim()) return setError("メールアドレスを入力してください");
    setLoading(true);
    try {
      const r = await fetch("/api/qa-open/enter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, org }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError((d && d.error) || "登録に失敗しました");
        return;
      }
      window.location.href = "/qa-open";
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  const field =
    "w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-base text-gray-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200";

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-6 py-10 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <p className="text-center text-xs font-medium tracking-widest text-indigo-600">
        法人請求オンラインサービス
      </p>
      <h1 className="mt-2 text-center text-2xl font-bold tracking-tight text-gray-900">
        想定問答集（公開版）
      </h1>
      <p className="mt-3 text-center text-sm leading-relaxed text-gray-600">
        自治体の皆様からよく伺うご質問・ご懸念と、その回答を{total}件収録しています。
        <br />
        閲覧にはお名前とメールアドレスの登録をお願いしています。
      </p>

      <form
        className="mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">お名前（必須）</span>
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="例：山田 太郎"
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">メールアドレス（必須）</span>
          <input
            className={field}
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="例：taro@example.jp"
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">ご所属（任意）</span>
          <input
            className={field}
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            autoComplete="organization"
            placeholder="例：○○市 市民課"
          />
        </label>

        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-2 w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-60"
        >
          {loading ? "登録中…" : "登録して閲覧する"}
        </button>
        <p className="pt-2 text-center text-[11px] leading-relaxed text-gray-400">
          ご登録いただいた情報は、本問答集の閲覧状況の把握と、ご意見への返信にのみ使用します。
        </p>
      </form>
    </main>
  );
}
