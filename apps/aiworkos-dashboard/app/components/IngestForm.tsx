"use client";

import Link from "next/link";
import { useState } from "react";
import { extractChunks, windowChunks, type Chunk } from "@/lib/parseDeliverable";
import StakeholderPicker, {
  rememberStakeholder,
  type Category,
} from "@/app/components/StakeholderPicker";

// 「相手先＋ファイル/テキスト → チャンク化 → APIへ登録」の共通フォーム。
//
// もともと app/deliverables/page.tsx（成果物）と app/meetings/page.tsx（議事録）が
// ほぼ同一の実装を二重に持っていた（isImageFile / toBase64 / チャンク分割 /
// StakeholderPicker / 送信フローまで同じで、違いは書き込み先の source_type と
// 文言・レイアウトの一部だけ）。片方だけ直して片方を直し忘れる事故を防ぐため、
// 共通部をここへ集約し、両ページは IngestFormConfig を渡すだけの薄いラッパーにした。
// ページごとの差分（送信先API・見出し・ラベル・種別セレクトの有無など）は
// すべて設定オブジェクト側に残している。

/** 登録成功メッセージに並べる遷移リンク。href は登録した相手先名から組み立てる。 */
export type IngestSuccessLink = {
  label: string;
  href: (organization: string) => string;
};

export type IngestFormConfig = {
  /** ページ見出し（h1） */
  heading: string;
  /** 見出し下の説明文 */
  description: string;
  /** 送信先API（例: "/api/deliverables"）。POSTボディの形は両APIで共通 */
  apiPath: string;
  /**
   * 種別セレクト（成果物のみ）。指定すると「種別・日付」の行が本文の下に出て、
   * POSTボディに docType が含まれる。無ければ種別欄ごと出さない（議事録）。
   */
  docType?: { label: string; options: readonly string[]; initial: string };
  title: {
    label: string;
    placeholder: string;
    /**
     * true: 日付と並べてフォーム上部（相手先の直下）に置く（議事録）。
     * false: 本文の下に単独で置く（成果物）。日付は種別と同じ行に入る。
     */
    atTop: boolean;
    /**
     * 未入力を弾くときのエラー文（議事録）。
     * 未指定なら空でも通し、ファイル名 → 「無題」の順でフォールバックする（成果物）。
     */
    requiredError?: string;
  };
  date: {
    label: string;
    /** 日付欄の下の但し書き（議事録の「実際に会議があった日を〜」など） */
    note?: string;
  };
  /** ファイル欄の但し書き（成果物の「スクショはAIが文字を起こします」など） */
  fileNote?: string;
  text: { label: string; placeholder: string; rows: number };
  /** ファイルもテキストも無いまま登録しようとしたときのエラー文 */
  emptyChunksError: string;
  /** 「登録するには◯◯が必要です」ヒントを出すか（成果物のみ） */
  showMissingHint?: boolean;
  success: {
    /** 成功メッセージ「〜チャンク登録しました。」に続く文末 */
    tail: string;
    links: IngestSuccessLink[];
  };
};

// 画像はブラウザでは文字を取り出せないので、サーバー（/api/deliverables/image）で
// AIに読ませる。ChatGPTで作った戦略インフォグラフィックをiPhoneのスクショで
// 保存する使い方が主。議事録側もこの読み取りAPIを共用している（読み取るだけで
// 書き込み先はページごとの apiPath が決める）。
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

export default function IngestForm({ config }: { config: IngestFormConfig }) {
  const [organization, setOrganization] = useState("");
  const [category, setCategory] = useState<Category>("自治体");
  const [docType, setDocType] = useState<string>(config.docType?.initial ?? "");
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
  // organization / category / title は登録した時点の値のスナップショット
  // （成功後に入力をクリアしても、メッセージには登録した内容を出し続けるため）。
  const [result, setResult] = useState<{
    stored: number;
    total: number;
    correctionMessage?: string | null;
    organization: string;
    category: Category;
    title: string;
  } | null>(null);
  // 成功後に <input type="file"> を空へ戻すための強制再マウント用キー
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
    if (config.title.requiredError && !title.trim()) {
      return setError(config.title.requiredError);
    }
    if (chunks.length === 0) {
      return setError(config.emptyChunksError);
    }
    // タイトル必須のページではここで title.trim() が必ず入っている。
    // 任意のページ（成果物）だけがファイル名 → 「無題」へ落ちる。
    const effectiveTitle = title.trim() || filename || "無題";
    // ファイルが無い（テキストだけ）ときは実ファイル名が無いので、
    // source_id を安定させるために資料名+日付から名前を作る。
    const effectiveFilename = filename || `text:${effectiveTitle}:${date}`;

    setSubmitting(true);
    try {
      const res = await fetch(config.apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: organization.trim(),
          category,
          ...(config.docType ? { docType } : {}),
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
        // 一覧に無い相手なら次回から選択肢に出す
        rememberStakeholder(category, organization.trim());
        // 二度押しで同じ内容が重複登録されないよう、本文側の入力はここで空にする
        // （相手先・種別・日付は「続けて登録する」で使い回せるよう残す）。
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

  // 登録に足りていないものを可視化する（押せない理由が分からない状態を作らない）
  const missing: string[] = [];
  if (chunks.length === 0) missing.push("ファイルかテキスト");
  if (!organization.trim()) missing.push(`${category}名`);

  // 日付欄はページによって置き場所が違う（議事録: 上部のタイトル行／成果物: 種別の行）
  // ので、同じ入力を1つだけ定義して両方から差し込む。
  const dateField = (
    <div className="flex-1">
      <label className="block text-sm font-medium text-gray-600">{config.date.label}</label>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        disabled={busy}
        className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
      />
      {config.date.note && (
        <p className="mt-1 text-xs text-gray-400">{config.date.note}</p>
      )}
    </div>
  );

  const titleField = (
    <input
      type="text"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      disabled={busy}
      placeholder={config.title.placeholder}
      className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
    />
  );

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
          {config.heading}
        </h1>
        <p className="mt-1 text-sm text-gray-500">{config.description}</p>
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

        {/* タイトル・日付（上部レイアウトのページのみ） */}
        {config.title.atTop && (
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-600">
                {config.title.label}
              </label>
              {titleField}
            </div>
            {dateField}
          </div>
        )}

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
          {config.fileNote && (
            <p className="mt-2 text-xs text-gray-400">{config.fileNote}</p>
          )}
        </div>

        {/* テキスト。ファイルへの補足として一緒に登録できる */}
        <div>
          <label className="block text-sm font-medium text-gray-600">
            {config.text.label}
          </label>
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            disabled={busy}
            rows={config.text.rows}
            placeholder={config.text.placeholder}
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

        {/* 種別・日付（種別セレクトを持つページのみ） */}
        {config.docType && (
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-600">
                {config.docType.label}
              </label>
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
                disabled={busy}
                className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
              >
                {config.docType.options.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {dateField}
          </div>
        )}

        {/* タイトル（下部レイアウトのページのみ） */}
        {!config.title.atTop && (
          <div>
            <label className="block text-sm font-medium text-gray-600">
              {config.title.label}
            </label>
            {titleField}
          </div>
        )}

        {/* 何が足りないかを常に見せる（ボタンは押せる状態にして、押したら理由を出す） */}
        {config.showMissingHint && missing.length > 0 && (
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
        {result &&
          (result.stored < result.total ? (
            // 一部しか入らなかったのに緑で「成功」と出すと取りこぼしに気づけない
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              ⚠️ {result.organization}（{result.category}）の「{result.title}」は{" "}
              {result.total} チャンク中 {result.stored} 件しか登録できませんでした。
              残りは入っていません。時間をおいて同じ内容をもう一度登録してください（登録済み分は上書きされます）。
            </div>
          ) : (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
              ✅ {result.organization}（{result.category}）の「{result.title}」を{" "}
              {result.stored}/{result.total} チャンク登録しました。{config.success.tail}
              <span className="mt-2 flex flex-wrap items-center gap-3">
                {config.success.links.map((link) => (
                  <Link
                    key={link.label}
                    href={link.href(result.organization)}
                    className="font-semibold text-emerald-700 underline active:opacity-70"
                  >
                    {link.label}
                  </Link>
                ))}
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
