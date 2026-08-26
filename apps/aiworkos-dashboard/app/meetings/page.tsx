"use client";

import Link from "next/link";
import { useState } from "react";
import { extractChunks, windowChunks, type Chunk } from "@/lib/parseDeliverable";
import StakeholderPicker, {
  rememberStakeholder,
  type Category,
} from "@/app/components/StakeholderPicker";

// 議事録の登録。app/deliverables/page.tsx とほぼ同じ作りだが、書き込み先の
// バケツが違う（source_type: "会議" ／ app/api/meetings/route.ts）。
//
// これまで議事録は「成果物を登録」の種別「メモ」で代用されていたが、それだと
// 振り返りの月次「会議◯件」集計にも、団体別攻略の「会議録から関係を抽出」にも
// 反映されなかった（この2つは source_type=会議 しか見ないため）。PLAUD録音が
// あれば自動で会議バケツに入るが、録音の無い議事メモ（口頭で聞いた話、後で
// 打った要約など）を手で会議バケツへ入れる場所がこれまで無かった——このページ
// がそれを埋める。

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp"];

function isImageFile(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXT.includes(ext);
}

/** File を base64（data URL のヘッダを除いた本体）にする。 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.replace(/^data:[^;]+;base64,/, ""));
    };
    reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MeetingsPage() {
  const [organization, setOrganization] = useState("");
  const [category, setCategory] = useState<Category>("自治体");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [filename, setFilename] = useState("");
  const [text, setText] = useState("");
  const [fileChunks, setFileChunks] = useState<Chunk[]>([]);
  const [textChunks, setTextChunks] = useState<Chunk[]>([]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    stored: number;
    total: number;
    correctionMessage?: string | null;
    organization: string;
    category: Category;
    title: string;
  } | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  function onCategoryChange(next: Category) {
    setCategory(next);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setResult(null);
    setFileChunks([]);
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const stem = file.name.replace(/\.[^.]+$/, "");
    if (!title) setTitle(stem);
    setParsing(true);
    try {
      if (isImageFile(file.name)) {
        const data = await toBase64(file);
        const res = await fetch("/api/deliverables/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data, filename: file.name }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json?.error ?? "画像の読み取りに失敗しました");
          return;
        }
        setFileChunks(json.chunks ?? []);
        return;
      }
      const buf = await file.arrayBuffer();
      const parsed = await extractChunks(buf, file.name);
      if (parsed.length === 0) {
        setError("テキストを抽出できませんでした（中身が空の可能性）");
      }
      setFileChunks(parsed);
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
    setTextChunks(windowChunks(value, "text"));
  }

  const busy = parsing || submitting;
  const chunks = [...fileChunks, ...textChunks];

  async function onSubmit() {
    setError(null);
    setResult(null);
    if (!organization.trim()) return setError(`${category}名を選んでください`);
    if (!title.trim()) return setError("会議のタイトルを入力してください");
    if (chunks.length === 0) {
      return setError("ファイルを選ぶか、議事録のテキストを貼り付けてください");
    }
    const effectiveTitle = title.trim();
    const effectiveFilename = filename || `text:${effectiveTitle}:${date}`;

    setSubmitting(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: organization.trim(),
          category,
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
        setResult({
          stored: data.stored,
          total: data.total,
          correctionMessage: data.correctionMessage ?? null,
          organization: organization.trim(),
          category,
          title: effectiveTitle,
        });
        rememberStakeholder(category, organization.trim());
        // 相手先・日付は「続けて登録する」で使い回せるよう残す。
        setFilename("");
        setTitle("");
        setText("");
        setFileChunks([]);
        setTextChunks([]);
        setFileInputKey((k) => k + 1);
      }
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">議事録を登録</h1>
        <p className="mt-1 text-sm text-gray-500">
          PLAUD録音の無い議事メモ・口頭で聞いた話を、団体別攻略・振り返り・提案エージェントに反映させます
        </p>
      </header>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        {/* 相手先（カテゴリー → 具体名） */}
        <StakeholderPicker
          category={category}
          onCategoryChange={onCategoryChange}
          name={organization}
          onNameChange={setOrganization}
          disabled={busy}
        />

        {/* タイトル・実施日 */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">会議のタイトル</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              placeholder="例：課題ヒアリング、定例訪問"
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">実施日</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-gray-400">
              登録した日ではなく、実際に会議があった日を入れてください（月次の集計はこの日付を使います）
            </p>
          </div>
        </div>

        {/* ファイル（画像も可）。テキストと併用できる */}
        <div className="border-t border-gray-100 pt-4">
          <label className="block text-sm font-medium text-gray-600">
            ファイル（.pptx / .docx / .pdf / 画像）
          </label>
          <input
            key={fileInputKey}
            type="file"
            accept=".pptx,.docx,.pdf,.jpg,.jpeg,.png,.gif,.webp"
            onChange={onFile}
            disabled={busy}
            className="mt-2 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 disabled:opacity-50"
          />
          {parsing && (
            <p className="mt-2 text-xs text-gray-400">
              {filename && isImageFile(filename) ? "画像を読み取り中..." : "解析中..."}
            </p>
          )}
        </div>

        {/* テキスト。ファイルへの補足として一緒に登録できる */}
        <div>
          <label className="block text-sm font-medium text-gray-600">議事録の本文</label>
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            disabled={busy}
            rows={8}
            placeholder="話した内容・出た課題・次の一手をここに貼り付け（ファイルと一緒に登録できます）"
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
        </div>

        {/* 抽出プレビュー */}
        {!parsing && chunks.length > 0 && (
          <div className="rounded-lg bg-purple-50 p-3">
            <p className="text-xs font-medium text-purple-800">
              {chunks.length}個のチャンクを検出しました
              {fileChunks.length > 0 && textChunks.length > 0
                ? `（ファイル${fileChunks.length} ＋ テキスト${textChunks.length}）`
                : ""}
            </p>
            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-purple-900/70">
              {chunks[0].content.slice(0, 200)}
            </p>
          </div>
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
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
            {error}
          </p>
        )}
        {result &&
          (result.stored < result.total ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              ⚠️ {result.organization}（{result.category}）の「{result.title}」は{" "}
              {result.total} チャンク中 {result.stored} 件しか登録できませんでした。
              残りは入っていません。時間をおいて同じ内容をもう一度登録してください（登録済み分は上書きされます）。
            </div>
          ) : (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
              ✅ {result.organization}（{result.category}）の「{result.title}」を{" "}
              {result.stored}/{result.total} チャンク登録しました。団体別攻略のタイムライン・振り返り・提案エージェントに反映されます。
              <span className="mt-2 flex flex-wrap items-center gap-3">
                <Link
                  href={`/organizations?org=${encodeURIComponent(result.organization)}`}
                  className="font-semibold text-emerald-700 underline active:opacity-70"
                >
                  → 団体別攻略
                </Link>
                <Link
                  href={`/agent?org=${encodeURIComponent(result.organization)}`}
                  className="font-semibold text-emerald-700 underline active:opacity-70"
                >
                  → 提案エージェント
                </Link>
                <button
                  type="button"
                  onClick={() => setResult(null)}
                  className="rounded-lg border border-emerald-300 bg-white px-3 py-1 font-semibold text-emerald-700 active:opacity-70"
                >
                  続けて登録する
                </button>
              </span>
            </div>
          ))}
        {result?.correctionMessage && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            {result.correctionMessage}
          </p>
        )}
      </div>

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}
