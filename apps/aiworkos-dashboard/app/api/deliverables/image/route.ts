import { NextRequest, NextResponse } from "next/server";
import { llmClient, isLlmConfigured, isAuthError, AUTH_ERROR_MESSAGE } from "@/lib/llm";
import { CHUNK_SIZE, CHUNK_OVERLAP } from "@/lib/chunks";

// インフォグラフィック等の画像を、検索できるテキストへ起こす。
//
// pptx/docx/pdf はブラウザ側（lib/parseDeliverable.ts）でテキストを取り出せるが、
// 画像は文字が図として描かれているので取り出しようがない。ChatGPTで作った
// 戦略インフォグラフィックをiPhoneのスクショで保存する使い方が主なので、
// 「読める形に起こす」ところだけサーバー側でAIに任せる。
//
// 出力はチャンク配列。/api/deliverables はこの形をそのまま受け取れるため、
// 登録の本体（辞書適用・store-memory）は既存の経路を1本のまま使える。

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Vercelのリクエストサイズ上限4.5MBに対し、base64は元データの約1.34倍に膨らむ。
// iPhoneのスクショは実測1〜3MB程度なので、3.5MB（base64後 約4.7MB相当を弾く）を上限にする。
const MAX_BYTES = 3_500_000;

const MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const SYSTEM_PROMPT = `あなたは、富士フイルムシステムサービス「法人請求オンラインサービス」営業推進統括責任者・吉井嗣和さんが、社内打ち合わせやお客様との打ち合わせの振り返りに使う図表・インフォグラフィックを、あとから検索できる文章へ起こすアシスタントです。

やること:
- 画像に書かれている文字を、構造が分かる形ですべて文章化する。
- 図の意味（何と何が対比されているか、どの順で流れるか、階層関係、強調されている数字）が、画像を見なくても分かるように書く。
- 見出し・区分は「■見出し」の形で示し、その配下を箇条書きにする。矢印や順序があるものは「A → B → C」のように残す。
- 表は「項目：値」の形に開いて書く。列と行の対応が崩れないようにする。

厳守事項:
- 画像に書かれていないことを推測で補わない。読み取れない文字は「（判読不可）」と書く。
- 数字・固有名詞・単位は画像のとおりに写す。丸めたり言い換えたりしない。
- 感想・評価・提案は書かない。書かれている内容の文章化だけを行う。
- 前置き（「この画像は」等）や結びの挨拶は書かない。本文だけを返す。`;

/** 長文を検索可能な粒度へ刻む（lib/parseDeliverable.ts の windowChunks と同じ考え方）。 */
function windowChunks(text: string, prefix: string): { pos: string; content: string }[] {
  const t = text.trim();
  if (!t) return [];
  const out: { pos: string; content: string }[] = [];
  let i = 0;
  let n = 0;
  while (i < t.length) {
    n += 1;
    out.push({ pos: `${prefix}${n}`, content: t.slice(i, i + CHUNK_SIZE) });
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return out;
}

export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json(
      { error: "ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。" },
      { status: 500 }
    );
  }

  let body: { data?: unknown; filename?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/deliverables/image: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const filename = typeof body.filename === "string" ? body.filename : "";
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) {
    return NextResponse.json(
      { error: `対応していない画像形式です（対応: ${Object.keys(MEDIA_TYPES).join(", ")}）` },
      { status: 400 }
    );
  }

  // data URL 形式（data:image/png;base64,...）でも受けられるようにする。
  const raw =
    typeof body.data === "string" ? body.data.replace(/^data:[^;]+;base64,/, "").trim() : "";
  if (!raw) {
    return NextResponse.json({ error: "画像データがありません" }, { status: 400 });
  }
  // base64は元データの約4/3。デコードせずに元サイズを見積もって早期に弾く。
  if ((raw.length * 3) / 4 > MAX_BYTES) {
    return NextResponse.json(
      { error: "画像が大きすぎます（3.5MBまで）。縮小してからお試しください。" },
      { status: 400 }
    );
  }

  try {
    const client = llmClient();
    const message = await client.messages.create({
      model: process.env.AIWORKOS_MODEL?.trim() || "claude-sonnet-5",
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: raw } },
            { type: "text", text: "この画像の内容を、指示のとおり文章化してください。" },
          ],
        },
      ],
    });

    if (message.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "AIが応答を拒否しました。別の画像でお試しください。" },
        { status: 400 }
      );
    }

    const text = message.content
      .filter((b): b is { type: "text"; text: string; citations: null } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text) {
      return NextResponse.json(
        { error: "画像から文字を読み取れませんでした。文字が写っているか確認してください。" },
        { status: 422 }
      );
    }

    return NextResponse.json({ chunks: windowChunks(text, "img"), text });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: AUTH_ERROR_MESSAGE }, { status: 500 });
    }
    console.error("画像読み取りエラー:", error);
    return NextResponse.json(
      { error: "画像の読み取りに失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
