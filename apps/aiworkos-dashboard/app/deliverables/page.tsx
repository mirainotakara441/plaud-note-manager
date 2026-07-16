"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { extractChunks, type Chunk } from "@/lib/parseDeliverable";

type Organization = { name: string; count: number };

const DOC_TYPES = ["提案書", "実習書", "スライド", "報告書", "その他"] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DeliverablesPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [organization, setOrganization] = useState("");
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]>("提案書");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [filename, setFilename] = useState("");
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ stored: number; total: number } | null>(
    null
  );

  useEffect(() => {
    fetch("/api/organizations")
      .then((r) => r.json())
      .then((d) => setOrgs(Array.isArray(d?.organizations) ? d.organizations : []))
      .catch(() => setOrgs([]));
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setResult(null);
    setChunks([]);
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const stem = file.name.replace(/\.[^.]+$/, "");
    if (!title) setTitle(stem);
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const parsed = await extractChunks(buf, file.name);
      if (parsed.length === 0) {
        setError("テキストを抽出できませんでした（中身が空の可能性）");
      }
      setChunks(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ファイルの解析に失敗しました");
    } finally {
      setParsing(false);
    }
  }

  async function onSubmit() {
    setError(null);
    setResult(null);
    if (!organization.trim()) return setError("団体名を入力してください");
    if (chunks.length === 0) return setError("先にファイルを選択してください");
    setSubmitting(true);
    try {
      const res = await fetch("/api/deliverables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: organization.trim(),
          docType,
          title: title.trim() || filename,
          date,
          filename,
          chunks,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "登録に失敗しました");
      } else {
        setResult({ stored: data.stored, total: data.total });
      }
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = parsing || submitting;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-600 active:opacity-70"
        >
          ← 横断検索へ
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          成果物を登録
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          団体向けに作った提案書・実習書・スライド等を取り込み、提案エージェントの土台にします
        </p>
      </header>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        {/* ファイル */}
        <div>
          <label className="block text-sm font-medium text-gray-600">
            ファイル（.pptx / .docx）
          </label>
          <input
            type="file"
            accept=".pptx,.docx"
            onChange={onFile}
            disabled={busy}
            className="mt-2 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 disabled:opacity-50"
          />
          {parsing && (
            <p className="mt-2 text-xs text-gray-400">解析中...</p>
          )}
          {!parsing && chunks.length > 0 && (
            <p className="mt-2 text-xs font-medium text-purple-700">
              {chunks.length}個のチャンクを検出しました
            </p>
          )}
        </div>

        {/* 団体 */}
        <div>
          <label className="block text-sm font-medium text-gray-600">
            団体名（会議・提案エージェントと同じ表記に）
          </label>
          <input
            type="text"
            list="org-list"
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
            disabled={busy}
            placeholder="例: 北九州市"
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
          <datalist id="org-list">
            {orgs.map((o) => (
              <option key={o.name} value={o.name} />
            ))}
          </datalist>
        </div>

        {/* 種別・日付 */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">種別</label>
            <select
              value={docType}
              onChange={(e) =>
                setDocType(e.target.value as (typeof DOC_TYPES)[number])
              }
              disabled={busy}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            >
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">日付</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>
        </div>

        {/* 資料名 */}
        <div>
          <label className="block text-sm font-medium text-gray-600">資料名</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            placeholder="例: 北九州市 法人請求オンラインサービス 導入提案"
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || chunks.length === 0 || !organization.trim()}
          className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
        >
          {submitting ? "登録中..." : "登録する"}
        </button>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {result && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            ✅ {organization} の「{title}」を {result.stored}/{result.total} チャンク登録しました。
            提案エージェントで参照されます。
          </p>
        )}
      </div>
    </main>
  );
}
