// Anthropic 呼び出しの共通ヘルパー。
//
// AIワークOS の各 route.ts と同じ型（@anthropic-ai/sdk の messages.create +
// thinking:adaptive + output_config(json_schema) による構造化出力）を踏襲する。
// この型は実運用で通っているので、勝手に別の書き方へ寄せないこと。
//
// モデル方針:
//   - 抽出・分類（量が出る。1日10〜20通）: Sonnet 5
//   - /fit の深掘り再採点（数は出ない。質が要る）: Opus 5
// どちらも env で差し替えられる。

import Anthropic from "@anthropic-ai/sdk";

/** 取込時の分類・抽出・一次採点に使うモデル。 */
export const EXTRACT_MODEL = process.env.CAREER_EXTRACT_MODEL?.trim() || "claude-sonnet-5";
/** /fit の深掘り再採点に使うモデル。 */
export const FIT_MODEL = process.env.CAREER_FIT_MODEL?.trim() || "claude-opus-5";

export class AnthropicNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY が設定されていません");
    this.name = "AnthropicNotConfiguredError";
  }
}

export function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new AnthropicNotConfiguredError();
  return new Anthropic({ apiKey: key });
}

/**
 * JSONスキーマを指定して構造化出力を1回取る。
 *
 * 返ってくるのは指定スキーマに沿ったJSONなので、呼び出し側は素直に型付けしてよい。
 * （output_config で形が保証されるため、正規表現でJSONを掘り出す処理は不要。）
 *
 * ★必ず stream() を使うこと★
 * 非ストリーミングの messages.create() は、max_tokens が大きいと SDK 側が
 * 「10分を超える可能性がある処理にはストリーミングが必要」と例外を投げて弾く
 * （2026-08-02 に実際に踏んだ）。求人30件ぶんの抽出には広い max_tokens が要るので、
 * ここは常にストリーミングで受け、finalMessage() で組み立てた結果を使う。
 * イベントを個別に扱う必要は無いので、呼び出し側の書き味は create() と変わらない。
 */
export async function structured<T>(opts: {
  model?: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const client = anthropicClient();
  const stream = client.messages.stream({
    model: opts.model ?? EXTRACT_MODEL,
    // 思考(adaptive)と本文の合計に効く上限。
    // 実測: doda X の求人紹介メールは1通に求人30件入っていることがある。
    max_tokens: opts.maxTokens ?? 32000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: opts.system }],
    output_config: { format: { type: "json_schema", schema: opts.schema } },
    messages: [{ role: "user", content: opts.prompt }],
  });

  const res = await stream.finalMessage();

  // max_tokens で打ち切られると JSON が途中で切れて JSON.parse が落ちる。
  // 原因が分かるメッセージにしておかないと、呼び出し元のログで追えなくなる。
  if (res.stop_reason === "max_tokens") {
    throw new Error(
      `AIの出力が max_tokens に達して途中で切れました（出力 ${res.usage.output_tokens} トークン）。maxTokens を上げるか、入力を短くしてください`
    );
  }

  const tb = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!tb) throw new Error("AIから本文が返りませんでした");
  return JSON.parse(tb.text) as T;
}
