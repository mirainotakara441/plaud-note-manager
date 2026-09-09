import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt } from "@/lib/systemPrompt";
import { saveLog } from "@/lib/logs";
import { NAME_COOKIE } from "@/lib/session";

// 分身AIとの会話。
//
// ★必ずストリーミングで呼ぶこと。
// 非ストリーミングの messages.create は長い応答で60秒のタイムアウトに当たって
// 切断される（AIワークOSで3回踏んだ）。ここは最初からストリーム固定にしている。
//
// 会話履歴はブラウザ側が毎回まるごと送ってくる（サーバーに会話状態を持たない）。
// 長くなりすぎないよう、直近 MAX_TURNS 往復だけ使う。

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = process.env.BUNSHIN_MODEL?.trim() || "claude-sonnet-5";
const MAX_TURNS = 12;

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || apiKey === "sk-ant-xxxxx") {
    return new Response(
      JSON.stringify({ error: "サーバーにAPIキーが設定されていません" }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストの形式が不正です" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: Msg[] = raw
    .filter(
      (m): m is Msg =>
        !!m &&
        typeof m === "object" &&
        ((m as Msg).role === "user" || (m as Msg).role === "assistant") &&
        typeof (m as Msg).content === "string" &&
        (m as Msg).content.trim() !== ""
    )
    .slice(-MAX_TURNS * 2);

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "相談内容が空です" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const store = await cookies();
  const memberName = decodeURIComponent(store.get(NAME_COOKIE)?.value ?? "") || "（名前なし）";
  const question = messages[messages.length - 1].content;

  const client = new Anthropic({ apiKey });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      try {
        const s = client.messages.stream({
          model: MODEL,
          max_tokens: 2000,
          system: systemPrompt(),
          messages,
        });
        for await (const event of s) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            full += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
      } catch (err) {
        console.error("POST /api/chat: 生成に失敗", err);
        const status = (err as { status?: number })?.status;
        const msg =
          status === 401
            ? "\n\n（APIキーが無効です。吉井さんに連絡してください）"
            : status === 400
              ? "\n\n（AIの残高切れの可能性があります。吉井さんに連絡してください）"
              : "\n\n（通信エラーが起きました。もう一度お試しください）";
        controller.enqueue(encoder.encode(msg));
        full += msg;
      } finally {
        // close() より先に記録する。close() を先に呼ぶと、この続きは
        // ブラウザが読み終わったあとの後始末になり、実行の保証が弱くなる
        // （ブラウザが途中で読むのをやめた場合も記録は残したい）。
        // 記録は会話を止めない（失敗してもサーバーログに残すだけ）。
        await saveLog(memberName, question, full);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
