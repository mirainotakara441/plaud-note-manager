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

/**
 * クレジット残高切れ・支払いの問題かどうか。
 *
 * 2026-08-22、日記の登録が本番で落ちた。原因はAnthropic APIの残高ゼロだったが、
 * 画面には「しばらくしてから再度お試しください」と出ていた。残高切れは時間では
 * 解消しないので、この案内は待つだけ無駄な時間を生む嘘だった。実際APIも
 * `x-should-retry: false` を返して「再試行しても無駄」と明言している。
 *
 * 厄介なのは、残高切れがHTTP 400（＝リクエストが悪い）で返ってくること。
 * 401でも429でもないので、素直に書くと「入力が悪い」系の扱いに落ちて、
 * 本文を直そうとしてしまう。ここで型として切り出しておく。
 */
export function isBillingError(error: unknown): boolean {
  const e = error as {
    status?: number;
    message?: string;
    error?: { error?: { message?: string } };
  };
  if (e?.status !== 400) return false;
  const detail = `${e?.error?.error?.message ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return detail.includes("credit balance") || detail.includes("plans & billing");
}

/** 残高切れのときに画面へ出す文言。 */
export const BILLING_ERROR_MESSAGE =
  "AnthropicAPIのクレジット残高が不足しています。時間をおいても解消しないので、" +
  "console.anthropic.com の Plans & Billing で残高を追加してください。";

/** 一時的な混雑・レート制限か。こちらは本当に「しばらく待つ」で直る。 */
export function isTransientError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

/**
 * 接続そのものが切れたか。
 *
 * isTransientError はHTTPステータスを見るが、接続断にはステータスが付かないので
 * 拾えない。2026-09-12 の実測で、2分前後かかる生成が「Connection error.」で
 * 落ちる事象が夜間参謀・提案仕込みの両方で出た（4回成功して5回目に落ちる、の頻度）。
 */
export function isConnectionError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; status?: number };
  if (typeof e?.status === "number") return false;
  const s = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return (
    s.includes("connection error") ||
    s.includes("apiconnection") ||
    s.includes("socket") ||
    s.includes("econnreset") ||
    s.includes("terminated")
  );
}

/**
 * 一時的な失敗（混雑・接続断）に限り、待って1回だけやり直す。
 *
 * 無人で走る処理（夜間参謀・提案の夜間仕込み・toolLoop）が使う。
 * 昼の対話的なAPI（60秒制限内）では使わないこと——待ち時間ぶんだけ
 * タイムアウトに近づくうえ、画面の前の人は自分でやり直せる。
 * 2回に増やさないのは、残高切れ・キー無効のような「待っても直らない」失敗を
 * 引き延ばさないため（それらはこの判定に当たらず即座に投げ返る）。
 */
export async function retryOnceOnTransient<T>(
  run: () => Promise<T>,
  label?: string,
  waitMs = 20_000
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isTransientError(err) && !isConnectionError(err)) throw err;
    if (label) {
      console.log(`${label}: 一時的な失敗のため${Math.round(waitMs / 1000)}秒後に1回だけやり直します:`, String(err));
    }
    await new Promise((r) => setTimeout(r, waitMs));
    return run();
  }
}

/**
 * LLM呼び出しの例外を、画面に出す文言へ変換する。
 *
 * AIを呼ぶAPIは14本あり、どれも catch で自前の文言を返していた。そのため
 * 残高切れ・キー無効・混雑のどれで落ちても同じ文が出て、吉井さんの側からは
 * 「待てばいいのか、直せばいいのか」が区別できなかった。原因が分かる文言は
 * ここ1箇所で作り、各routeは fallback（その処理特有の言い回し）だけ渡す。
 *
 * @param fallback 原因を特定できなかったときの、その処理らしい文言
 */
export function llmErrorMessage(error: unknown, fallback: string): string {
  if (isAuthError(error)) return AUTH_ERROR_MESSAGE;
  if (isBillingError(error)) return BILLING_ERROR_MESSAGE;
  if (isTransientError(error)) {
    return "AIが混み合っているか一時的に応答できません。少し時間をおいて再度お試しください。";
  }
  return fallback;
}

/**
 * 例外に対して返すべきHTTPステータス。
 *
 * 残高切れ・キー無効はこちら側の設定の問題なので500。混雑は502のままにして、
 * 監視側で「待てば直るもの」と「人が動かないと直らないもの」を分けられるようにする。
 */
export function llmErrorStatus(error: unknown): number {
  if (isAuthError(error) || isBillingError(error)) return 500;
  return 502;
}

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

  // ★必ずストリーミングで受ける。
  //   非ストリーミングだと、生成が長引いた呼び出しで接続そのものが切れる
  //   （UND_ERR_SOCKET / other side closed）。2026-09-12、週次振り返りの下書きで
  //   3.1分かかる呼び出しが2回続けて落ちた。入力を減らしても直らず、
  //   原因は出力が長いこと自体だった。リトライでも直らない種類の失敗で、
  //   途中まで生成したぶんが丸ごと無駄になる。
  //   finalMessage() が返すのは create() と同じ形なので、呼び出し側は変わらない。
  const stream = client.messages.stream(
    buildParams(opts, {
      output_config: {
        format: { type: "json_schema", schema: opts.schema },
        ...(opts.effort ? { effort: opts.effort } : {}),
      },
    })
  );
  const message = await stream.finalMessage();

  assertUsable(message, opts.label);

  const body = joinText(message);
  if (!body) throw new Error("AIから本文が返りませんでした");
  return JSON.parse(body) as T;
}

// ---- tool use（AIが自分で追加取得しながら考える）---------------------
//
// 2026-09-12 の総点検まで、tool use はリポジトリ全体で未使用だった。
// 全ルートが「固定件数を先に引いて渡す」形で、AIは足りない材料を自分で
// 取りに行けなかった（一発で引けたものが全て）。ここはその欠損を埋める共通部。
// /api/ask が最初の利用者。/api/agent のツール化（Phase 2）でも使う想定。

/** AIに渡す道具1つぶん。run はサーバー側で実行され、結果の文字列がAIへ返る。 */
export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
};

/** ツール実行の足あと。画面で「何を調べたか」を見せるために返す。 */
export type ToolStep = {
  tool: string;
  input: Record<string, unknown>;
  /** 結果の要約（先頭だけ）。全文は返さない——足あとは検証の入口であって転写ではない。 */
  resultHead: string;
  resultChars: number;
  ms: number;
};

/**
 * ツールを渡して、AIが「調べる→考える→また調べる」を繰り返しながら
 * 最終的な文章を作るループ。
 *
 * - maxSteps 回まで道具を使える。上限に達したら道具を取り上げて
 *   「ここまでの材料でまとめよ」と最後の1回を回す（無限ループの保険）。
 * - 各ステップはストリーミングで受ける（structured() と同じ理由。
 *   非ストリーミングは長い生成で接続ごと切れる）。
 * - thinking は adaptive のまま。会話を積むとき、応答の content ブロックを
 *   丸ごと assistant turn として返すこと（thinking ブロックの署名を壊すと
 *   次のリクエストが弾かれる）。
 */
export async function toolLoop(opts: {
  system: string;
  prompt: string;
  tools: ToolDef[];
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  label?: string;
}): Promise<{ text: string; steps: ToolStep[] }> {
  const client = llmClient();
  const maxSteps = opts.maxSteps ?? 6;
  const steps: ToolStep[] = [];

  const toolParams = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.prompt },
  ];

  for (let round = 0; ; round++) {
    const exhausted = round >= maxSteps;
    // 各ラウンドを一時失敗1回まで再試行付きで回す。toolLoop は夜間の無人実行
    // （提案仕込み・将来の夜間参謀ツール化）が主な使い口で、接続断1回で
    // 数分ぶんの往復が丸ごと無駄になるため。それまでの会話（messages）は
    // 手元にあるので、落ちたラウンドだけやり直せば続きから進める。
    const message = await retryOnceOnTransient(
      async () => {
        const stream = client.messages.stream({
          model: opts.model ?? DEFAULT_MODEL,
          max_tokens: opts.maxTokens ?? 12000,
          thinking: { type: "adaptive" },
          system: [
            {
              type: "text" as const,
              text: opts.system,
              cache_control: { type: "ephemeral" as const },
            },
          ],
          // 上限に達したら道具ごと外す。tool_choice:none だけだと「道具がある前提」の
          // 思考を続けてしまうので、無い状態で締めさせる。
          ...(exhausted ? {} : { tools: toolParams }),
          messages,
        });
        return stream.finalMessage();
      },
      opts.label
    );
    assertUsable(message, opts.label);

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUses.length === 0 || exhausted) {
      const body = joinText(message);
      if (!body) throw new Error("AIから本文が返りませんでした");
      return { text: body, steps };
    }

    // 応答ブロックを丸ごと積む（thinking 署名を保つため加工しない）。
    messages.push({ role: "assistant", content: message.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const t0 = Date.now();
      const tool = byName.get(use.name);
      let result: string;
      try {
        result = tool
          ? await tool.run((use.input ?? {}) as Record<string, unknown>)
          : `不明な道具です: ${use.name}`;
      } catch (err) {
        // 道具の失敗はループを止めない。失敗したことをAIに伝えて考えさせる
        // （別の道具・別の引数で取り直すか、無いなりに答えるかはAIの判断）。
        result = `道具の実行に失敗しました: ${String(err)}`;
      }
      steps.push({
        tool: use.name,
        input: (use.input ?? {}) as Record<string, unknown>,
        resultHead: result.slice(0, 200),
        resultChars: result.length,
        ms: Date.now() - t0,
      });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result,
      });
    }
    messages.push({ role: "user", content: results });

    if (opts.label) {
      console.log(
        `${opts.label}: round=${round + 1}`,
        toolUses.map((u) => u.name).join(",")
      );
    }
  }
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
