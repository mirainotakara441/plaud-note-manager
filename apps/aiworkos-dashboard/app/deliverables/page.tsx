"use client";

import Link from "next/link";
import { useState } from "react";
import { extractChunks, windowChunks, type Chunk } from "@/lib/parseDeliverable";
import StakeholderPicker, {
  rememberStakeholder,
  type Category,
} from "@/app/components/StakeholderPicker";

// 種別は相手先によって書くものが違う。社内は議事メモ・実施理由書・QA表が主で、
// 提案書・実習書は出てこない（API側 app/api/deliverables/route.ts と対で持つ）。
const DOC_TYPES_EXTERNAL = [
  "提案書",
  "実習書",
  "スライド",
  "報告書",
  "メモ",
  "その他",
] as const;
const DOC_TYPES_INTERNAL = [
  "スライド",
  "議事メモ",
  "実施理由書",
  "QA表",
  "その他",
] as const;

function docTypesFor(category: Category): readonly string[] {
  return category === "社内" ? DOC_TYPES_INTERNAL : DOC_TYPES_EXTERNAL;
}

// 画像はブラウザでは文字を取り出せないので、サーバー（/api/deliverables/image）で
// AIに読ませる。ChatGPTで作った戦略インフォグラフィックをiPhoneのスクショで
// 保存する使い方が主。
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

export default function DeliverablesPage() {
  const [organization, setOrganization] = useState("");
  const [category, setCategory] = useState<Category>("自治体");
  const [docType, setDocType] = useState<string>("提案書");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [filename, setFilename] = useState("");
  const [text, setText] = useState("");
  // ファイル由来とテキスト由来を別々に持ち、登録時に連結する。
  // 以前は片方しか使えなかったが、インフォグラフィックに口頭の補足を添えたい
  // ケースが多いため併用できるようにした。
  const [fileChunks, setFileChunks] = useState<Chunk[]>([]);
  const [textChunks, setTextChunks] = useState<Chunk[]>([]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // correctionMessage は「音声入力の誤変換を辞書で直した内訳」。
  // 実際に置換したものがある時だけAPIが文言を返す（無ければ null）。
  const [result, setResult] = useState<{
    stored: number;
    total: number;
    correctionMessage?: string | null;
  } | null>(null);

  // カテゴリーを変えたとき、その相手先に無い種別が選ばれたままにならないようにする
  // （社内→自治体で「議事メモ」が残ると、APIは通るが選択肢に無い値が入る）。
  function onCategoryChange(next: Category) {
    setCategory(next);
    const allowed = docTypesFor(next);
    if (!allowed.includes(docType)) setDocType(allowed[0]);
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

  async function onSubmit() {
    setError(null);
    setResult(null);
    if (!organization.trim()) return setError(`${category}名を選んでください`);
    if (chunks.length === 0) {
      return setError("ファイルを選ぶか、テキストを貼り付けてください");
    }
    const effectiveTitle = title.trim() || filename || "無題";
    // ファイルが無い（テキストだけ）ときは実ファイル名が無いので、
    // source_id を安定させるために資料名+日付から名前を作る。
    const effectiveFilename = filename || `text:${effectiveTitle}:${date}`;

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
        setResult({
          stored: data.stored,
          total: data.total,
          correctionMessage: data.correctionMessage ?? null,
        });
        // 一覧に無い相手なら次回から選択肢に出す
        rememberStakeholder(category, organization.trim());
      }
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = parsing || submitting;
  const chunks = [...fileChunks, ...textChunks];

  // 登録に足りていないものを可視化する（押せない理由が分からない状態を作らない）
  const missing: string[] = [];
  if (chunks.length === 0) missing.push("ファイルかテキスト");
  if (!organization.trim()) missing.push(`${category}名`);

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
          提案書・スライド・議事メモ・インフォグラフィックを取り込み、提案エージェントの土台にします
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

        {/* ファイル（画像も可）。テキストと併用できる */}
        <div className="border-t border-gray-100 pt-4">
          <label className="block text-sm font-medium text-gray-600">
            ファイル（.pptx / .docx / .pdf / 画像）
          </label>
          <input
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
          <p className="mt-2 text-xs text-gray-400">
            ※インフォグラフィックのスクショはAIが文字を起こします（3.5MBまで）。スキャン画像のPDFは文字を取り出せないことがあります。
          </p>
        </div>

        {/* テキスト。ファイルへの補足として一緒に登録できる */}
        <div>
          <label className="block text-sm font-medium text-gray-600">
            テキスト（メモ・構成案・メール本文など）
          </label>
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            disabled={busy}
            rows={6}
            placeholder="ここに貼り付け（ファイルと一緒に登録できます）"
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
        </div>

        {/* 抽出プレビュー（何が取り込まれるか目視で確認できるように） */}
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

        {/* 種別・日付 */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600">種別</label>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              disabled={busy}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            >
              {docTypesFor(category).map((t) => (
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
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
            {error}
          </p>
        )}
        {result && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            ✅ {organization}（{category}）の「{title}」を {result.stored}/
            {result.total} チャンク登録しました。提案エージェントで参照されます。
          </p>
        )}
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
