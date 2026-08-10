"use client";

import { useState } from "react";
import { extractChunks } from "@/lib/parseDeliverable";

// 壁打ちの「元になる資料」を読み込む部品。3つのモード（成果物・スライド・提出文書）
// で共通して使う。
//
// 解析はブラウザ側でやる（成果物の登録と同じ lib/parseDeliverable）。サーバーへ
// 送るのは抽出済みのテキストだけで、ファイルそのものは送らない。
//   ・Vercelのリクエスト上限4.5MBに、資料の実体で当たらずに済む
//     （ラーメンの写真で実際に踏んだ。base64は約1.33倍に膨らむ）
//   ・生ファイルをどこにも保存しないので、置き場所と消し忘れの管理が要らない
//
// 登録は任意。無くても壁打ちは始められる（土台が増えるほど質問が具体的になる、
// というだけのもの）。

type Props = {
  label: string;
  hint: string;
  onExtracted: (text: string, filename: string) => void;
  disabled?: boolean;
};

// 解析器が扱えるもの＋その場で読める素のテキスト。
const ACCEPT = ".pptx,.docx,.pdf,.txt,.md,.markdown";
const PLAIN = /\.(txt|md|markdown)$/i;

// 長すぎる資料は落とす。壁打ちの土台はプロンプトに載せるものなので、
// 際限なく積むと本題（会話）が押し出される。
const MAX_CHARS = 60_000;

export default function DocUpload({ label, hint, onExtracted, disabled }: Props) {
  const [name, setName] = useState("");
  const [chars, setChars] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // 同じファイルを選び直せるように、読み取り前に入力欄を空にする
    e.target.value = "";
    if (!file) return;

    setBusy(true);
    setErr(null);
    try {
      let text: string;
      if (PLAIN.test(file.name)) {
        text = await file.text();
      } else {
        const chunks = await extractChunks(await file.arrayBuffer(), file.name);
        text = chunks.map((c) => `【${c.pos}】\n${c.content}`).join("\n\n");
      }
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("文字が取り出せませんでした（画像だけの資料かもしれません）");
      }
      const capped =
        trimmed.length > MAX_CHARS
          ? `${trimmed.slice(0, MAX_CHARS)}\n\n（長いため${MAX_CHARS}字で打ち切りました）`
          : trimmed;
      setName(file.name);
      setChars(capped.length);
      onExtracted(capped, file.name);
    } catch (e) {
      setName("");
      setChars(0);
      onExtracted("", "");
      setErr(e instanceof Error ? e.message : "読み込みに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setName("");
    setChars(0);
    setErr(null);
    onExtracted("", "");
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-600">{label}</label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <label
          className={`cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition active:bg-gray-50 ${
            disabled || busy ? "pointer-events-none opacity-50" : ""
          }`}
        >
          {busy ? "読み込み中…" : "ファイルを選ぶ"}
          <input
            type="file"
            accept={ACCEPT}
            onChange={onPick}
            disabled={disabled || busy}
            className="hidden"
          />
        </label>
        {name && (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
              📄 {name}
              <span className="ml-1 text-xs text-gray-400">{chars.toLocaleString()}字</span>
            </span>
            <button
              type="button"
              onClick={clear}
              disabled={disabled}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-gray-400 transition active:bg-gray-100 active:text-rose-500"
              aria-label="登録した資料を外す"
            >
              ✕
            </button>
          </>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-400">{hint}</p>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}
