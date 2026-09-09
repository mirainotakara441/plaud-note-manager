// Gmail REST API の薄いクライアント。
//
// googleapis パッケージは使わない。あれは Google API 全体のディスカバリを抱えていて重く、
// Vercel の関数バンドルを無駄に太らせる。ここで使うのは
//   - OAuth のトークン更新（1エンドポイント）
//   - messages.list / messages.get（2エンドポイント）
// の3本だけなので、fetch で直接叩くほうが速いし依存も増えない。
//
// 権限は読み取り専用（gmail.readonly）。書き込み系のスコープは要求していないので、
// このコードが誤ってメールを消したり送ったりすることは原理的に起こらない。
//
// 認証情報の取り方は docs/gmail-setup.md を参照。

/** OAuth 2.0 のトークンエンドポイント。refresh_token → access_token の交換に使う。 */
const OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Gmail API のベースURL。"me" は認証したユーザー自身を指す。 */
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * 本文の保存・AI投入の上限文字数。
 *
 * 求人紹介メールは HTML だと装飾で平気で数十万文字になるが、text/plain 側は
 * ずっと素直で、そちらを優先して取れば十分に収まる。
 *
 * ★この値の根拠（2026-08-02 に実物で採寸）★
 * doda X の求人紹介メール（2026-08-01 受信ぶん）の実測値:
 *   - text/plain: 11,612 文字 / html: 174,849 文字
 *   - その 1通の中に求人が【30件】入っていた（件名に出るのは先頭3社だけ）
 *   - 最後の求人の開始位置は 10,162 文字目、そこから約1,400文字が配信停止等のフッター
 *
 * つまり旧値 12000 では余裕が 388 文字しかなく、少し長いメールが来ただけで
 * 末尾の求人が黙って落ちる。落ちても例外は出ないので気づけないのが厄介。
 * text/plain は 12,000 前後で頭打ちなので、3倍以上の余裕を取って 40,000 にする。
 * （HTMLしか無いメールはタグ除去後にここで切られるが、それは想定内の縮退。）
 */
export const BODY_LIMIT = 40000;

export class GmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Gmail の認証情報が設定されていません（GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN）"
    );
    this.name = "GmailNotConfiguredError";
  }
}

/** Gmail API の payload（MIMEツリーの1ノード）。必要な項目だけ型付けしている。 */
export type GmailPayload = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayload[];
};

/** Gmail API の messages.get(format=full) のレスポンス。 */
export type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  /** 受信時刻のエポックミリ秒。文字列で返ってくることに注意。 */
  internalDate?: string;
  payload?: GmailPayload;
};

/** メール1通を、このアプリが扱いやすい形に整えたもの。 */
export type ParsedMessage = {
  gmailMessageId: string;
  gmailThreadId: string | null;
  /** From ヘッダの原文（例: `doda X <kyujinjyohomail@doda-x.jp>`）。 */
  sender: string | null;
  /** From から抜いたメールアドレス部分（小文字化済み）。 */
  senderEmail: string | null;
  /** メールアドレスのドメイン部分（小文字化済み）。 */
  senderDomain: string | null;
  subject: string | null;
  /** 受信日時の ISO 8601 文字列。 */
  receivedAt: string | null;
  snippet: string | null;
  /** 本文（プレーンテキスト化 + BODY_LIMIT で切り詰め済み）。 */
  bodyText: string;
};

function gmailCreds(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = process.env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) throw new GmailNotConfiguredError();
  return { clientId, clientSecret, refreshToken };
}

/** 取込対象のラベルID。既定は「転職」ラベル。 */
export function defaultLabelId(): string {
  return process.env.GMAIL_LABEL_ID?.trim() || "Label_82";
}

/**
 * 検索クエリに書くラベル「名」。
 *
 * ★ID と名前を取り違えないこと★
 * Gmail API の labelIds パラメータは ID（Label_82）を取るが、検索クエリの
 * `label:` 演算子は【表示名】しか受け付けない。`label:Label_82` と書くと
 * エラーにならず 0件が返るだけなので、間違えても気づけない（2026-08-03 に実際に踏んだ）。
 */
export function defaultLabelName(): string {
  return process.env.GMAIL_LABEL_NAME?.trim() || "転職";
}

/** 1回の取込で取得する最大メール数。 */
export function defaultMaxResults(): number {
  const n = Number(process.env.GMAIL_MAX_RESULTS?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

// アクセストークンのメモ化。
// アクセストークンは1時間有効なので、同一実行内で何度も交換しにいく必要はない。
// Vercel の関数インスタンスが使い回されればリクエストをまたいでも効く（効かなくても正しく動く）。
let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * refresh_token から access_token を得る。
 *
 * 期限の60秒前には取り直す（処理の途中で切れるのを避けるため）。
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const { clientId, clientSecret, refreshToken } = gmailCreds();
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // invalid_grant は「refresh token が失効した」の典型。
    // OAuth同意画面が「テスト」ステータスのままだと7日で失効するので、まずそこを疑う。
    // 対処は docs/gmail-setup.md の「公開ステータスにする」手順。
    const hint = detail.includes("invalid_grant")
      ? "（refresh token が失効している可能性が高いです。docs/gmail-setup.md の手順5をやり直してください）"
      : "";
    throw new Error(
      `Gmail のアクセストークン取得に失敗しました ${res.status}: ${detail.slice(0, 300)}${hint}`
    );
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Gmail のトークン応答に access_token がありません");

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  tokenCache = { token: json.access_token, expiresAt: now + expiresInMs };
  return json.access_token;
}

async function gmailFetch(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${GMAIL_API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gmail API ${path} が ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export type ListMessagesResult = {
  ids: { id: string; threadId: string | null }[];
  nextPageToken: string | null;
};

/**
 * 取込対象のメッセージID一覧を取得する。本文は含まれない（IDとスレッドIDだけ）。
 *
 * newerThanDays を渡すと `newer_than:Nd` で期間を絞る。日次取込では 7 程度を入れておくと、
 * 3,000通あるラベルの先頭から毎回舐め直すことがなくなる。
 *
 * ★「転職」ラベルだけを信用してはいけない★
 * 当初は labelIds=Label_82（転職ラベル）だけで引いていたが、2026-08-03 に実データを
 * 数えたところ、直近30日の doda X メール62通のうち【26通にラベルが付いていなかった】。
 * しかも 7/31 以降は全滅で、いちばん新しいメールほど漏れる。ラベルは Gmail のフィルタが
 * 付けており、その適用が安定していないため。ラベル頼みだと日次取込が静かに空振りする。
 *
 * そこで「ラベル」か「既知の差出人ドメイン」のどちらかに当たれば拾う、という OR 条件にする。
 * labelIds パラメータと q パラメータは AND で効いてしまうので、labelIds は使わず
 * q 側に `label:` を書いて OR でつなぐこと（ここが分かりにくい罠）。
 */
export function buildInboxQuery(newerThanDays?: number): string {
  // 差出人は「サービスのドメイン」で広めに取り、種別の判定は後段のAI分類に任せる。
  // ここを職種名やキーワードで絞ると、新しい転職サービスを使い始めたときに黙って漏れる。
  const senders = [
    "doda-x.jp",
    "doda.jp",
    "bizreach.co.jp",
    "8card.net", // Eight Career Design
    "r-agent.com", // リクルートエージェント
    "recruit-direct.jp", // リクルートダイレクトスカウト
    "jac-recruitment.jp",
    "en-japan.com",
    "mynavi.jp",
    "pasonacareer.jp",
  ];
  const label = defaultLabelName();
  const or = [`label:${label}`, ...senders.map((d) => `from:${d}`)].join(" OR ");
  const period = newerThanDays && newerThanDays > 0 ? ` newer_than:${Math.floor(newerThanDays)}d` : "";
  return `{${or}}${period}`;
}

export async function listMessageIds(opts: {
  labelId?: string;
  maxResults?: number;
  newerThanDays?: number;
  pageToken?: string;
}): Promise<ListMessagesResult> {
  const params = new URLSearchParams();
  // Gmail API の maxResults は 1〜500。範囲外を投げると 400 になるので丸めておく。
  params.set("maxResults", String(Math.min(Math.max(opts.maxResults ?? 60, 1), 500)));
  params.set("q", buildInboxQuery(opts.newerThanDays));
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const json = (await gmailFetch(`messages?${params.toString()}`)) as {
    messages?: { id: string; threadId?: string }[];
    nextPageToken?: string;
  };

  return {
    ids: (json.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId ?? null })),
    nextPageToken: json.nextPageToken ?? null,
  };
}

/** メッセージ1通を本文込みで取得する。 */
export async function getMessage(id: string): Promise<GmailMessage> {
  return (await gmailFetch(`messages/${encodeURIComponent(id)}?format=full`)) as GmailMessage;
}

/**
 * Gmail の base64url を UTF-8 文字列に戻す。
 *
 * ここは日本語メールで最も壊れやすい箇所。
 *   - Gmail は base64url（`+`→`-`, `/`→`_`）で返してくる
 *   - atob() を通すとバイト列が Latin-1 として解釈され、日本語が化ける
 * よって `Buffer.from(..., "base64").toString("utf-8")` で必ずデコードする。
 * （このファイルは Node ランタイムの route からしか呼ばれないので Buffer が使える。）
 */
function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

/** HTML からタグを落としてプレーンテキストにする。整形は最低限でよい。 */
function htmlToText(html: string): string {
  return html
    // script / style の中身は本文ではないので、タグごと丸ごと落とす。
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // ブロック要素は改行に落とす（求人が改行で区切られている構造を残すため）。
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    // 主要な実体参照だけ戻す。数値参照も拾っておく。
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    // 空白と空行を圧縮（トークン節約）。
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** MIMEツリーを深さ優先で辿り、指定 mimeType のパート本文をすべて集める。 */
function collectParts(payload: GmailPayload | undefined, mimeType: string): string[] {
  if (!payload) return [];
  const out: string[] = [];
  // 添付ファイル（filename 付き）は本文ではないので無視する。
  const isAttachment = !!payload.filename && payload.filename !== "";
  if (!isAttachment && payload.mimeType === mimeType && payload.body?.data) {
    out.push(decodeBase64Url(payload.body.data));
  }
  for (const part of payload.parts ?? []) {
    out.push(...collectParts(part, mimeType));
  }
  return out;
}

/**
 * MIMEツリーから本文を取り出す。
 *
 * text/plain を優先し、無ければ text/html をタグ除去して使う。
 * multipart/alternative では両方入っていることが多いが、
 * plain のほうがノイズが少なくトークンも食わないので常に優先する。
 */
export function extractPlainText(payload: GmailPayload | undefined): string {
  const plain = collectParts(payload, "text/plain").join("\n").trim();
  if (plain) return plain;
  const html = collectParts(payload, "text/html").join("\n");
  return html ? htmlToText(html) : "";
}

/** ヘッダを名前で引く（大文字小文字は無視）。 */
export function headerValue(payload: GmailPayload | undefined, name: string): string | null {
  const target = name.toLowerCase();
  const hit = (payload?.headers ?? []).find((h) => h.name.toLowerCase() === target);
  return hit?.value ?? null;
}

/**
 * From ヘッダからメールアドレスとドメインを抜く。
 *
 * `"doda X 求人情報" <kyujinjyohomail@doda-x.jp>` のような形も、
 * 山カッコ無しの裸のアドレスも両方受ける。
 */
export function parseSender(raw: string | null): { email: string | null; domain: string | null } {
  if (!raw) return { email: null, domain: null };
  const angled = raw.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();
  const email = candidate.match(/[^\s<>()[\],;:"]+@[^\s<>()[\],;:"]+/)?.[0] ?? null;
  if (!email) return { email: null, domain: null };
  const domain = email.split("@")[1] ?? null;
  return { email, domain };
}

/** 本文を BODY_LIMIT で切り詰める。 */
export function truncateBody(text: string): string {
  return text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text;
}

/**
 * Gmail のメッセージを ParsedMessage に整える。
 *
 * 受信日時は internalDate（エポックミリ秒）を正とする。Date ヘッダは送信側の
 * タイムゾーン設定次第で当てにならないことがあるため、そちらは保険にとどめる。
 */
export function toParsedMessage(msg: GmailMessage): ParsedMessage {
  const sender = headerValue(msg.payload, "From");
  const { email, domain } = parseSender(sender);

  let receivedAt: string | null = null;
  const epoch = Number(msg.internalDate);
  if (Number.isFinite(epoch) && epoch > 0) {
    receivedAt = new Date(epoch).toISOString();
  } else {
    const dateHeader = headerValue(msg.payload, "Date");
    const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
    if (Number.isFinite(parsed)) receivedAt = new Date(parsed).toISOString();
  }

  return {
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId ?? null,
    sender,
    senderEmail: email,
    senderDomain: domain,
    subject: headerValue(msg.payload, "Subject"),
    receivedAt,
    snippet: msg.snippet ?? null,
    bodyText: truncateBody(extractPlainText(msg.payload)),
  };
}
