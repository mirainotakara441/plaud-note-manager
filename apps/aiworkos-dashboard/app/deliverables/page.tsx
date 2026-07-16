"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { extractChunks, windowChunks, type Chunk } from "@/lib/parseDeliverable";

type Organization = { name: string; count: number };

const DOC_TYPES = ["提案書", "実習書", "スライド", "報告書", "メモ", "その他"] as const;
const CATEGORIES = ["自治体", "議員", "事業者", "その他"] as const;
type Mode = "file" | "text";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DeliverablesPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [mode, setMode] = useState<Mode>("file");
  const [organization, setOrganization] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("自治体");
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]>("提案書");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [filename, setFilename] = useState("");
  const [text, setText] = useState("");
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

  function switchMode(next: Mode) {
    setMode(next);
    setChunks([]);
    setError(null);
    setResult(null);
  }

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

  function onText(value: string) {
    setText(value);
    setError(null);
    setResult(null);
    setChunks(windowChunks(value, "text"));
  }

  async function onSubmit() {
    setError(null);
    setResult(null);
    if (!organization.trim()) return setError("対象（団体・議員名）を入力してください");
    if (chunks.length === 0) {
      return setError(
        mode === "file"
          ? "先にファイルを選択してください"
          : "先にテキストを貼り付けてください"
      );
    }
    const effectiveTitle = title.trim() || filename || "無題";
    // テキスト貼り付けは実ファイルが無いので、source_id 安定用に資料名+日付から名前を作る
    const effectiveFilename =
      mode === "text" ? `text:${effectiveTitle}:${date}` : filename;

    setSubmitting(true);
    try {
      const res = await fetch("/api/deliverables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: organization.trim(),
          category,
          docType,
          title: effectiveTitle,
          date,
          filename: effectiveFilename,
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

  // 登録に足りていないものを可視化する（押せない理由が分からない状態を作らない）
  const missing: string[] = [];
  if (chunks.length === 0) missing.push(mode === "file" ? "ファイル" : "テキスト");
  if (!organization.trim()) missing.push("対象名");

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-600 active:opacity-70"
        >
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          成果物を登録
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          団体・議員向けに作った提案書・実習書・スライド・メモを取り込み、提案エージェントの土台にします
        </p>
      </header>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        {/* 入力方法の切替 */}
        <div className="flex gap-2">
          {(["file", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              disabled={busy}
              className={`min-h-11 flex-1 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
                mode === m
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 active:bg-gray-200"
              }`}
            >
              {m === "file" ? "ファイル" : "テキストを貼る"}
            </button>
          ))}
        </div>

        {/* ファイル or テキスト */}
        {mode === "file" ? (
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
            {parsing && <p className="mt-2 text-xs text-gray-400">解析中...</p>}
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-gray-600">
              テキスト（メモ・構成案・メール本文など）
            </label>
            <textarea
              value={text}
              onChange={(e) => onText(e.target.value)}
              disabled={busy}
              rows={8}
              placeholder="ここに貼り付け"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>
        )}
        {!parsing && chunks.length > 0 && (
          <p className="-mt-2 text-xs font-medium text-purple-700">
            {chunks.length}個のチャンクを検出しました
          </p>
        )}

        {/* 対象・カテゴリー */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">
              対象（団体・議員名）
            </label>
            <input
              type="text"
              list="org-list"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              disabled={busy}
              placeholder="例: 北九州市 / 辻議員"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
            <datalist id="org-list">
              {orgs.map((o) => (
                <option key={o.name} value={o.name} />
              ))}
            </datalist>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">
              カテゴリー
            </label>
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as (typeof CATEGORIES)[number])
              }
              disabled={busy}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
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

        {/* 何が足りないかを常に見せる（ボタンは押せる状態にして、押したら理由を出す） */}
        {missing.length > 0 && (
          <p className="text-xs text-amber-700">
            登録するには {missing.join(" と ")} が必要です
          </p>
        )}

        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
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
            ✅ {organization}（{category}）の「{title}」を {result.stored}/
            {result.total} チャンク登録しました。提案エージェントで参照されます。
          </p>
        )}
      </div>
    </main>
  );
}
