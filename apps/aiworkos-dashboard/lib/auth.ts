// 合言葉認証まわりの共通ヘルパー。proxy.ts（認証ゲート）と
// app/api/login/route.ts（合言葉照合・cookie発行）の両方から使う。
//
// - sha256Hex / hmacSha256Hex: Web Crypto (crypto.subtle) のみで実装。
//   proxy.ts は Next.js の Proxy(旧middleware)としてEdge Runtimeで動くため、
//   node:crypto は使えない（importすると build/runtime で失敗する）。
//   よって login/route.ts 側も含めて同じWeb Crypto実装で統一する。
// - constantTimeEqual: 定数時間文字列比較。node:crypto の timingSafeEqual は
//   Edge Runtimeで使えない上、長さが異なるバッファだと例外を投げる制約もあるため、
//   長さが違っても最後まで走査してから結果を返す純粋JS実装にする
//   （2026-07-25 アーキテクチャレビュー P2対応）。
// - cookieValueFor: AUTH_COOKIE_SECRET が設定されていれば HMAC-SHA256(passphrase, secret)、
//   未設定なら従来通り SHA-256(passphrase) にフォールバックする2モード方式。
//   フォールバックがあるため env未設定でも壊れない。Vercelに AUTH_COOKIE_SECRET を
//   後日設定すると自動的に強い方式へ切り替わる（副作用として全端末で再ログインが1回必要）。

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufToHex(digest);
}

async function hmacSha256Hex(text: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return bufToHex(sig);
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 合言葉から cookie に入れる値を作る。AUTH_COOKIE_SECRET があればHMAC、無ければ
// 従来のSHA-256（フォールバック、env未設定でも動く）。
export async function cookieValueFor(passphrase: string): Promise<string> {
  const secret = process.env.AUTH_COOKIE_SECRET?.trim();
  if (secret) return hmacSha256Hex(passphrase, secret);
  return sha256Hex(passphrase);
}

// 定数時間文字列比較。長さが違っても最後まで走査してから結果を返すため、
// 早期returnによるタイミング差（合っている文字数を推測されるサイドチャネル）を作らない。
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
