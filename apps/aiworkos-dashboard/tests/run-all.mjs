#!/usr/bin/env node
// `npm run test:all` の進行役。
//
// 型チェック → build → スモーク → E2E を順に回す。
// 途中で1つでも落ちたらそこで止める（後続を流しても意味が無いため）。
//
// なぜ専用スクリプトが要るか:
//   スモークもE2Eも「動いているサーバー」を必要とするが、立ち上げ役が居なかった。
//   これまでは手で dev サーバーを起こしてから叩いていて、忘れると
//   「全部落ちた」ように見えて原因調べに時間を取られていた。
//   ここで本番ビルドを1回だけ立て、2つのテストで使い回して、最後に必ず落とす。
//
// 秘密情報は表示しない。APP_PASSPHRASE 等は Next が .env.local から読む。

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT || 3024);
// ★ホスト名は localhost にする。tests/smoke.mjs はローカル実行かどうかを
//   BASE.includes("localhost") で判定しており、127.0.0.1 だと
//   ローカルでは動かせない /cron/* まで叩きに行って500で落ちる。
const BASE = `http://localhost:${PORT}`;

function step(label) {
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m`);
}

/** 同期実行。失敗したら即座に終わる。 */
function run(label, cmd, args, extraEnv = {}) {
  step(label);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    console.error(`\n\x1b[31m✗ ${label} で失敗しました\x1b[0m`);
    process.exit(r.status ?? 1);
  }
}

/** サーバーが応答するまで待つ。合言葉が無くても /login が返るので200系/300系で判断する。 */
async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return true;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let server = null;
function stopServer() {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    server = null;
  }
}
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

const main = async () => {
  run("1/5 TypeScriptチェック", "npx", ["tsc", "--noEmit"]);
  // サーバー不要の純粋ロジック。ここで落ちるならビルドを待つ意味がないので先に回す。
  run("2/5 純粋ロジック（Memory 2.0 Shadow）", "node", ["tests/shadow.mjs"]);
  run("3/5 本番ビルド", "npx", ["next", "build"]);

  step(`検証用サーバーを起動（${BASE}）`);
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: ROOT,
    // 起動ログは伏せる。落ちたときだけ stderr を見せる。
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env,
  });

  if (!(await waitForServer(BASE))) {
    console.error("\x1b[31m✗ 検証用サーバーが起動しませんでした\x1b[0m");
    stopServer();
    process.exit(1);
  }
  console.log("  起動しました");

  run("4/5 スモークテスト（API）", "node", ["tests/smoke.mjs"], { BASE });
  // E2E_BASE_URL を渡すと playwright.config.ts は自前でサーバーを立てず、ここのものを使う。
  run("5/5 E2Eテスト（ブラウザ）", "npx", ["playwright", "test"], { E2E_BASE_URL: BASE });

  stopServer();
  console.log("\n\x1b[32m✔ すべて通りました\x1b[0m");
};

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
