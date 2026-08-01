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

// APPENDの1チャンクは5MB未満という制約があるため、余裕を見て4MBで切る。
const CHUNK_BYTES = 4 * 1024 * 1024;

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

function withQuery(url: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join("&");
  return qs ? `${url}?${qs}` : url;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `${res.status} ${text.slice(0, 300)}`;
}

// INIT → APPEND(分割) → FINALIZE の3段。単発アップロードの口は用意されていない。
export async function uploadMedia(
  bytes: Buffer,
  contentType: string,
  c: XCreds
): Promise<string> {
  const initParams = {
    command: "INIT",
    total_bytes: String(bytes.byteLength),
    media_type: contentType,
    media_category: "tweet_image",
  };
  const initRes = await fetch(withQuery(MEDIA_URL, initParams), {
    method: "POST",
    headers: { Authorization: authHeader("POST", MEDIA_URL, initParams, c) },
  });
  if (!initRes.ok) throw new Error(`media INIT 失敗: ${await readError(initRes)}`);
  const initJson = await initRes.json();
  const mediaId: string | undefined = initJson?.data?.id ?? initJson?.media_id_string;
  if (!mediaId) throw new Error("media INIT の応答に media_id がありません");

  for (let i = 0, seg = 0; i < bytes.byteLength; i += CHUNK_BYTES, seg += 1) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_BYTES, bytes.byteLength));
    const appendParams = {
      command: "APPEND",
      media_id: mediaId,
      segment_index: String(seg),
    };
    const boundary = `----aiworkos${crypto.randomBytes(8).toString("hex")}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="media"; filename="chunk"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, chunk, tail]);

    const appendRes = await fetch(withQuery(MEDIA_URL, appendParams), {
      method: "POST",
      headers: {
        Authorization: authHeader("POST", MEDIA_URL, appendParams, c),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });
    if (!appendRes.ok) throw new Error(`media APPEND 失敗: ${await readError(appendRes)}`);
  }

  const finParams = { command: "FINALIZE", media_id: mediaId };
  const finRes = await fetch(withQuery(MEDIA_URL, finParams), {
    method: "POST",
    headers: { Authorization: authHeader("POST", MEDIA_URL, finParams, c) },
  });
  if (!finRes.ok) throw new Error(`media FINALIZE 失敗: ${await readError(finRes)}`);

  return mediaId;
}

export async function postTweet(
  text: string,
  mediaIds: string[],
  c: XCreds
): Promise<{ id: string; url: string }> {
  const payload: Record<string, unknown> = { text };
  if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };

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
