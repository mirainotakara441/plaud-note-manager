"use client";

import { useEffect, useRef, useState } from "react";

// 分身AIとの会話画面。
// 会話はブラウザ側で保持し、毎回まるごと /api/chat へ送る（サーバーに状態を持たない）。

type Msg = { role: "user" | "assistant"; content: string };

const EXAMPLES = [
  "自治体の係長に「業務が増えるだけ」と断られました。次の一手は？",
  "課長まで話が上がりません。誰から攻めるべきですか？",
  "委託会社と組むべきか、単独で行くべきか迷っています。",
  "この提案資料、吉井さんならどこを指摘しますか？",
];

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || streaming) return;

    const next: Msg[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    setStreaming(true);
    // 返答の器を先に置いて、届いた文字をここへ足していく
    setMessages([...next, { role: "assistant", content: "" }]);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });

      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => null);
        const msg = (d && d.error) || "うまく返せませんでした。もう一度お試しください。";
        setMessages([...next, { role: "assistant", content: msg }]);
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages([...next, { role: "assistant", content: acc }]);
      }
    } catch {
      setMessages([
        ...next,
        { role: "assistant", content: "通信エラーが起きました。もう一度お試しください。" },
      ]);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4">
      {/* min-w-0 と gap が無いと、狭い画面で説明文が「ログアウト」の下へ回り込んで重なる */}
      <header className="flex items-start justify-between gap-4 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-bold">法人請求オンラインサービス相談AI</h1>
          <p className="text-xs text-slate-500">
            吉井さんに相談する前の壁打ち相手です。最終判断は本人に確認してください。
          </p>
        </div>
        <button
          onClick={async () => {
            await fetch("/api/login", { method: "DELETE" });
            location.href = "/login";
          }}
          className="shrink-0 text-xs text-slate-400 underline"
        >
          ログアウト
        </button>
      </header>

      <div className="flex-1 space-y-4 pb-4">
        {messages.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-sm text-slate-600">
              こんな相談ができます。押すとそのまま送れます。
            </p>
            <div className="mt-3 space-y-2">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  onClick={() => send(e)}
                  className="block w-full rounded-xl bg-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-200"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-2xl bg-blue-800 px-4 py-2.5 text-sm whitespace-pre-wrap text-white"
                  : "max-w-[95%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-800"
              }
            >
              {m.content || (streaming ? "…" : "")}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className="sticky bottom-0 flex gap-2 bg-slate-50 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={2}
          placeholder="相談を書いてください（⌘+Enterで送信）"
          className="flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          className="shrink-0 self-end rounded-xl bg-blue-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {streaming ? "…" : "送る"}
        </button>
      </form>
    </main>
  );
}
