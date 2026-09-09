#!/usr/bin/env node
// Gmail の refresh token を1回だけ取得するためのCLI。
//
//   npm run gmail:token
//
// 依存パッケージはゼロ（Node標準モジュールだけ）。
// ローカルに一時的なHTTPサーバを立て、ブラウザでのGoogle認可が終わったら
// そこへ返ってくる認可コードを受け取り、refresh token に交換して画面に表示する。
//
// 設計上の約束:
//   - 要求するスコープは gmail.readonly のみ。読み取り専用で、送信も削除もできない。
//   - 取得したトークンは表示するだけで、ファイルには一切書き込まない。
//     .env.local への貼り付けは手作業でお願いします（うっかりコミットを防ぐため）。

import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import crypto from "node:crypto";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** 環境変数、無ければ対話入力で値を受ける。 */
async function ask(rl, envName, label) {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) {
    console.log(`${label}: 環境変数 ${envName} の値を使います`);
    return fromEnv;
  }
  const answer = (await rl.question(`${label} を貼り付けてください: `)).trim();
  if (!answer) {
    console.error(`${label} が空です。中断します。`);
    process.exit(1);
  }
  return answer;
}

/** macOS の open コマンドでブラウザを開く。失敗しても URL は表示済みなので致命的ではない。 */
function openBrowser(url) {
  try {
    const child = spawn("open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 開けなくても手動でURLを踏めばよい。
  }
}

/** 認可コードが返ってくるまで待つ一時サーバ。 */
function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const reply = (message) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:sans-serif;padding:40px"><h2>${message}</h2><p>このタブは閉じて、ターミナルに戻ってください。</p></body></html>`
        );
      };

      if (error) {
        reply("認可がキャンセルされました");
        server.close();
        reject(new Error(`Google から error=${error} が返りました`));
        return;
      }
      // state を照合する。別のタブから飛んできたコードを掴まないための保険。
      if (state !== expectedState) {
        reply("state が一致しませんでした");
        server.close();
        reject(new Error("state が一致しません。もう一度やり直してください。"));
        return;
      }
      if (!code) {
        reply("認可コードが取得できませんでした");
        server.close();
        reject(new Error("認可コードが返ってきませんでした"));
        return;
      }

      reply("認可が完了しました");
      server.close();
      resolve(code);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `ポート ${PORT} が既に使われています。他のプロセスを終了してから、もう一度実行してください。`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(PORT, "127.0.0.1");
  });
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("=== Gmail refresh token 取得ツール ===");
  console.log("Google Cloud Console で作成した OAuth クライアント（デスクトップアプリ）の");
  console.log("クライアントIDとクライアントシークレットが必要です。");
  console.log("手順は docs/gmail-setup.md を参照してください。\n");

  const clientId = await ask(rl, "GMAIL_CLIENT_ID", "クライアントID");
  const clientSecret = await ask(rl, "GMAIL_CLIENT_SECRET", "クライアントシークレット");
  rl.close();

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    // この2つが揃っていないと refresh_token が返ってこない。
    // access_type=offline でオフラインアクセスを要求し、
    // prompt=consent で「既に許可済み」でも同意画面を出させる。
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString()}`;

  console.log("\n以下のURLをブラウザで開いて、mirainotakara441@gmail.com で許可してください。");
  console.log("（自動でブラウザが開きます。開かない場合は手でコピーしてください）\n");
  console.log(authUrl);
  console.log("\n認可が終わるまで待機します...\n");

  const codePromise = waitForCode(state);
  openBrowser(authUrl);
  const code = await codePromise;

  console.log("認可コードを受け取りました。トークンに交換します...\n");

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    console.error("トークンの交換に失敗しました:", JSON.stringify(json, null, 2));
    process.exit(1);
  }
  if (!json.refresh_token) {
    console.error("refresh_token が返ってきませんでした。");
    console.error(
      "既に同じクライアントで許可済みの可能性があります。"
    );
    console.error(
      "https://myaccount.google.com/permissions で該当アプリのアクセス権を削除してから、もう一度実行してください。"
    );
    process.exit(1);
  }

  console.log("=== 取得できました ===\n");
  console.log(`GMAIL_REFRESH_TOKEN=${json.refresh_token}\n`);
  console.log("上の1行を .env.local に貼ってください。");
  console.log("（このツールはファイルへの書き込みを一切行いません）");
  console.log("Vercel にも同じ値を環境変数として登録してください。\n");
  console.log(
    "※ OAuth同意画面が「テスト」ステータスのままだと、この refresh token は7日で失効します。"
  );
  console.log("   docs/gmail-setup.md の手順3を必ず確認してください。");
}

main().catch((err) => {
  console.error("\nエラー:", err.message);
  process.exit(1);
});
