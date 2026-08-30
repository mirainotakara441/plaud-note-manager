import crypto from "node:crypto";

// X（Twitter）投稿クライアント。OAuth 1.0a User Context で署名する。
//
// なぜ OAuth 1.0a か:
//   個人1アカウントの自動投稿しかしないため、OAuth 2.0 のリフレッシュトークン管理を
//   持ち込む理由がない。キー4本を環境変数に置くだけで済み、失効もしない。
//   /2/media/upload・/2/tweets とも OAuth 1.0a User Context に対応している。
//
// 課金（2026年2月〜の従量課金）:
//   投稿1本 $0.015。ただし本文にURLが含まれると $0.20 に跳ねるため、
//   本文にリンクを入れない運用にしている（lib/ramen.ts の文体ルールにも明記）。

const TWEETS_URL = "https://api.x.com/2/tweets";
const MEDIA_URL = "https://api.x.com/2/media/upload";

// 画像1枚の上限。これを超えるものは投稿前に弾く（縮小は呼び出し側の責任）。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type XCreds = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
};

export function xCreds(): XCreds | null {
  const apiKey = process.env.X_API_KEY?.trim();
  const apiSecret = process.env.X_API_SECRET?.trim();
  const accessToken = process.env.X_ACCESS_TOKEN?.trim();
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET?.trim();
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

// RFC3986。encodeURIComponent が素通しする !*'() まで潰さないと署名が合わない。
function pct(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// 署名対象は「oauth_* ＋ クエリ文字列のパラメータ」。
// JSONボディ・multipartボディは署名に含めない（仕様どおり）。
function authHeader(
  method: string,
  url: string,
  queryParams: Record<string, string>,
  c: XCreds
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };

  const all = { ...oauth, ...queryParams };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");

  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const key = `${pct(c.apiSecret)}&${pct(c.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `${res.status} ${text.slice(0, 300)}`;
}

// 画像1枚のアップロード。
//
// /2/media/upload は multipart/form-data のみを受け付ける。クエリ文字列に積むと
// 400（"query parameter [total_bytes] is not one of []"）、フォームURLエンコードでも
// 同じく弾かれる。2026-08-01の実機確認で確定した仕様。
// multipartのボディは OAuth 1.0a の署名対象外なので、署名は oauth_* だけで作る。
//
// 画像は media フィールドに丸ごと入れて1回で送る。INIT/APPEND/FINALIZE の分割方式は
// 動画や大きいファイル向けで、画像に使うと "Missing media field in JSON" で落ちる。
export async function uploadMedia(
  bytes: Buffer,
  contentType: string,
  c: XCreds
): Promise<string> {
  if (bytes.byteLength >= MAX_IMAGE_BYTES) {
    throw new Error(
      `画像が大きすぎます（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB / 上限5MB）`
    );
  }

  const boundary = `----aiworkos${crypto.randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media_category"\r\n\r\ntweet_image\r\n`
    ),
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="media"; filename="image"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(MEDIA_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader("POST", MEDIA_URL, {}, c),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`画像のアップロードに失敗: ${await readError(res)}`);

  const json = await res.json();
  const mediaId: string | undefined = json?.data?.id ?? json?.media_id_string ?? json?.id;
  if (!mediaId) throw new Error("アップロードの応答に media_id がありません");
  return mediaId;
}

// XのURLから投稿IDを取り出す。x.com / twitter.com のどちらでも、
// ?s=20 のような追跡パラメータが付いていても拾える。
export function tweetIdFromUrl(input: string): string | null {
  const t = input.trim();
  if (/^\d{5,25}$/.test(t)) return t; // IDそのものを渡された場合
  const m = t.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1] : null;
}

// 引用リポストは payload の quote_tweet_id で送る。本文にURLを貼る方式とは別物で、
// text にURLが入らないため post-x 側のURLガード（課金が跳ねるので止めている）にも
// 引っかからない。
export async function postTweet(
  text: string,
  mediaIds: string[],
  c: XCreds,
  opts: { quoteTweetId?: string } = {}
): Promise<{ id: string; url: string }> {
  const payload: Record<string, unknown> = { text };
  if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };
  if (opts.quoteTweetId) payload.quote_tweet_id = opts.quoteTweetId;

  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader("POST", TWEETS_URL, {}, c),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`投稿に失敗: ${await readError(res)}`);

  const json = await res.json();
  const id: string | undefined = json?.data?.id;
  if (!id) throw new Error("投稿の応答に id がありません");
  return { id, url: `https://x.com/0kara1_man/status/${id}` };
}
