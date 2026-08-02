// 画像つき投稿を実際に1本出して、書き込み権限とメディアアップロードを確かめる。
//
//   node scripts/test-x-post.mjs <画像パス> "<本文>"
//
// lib/x.ts と同じ手順（OAuth 1.0a 署名 → media/upload の INIT/APPEND/FINALIZE →
// /2/tweets）を踏むので、これが通れば本番の経路も通る。
// 投稿を消すには: node scripts/test-x-post.mjs --delete <投稿ID>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV = path.join(process.cwd(), ".env.local");
const env = {};
for (const line of fs.readFileSync(ENV, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function authHeader(method, url, params) {
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...params };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const key = `${pct(env.X_API_SECRET)}&${pct(env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

const MEDIA = "https://api.x.com/2/media/upload";
const TWEETS = "https://api.x.com/2/tweets";
const CHUNK = 4 * 1024 * 1024;

// /2/media/upload は INIT/APPEND/FINALIZE の3つとも multipart/form-data。
// クエリ文字列もフォームURLエンコードも 400 で弾かれる（"is not one of []"）。
// multipart のボディは OAuth 1.0a の署名対象外なので、署名は oauth_* だけで作る。
function multipart(fields, fileField) {
  const boundary = `----x${crypto.randomBytes(8).toString("hex")}`;
  const parts = Object.entries(fields).map(([n, v]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`)
  );
  if (fileField) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="chunk"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      ),
      fileField,
      Buffer.from("\r\n")
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function form(url, fields, file) {
  const { body, boundary } = multipart(fields, file);
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader("POST", url, {}),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });
}

// 画像1枚（5MB未満）なら分割は不要で、media フィールドに丸ごと入れて1回で送れる。
// 分割方式（INIT/APPEND/FINALIZE）は動画や大きいファイル向け。
async function uploadMedia(file) {
  const bytes = fs.readFileSync(file);
  const type = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  console.log(`画像: ${path.basename(file)}（${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${type}）`);
  if (bytes.length >= CHUNK) {
    throw new Error("5MB以上の画像は未対応です。縮小してから試してください。");
  }

  const r = await form(MEDIA, { media_category: "tweet_image" }, bytes);
  if (!r.ok) throw new Error(`アップロード失敗 ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const j = await r.json();
  const id = j?.data?.id ?? j?.media_id_string ?? j?.id;
  if (!id) throw new Error(`応答に media_id がありません: ${JSON.stringify(j).slice(0, 300)}`);
  console.log(`  アップロード ✓`);
  return id;
}

const args = process.argv.slice(2);

if (args[0] === "--delete") {
  const url = `${TWEETS}/${args[1]}`;
  const r = await fetch(url, { method: "DELETE", headers: { Authorization: authHeader("DELETE", url, {}) } });
  const t = await r.text();
  console.log(r.ok ? `✓ 削除しました（${args[1]}）` : `✗ 削除に失敗 ${r.status}: ${t.slice(0, 300)}`);
  process.exit(r.ok ? 0 : 1);
}

const [file, text] = args;
if (!file || !text) {
  console.error('使い方: node scripts/test-x-post.mjs <画像パス> "<本文>"');
  process.exit(1);
}
if (/https?:\/\//i.test(text)) {
  console.error("本文にURLが含まれています。URL入りは単価が13倍になるため中止します。");
  process.exit(1);
}

const mediaId = await uploadMedia(file);
console.log("\n投稿中…");
const res = await fetch(TWEETS, {
  method: "POST",
  headers: { Authorization: authHeader("POST", TWEETS, {}), "Content-Type": "application/json" },
  body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
});
const body = await res.text();
if (!res.ok) {
  console.log(`✗ 投稿に失敗 ${res.status}`);
  console.log(body.slice(0, 500));
  console.log("\n403 なら書き込み権限がまだ効いていません（権限変更後にトークンを再発行したか確認）");
  process.exit(1);
}
const tweetId = JSON.parse(body)?.data?.id;
console.log(`✓ 投稿しました`);
console.log(`  https://x.com/0kara1_man/status/${tweetId}`);
console.log(`\n消すとき: node scripts/test-x-post.mjs --delete ${tweetId}`);
