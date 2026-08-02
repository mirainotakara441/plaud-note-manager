// Xのキーが正しく署名できるかを、投稿せずに確かめる。
//
//   node scripts/verify-x-keys.mjs
//
// GET /2/users/me を OAuth 1.0a で叩き、返ってきたユーザー名を表示するだけ。
// 読み取り1回ぶんのクレジットしか使わず、タイムラインには何も出ない。
// キーの値は一切表示しない（長さと成否だけ）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV = path.join(process.cwd(), ".env.local");
if (!fs.existsSync(ENV)) {
  console.error("エラー: .env.local が見つかりません。リポジトリ直下で実行してください。");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(ENV, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const need = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`エラー: 未設定の項目があります → ${missing.join(", ")}`);
  process.exit(1);
}
console.log("キーの読み込み:");
for (const k of need) console.log(`  ${k.padEnd(24)} ${env[k].length}文字`);

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

const URL_ME = "https://api.x.com/2/users/me";
const res = await fetch(URL_ME, {
  headers: { Authorization: authHeader("GET", URL_ME, {}) },
});
const text = await res.text();

console.log(`\nHTTP ${res.status}`);
if (res.ok) {
  let name = "";
  try {
    const j = JSON.parse(text);
    name = `@${j?.data?.username ?? "?"}（${j?.data?.name ?? "?"}）`;
  } catch {
    name = "(応答を解析できませんでした)";
  }
  console.log(`✓ 認証に成功しました → ${name}`);
  console.log("  キー4本と署名は正しく、クレジットも足りています。");
  console.log("  ※ これは読み取りの確認です。投稿できるかは書き込み権限次第で、");
  console.log("    そちらは実際に1本出すまで確定しません。");
} else {
  console.log("✗ 失敗しました。応答:");
  console.log(text.slice(0, 500));
  console.log("\n読み解きかた:");
  console.log("  401 … キーが違うか、権限変更の前に発行したトークンを使っている");
  console.log("  403 … 権限不足（アプリがReadのまま）");
  console.log("  402/429 … クレジット不足、または上限に達している");
}
