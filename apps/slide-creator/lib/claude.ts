import Anthropic from "@anthropic-ai/sdk";
import type { SlideData } from "./types";

const SYSTEM_PROMPT = `あなたは高校生の発表スライド作成を手伝うAIアシスタントです。
以下のスライド作成の鉄則を必ず守ってください：

【スライド作成の鉄則】
- 1スライド1メッセージ（1枚に情報を詰め込みすぎない）
- タイトルは短く、一目でわかる言葉で（10文字以内が理想）
- 箇条書きは3〜4点まで（1点は20文字以内）
- 図解を積極的に使ってビジュアルに伝える
- 聞いている人の目線で考える（難しい言葉を使わない）
- 高校生らしい親しみやすいトーンで

【出力形式】
必ず以下のJSON形式で出力してください。JSON以外のテキストは一切含めないこと。

{
  "meta": {
    "title": "発表タイトル",
    "audience": "対象者",
    "purpose": "目的"
  },
  "slides": [
    {
      "type": "title",
      "title": "発表タイトル",
      "subtitle": "サブタイトルや発表者名など"
    },
    {
      "type": "content",
      "title": "スライドタイトル",
      "bullets": ["ポイント1", "ポイント2", "ポイント3"],
      "figure": {
        "kind": "process_flow",
        "steps": ["ステップ1", "ステップ2", "ステップ3"]
      },
      "speakerNote": "発表者メモ（任意）"
    },
    {
      "type": "closing",
      "title": "まとめ",
      "summary": ["まとめポイント1", "まとめポイント2"]
    }
  ]
}

【図解の種類】
- process_flow: 流れや手順を示す（steps: 文字列の配列）
- comparison: 2つのものを比較する（left/right それぞれ label と points）
- icon_grid: 複数の項目をアイコン付きで並べる（items: emoji と label のペア）
- bar_chart: 数値を棒グラフで示す（bars: label と value のペア、valueは0〜100の数値）

figureは必要なスライドにだけ付けること（全スライドに付ける必要はない）。
スライドは合計5〜8枚で構成すること。最初は必ずtitleスライド、最後は必ずclosingスライドにすること。`;

export async function generateSlides(
  audience: string,
  purpose: string,
  message: string
): Promise<SlideData> {
  const client = new Anthropic({ apiKey: process.env.SLIDE_ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `以下の情報をもとに発表スライドを作成してください。

対象者：${audience}
目的：${purpose}
伝えたいこと：${message}

JSON形式で出力してください。`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude からのレスポンスが取得できませんでした");
  }

  const jsonText = textBlock.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
  const data = JSON.parse(jsonText) as SlideData;
  return data;
}
