import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// E2Eから合言葉認証を通すための小道具。
//
// ★秘密情報は絶対に出力しない。値をログへ出さず、エラー文にも混ぜない。
//
// ログイン画面をブラウザで操作する代わりに、cookieを直接仕込む方式にしている。
// 理由は2つ:
//   1. /api/login は POST。このE2Eは「書き込みを一切しない」方針なので叩かない
//   2. ログイン操作そのものは検査対象ではなく、毎回通ると遅くなる
//
// cookie値の作り方は lib/auth.ts の cookieValueFor と同じにしてある。
// AUTH_COOKIE_SECRET があればHMAC-SHA256、無ければSHA-256のフォールバック。
// ここがズレると全画面が /login へ飛ばされ、原因が分かりにくい失敗になる。

// Playwright はテストをCJSへ変換して走らせるため import.meta が使えない。
// 実行は必ずプロジェクト直下（playwright.config.ts のある場所）からなので cwd を使う。
const ROOT = process.cwd();

export const COOKIE_NAME = "aiworkos_auth";

/** .env.local を読む（値は返すだけで、決して表示しない）。 */
function loadEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 合言葉から cookie の値を作る。lib/auth.ts の cookieValueFor と同じ計算。
 * 失敗しても合言葉そのものは例外に含めない。
 */
export function authCookieValue(): string {
  const env = loadEnv();
  const passphrase = process.env.APP_PASSPHRASE || env.APP_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      "APP_PASSPHRASE が読めません（.env.local か環境変数に設定してください）"
    );
  }
  const secret = (process.env.AUTH_COOKIE_SECRET || env.AUTH_COOKIE_SECRET || "").trim();
  return secret
    ? createHmac("sha256", secret).update(passphrase).digest("hex")
    : createHash("sha256").update(passphrase).digest("hex");
}
