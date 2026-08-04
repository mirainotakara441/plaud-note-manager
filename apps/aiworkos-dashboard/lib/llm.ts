// AI（LLM）呼び出しの共通ヘルパー。
//
// ■ このファイルの存在理由
// AIワークOSは9本のAPIから Claude を呼んでいる。以前は各 route.ts が
// それぞれ `new Anthropic(...)` してモデル名をベタ書きしていたため、
//   - モデルを上げたい      → 9箇所直す
//   - 別会社のAIに乗り換える → 9箇所直す
//   - APIキー未設定のエラー文言を揃えたい → 9箇所直す
// という状態だった。呼び出しをここ1箇所に集約したので、以後は
// このファイルだけ直せば全APIに効く。
//
// ■ 乗り換えるときに直す場所
// provider を差し替えるなら、触るのは llmClient() / structured() / text() の
// 中身だけ。各 route.ts は「system・prompt・schema を渡して結果を受け取る」
// だけなので、原則そのままで通る。
//
// ■ 呼び出し側のルール
// 新しく AI を呼ぶ API を作るときは、必ずここ経由にすること。
// route.ts で直接 `new Anthropic(...)` を書かない。
//
// ■ 型について
// career-os の lib/anthropic.ts と同じ型（messages.create + thinking:adaptive +
// output_config(json_schema) による構造化出力）を踏襲している。
// この型は実運用で通っているので、勝手に別の書き方へ寄せないこと。

import Anthropic from "@anthropic-ai/sdk";

/**
 * 全APIの既定モデル。
 *
 * 環境変数 AIWORKOS_MODEL で差し替えられる。モデルを上げたいときは
 * Vercel の環境変数を変えるだけで、デプロイし直さずに切り替わる。
 */
export const DEFAULT_MODEL = process.env.AIWORKOS_MODEL?.trim() || "claude-sonnet-5";

/** APIキーが無い／プレースホルダのままのときに投げる。 */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。");
    this.name = "LlmNotConfiguredError";
  }
}

/** APIキーが設定されているか。ハンドラ冒頭の早期リターン判定に使う。 */
export function isLlmConfigured(): boolean {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  // `sk-ant-xxxxx` は .env.local のひな形に入っている値。未設定と同じ扱いにする。
  return !!key && key !== "sk-ant-xxxxx";
}

/**
 * 生のクライアントを返す。
 *
 * structured() / text() で足りない特殊な呼び方をしたいときだけ使う。
 * 通常は使わないこと（ここを直接使うと集約した意味が薄れる）。
 */
export function llmClient(): Anthropic {
  if (!isLlmConfigured()) throw new LlmNotConfiguredError();
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() });
}

/**
 * APIキーが無効（401）だったかどうか。
 * catch した例外を渡すと判定できる。エラー文言を出し分けるために使う。
 */
export function isAuthError(error: unknown): boolean {
  return (error as { status?: number })?.status === 401;
}

/** 無効キーのときに画面へ出す文言。9本で同じ文にするためここに置く。 */
export const AUTH_ERROR_MESSAGE =
  "ANTHROPIC_APIキーが無効です。.env.local の ANTHROPIC_API_KEY を確認してください。";

/** structured() / text() の共通オプション。 */
type CallOptions = {
  /** 省略時は DEFAULT_MODEL。 */
  model?: string;
  /**
   * システムプロンプト（AIの役割・前提）。
   *
   * 省略可。役割指示をユーザープロンプト側に書いている呼び出し
   * （ラーメンの下書き・月次まとめ）があるため、必須にしていない。
   * 省略した場合は system フィールド自体を送らない（空文字を送ると
   * 送信内容が変わってしまうため）。
   */
  system?: string;
  /**
   * 単発の質問文。多ターンの会話を渡したいときは messages を使う。
   * prompt と messages はどちらか一方だけ指定する。
   */
  prompt?: string;
  /** 多ターンの会話履歴。prompt の代わりに使う。 */
  messages?: Anthropic.MessageParam[];
  /**
   * 思考(adaptive thinking)を使うか。既定は true。
   *
   * ★false にする判断は慎重に★
   * Vercel の関数タイムアウト（既定60秒）に収まらない呼び出しでのみ false にする。
   * 入力が長い処理（SVG全文を渡す等）は思考込みで100秒を超えた実績がある。
   * 品質は落ちるので、外すときは「なぜ外したか」を呼び出し側にコメントで残すこと。
   */
  thinking?: boolean;
  /**
   * 思考の深さ。指定しなければモデル既定（high）。
   *
   * 長文を何本も出させる用途では、思考だけで max_tokens を使い切って
   * 本文が1文字も返らないことがある（2026-08-01 に実際に踏んだ）。
   * そういう「出力量が要る」処理では "medium" 以下にして枠を空ける。
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** 思考と本文の合計に効く上限。既定 8000。 */
  maxTokens?: number;
  /**
   * システムプロンプトをキャッシュするか。既定 true。
   *
   * 同じシステムプロンプトを繰り返し投げる場合に課金が下がる。
   * 短いプロンプトでは効かないが、付けても害は無いので既定で入れている。
   */
  cache?: boolean;
  /** ログに出す処理名（例: "日記解析"）。省略するとログを出さない。 */
  label?: string;
};

/** 呼び出し側の指定を SDK のリクエスト形へ組み立てる。 */
function buildParams(opts: CallOptions, extra: Record<string, unknown>) {
  if (!opts.prompt && !opts.messages) {
    throw new Error("llm: prompt か messages のどちらかを指定してください");
  }
  return {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    ...(opts.thinking === false ? {} : { thinking: { type: "adaptive" as const } }),
    // system が無い呼び出しでは、空ブロックを送らずフィールドごと省く。
    ...(opts.system
      ? {
          system: [
            {
              type: "text" as const,
              text: opts.system,
              ...(opts.cache === false
                ? {}
                : { cache_control: { type: "ephemeral" as const } }),
            },
          ],
        }
      : {}),
    messages: opts.messages ?? [{ role: "user" as const, content: opts.prompt! }],
    ...extra,
  };
}

/** 応答の text ブロックを全部つないで返す。 */
function joinText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * 打ち切り・拒否を、原因が分かる例外に変換する。
 *
 * ここで潰しておかないと、呼び出し側は「JSON.parse が落ちた」としか
 * 分からず、max_tokens が足りないのか入力が悪いのか切り分けられない。
 */
function assertUsable(message: Anthropic.Message, label?: string): void {
  if (label) {
    console.log(
      `${label}:`,
      "stop=", message.stop_reason,
      "blocks=", message.content.map((b) => b.type).join(","),
      "in=", message.usage?.input_tokens,
      "out=", message.usage?.output_tokens
    );
  }
  if (message.stop_reason === "refusal") {
    throw new Error("AIが安全上の理由で応答を拒否しました。入力内容を確認してください。");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `AIの出力が上限に達して途中で切れました（出力 ${message.usage?.output_tokens} トークン）。` +
        `maxTokens を上げるか、入力を短くしてください`
    );
  }
}

/**
 * JSONスキーマを指定して構造化出力を1回取る。
 *
 * 返ってくるのは指定スキーマに沿ったJSONなので、呼び出し側は素直に型付けしてよい。
 * （output_config で形が保証されるため、正規表現でJSONを掘り出す処理は不要。）
 */
export async function structured<T>(
  opts: CallOptions & { schema: Record<string, unknown> }
): Promise<T> {
  const client = llmClient();
  const message = await client.messages.create(
    buildParams(opts, {
      output_config: {
        format: { type: "json_schema", schema: opts.schema },
        ...(opts.effort ? { effort: opts.effort } : {}),
      },
    })
  );

  assertUsable(message, opts.label);

  const body = joinText(message);
  if (!body) throw new Error("AIから本文が返りませんでした");
  return JSON.parse(body) as T;
}

/**
 * 文章をそのまま受け取る。
 *
 * 複数行の日本語を何本も出させる用途では、JSONにすると改行のエスケープが
 * 崩れて全部読めなくなる（2026-08-01 に実際に踏んだ）。そういう場合は
 * structured() ではなくこちらを使い、区切り行で分割する。
 */
export async function text(opts: CallOptions): Promise<string> {
  const client = llmClient();
  const message = await client.messages.create(
    buildParams(opts, opts.effort ? { output_config: { effort: opts.effort } } : {})
  );

  // 文章生成では途中で切れても「短い文章」として使えることがあるので、
  // max_tokens は例外にせず呼び出し側の判断に任せる。拒否だけは弾く。
  if (opts.label) {
    console.log(
      `${opts.label}:`,
      "stop=", message.stop_reason,
      "blocks=", message.content.map((b) => b.type).join(","),
      "in=", message.usage?.input_tokens,
      "out=", message.usage?.output_tokens
    );
  }
  if (message.stop_reason === "refusal") {
    throw new Error("AIが安全上の理由で応答を拒否しました。入力内容を確認してください。");
  }

  return joinText(message);
}
