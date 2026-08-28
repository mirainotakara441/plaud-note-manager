import { defineConfig, devices } from "@playwright/test";

// ブラウザE2E（tests/e2e）。AGENTS.md の検証ルールを自動化したもの。
//
// ■ なぜ要るか
// 「UIを触ったら push する前に必ずブラウザで1回開く」というルールが AGENTS.md にあるが、
// 人の手に頼っているため抜ける。実際 /weapons は curl だけで検証して本番に出し、
// API が {name,count} の配列を返すのに文字列として描画してクラッシュした。
// tsc と build が通ることと、画面が表示できることは別物——それを機械に見張らせる。
//
// ■ smoke.mjs との棲み分け
//   tests/smoke.mjs … APIが生きているか（74本の疎通）。ブラウザは使わない
//   tests/e2e       … 画面が本当に描画できるか。ブラウザで実際に開く
// どちらも読み取りのみで、本番データは書き換えない。
//
// ■ サーバー
// 本番ビルドを next start で立てて検証する（利用者が触るものに近づけるため）。
// 3024番は開発サーバー（3020/3023）と衝突しない番号を選んでいる。
// APP_PASSPHRASE などの環境変数は Next が .env.local から自動で読む。

const PORT = Number(process.env.E2E_PORT || 3024);
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // 画面を開くだけの検査なので、1画面あたりの猶予は短くてよい。
  // ただし本番ビルドの初回アクセスとAPIの往復ぶんは見込む。
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // 落ちたテストを黙って通さない。再試行で隠れる不安定さは、それ自体が問題。
  retries: 0,
  // 1人用アプリの検証。並列で同じSupabaseを叩いても読み取りだけなので安全だが、
  // 遅いAPI（/api/ramen は約187KB）が重なると誤検知が出るため控えめにする。
  workers: 2,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    // 失敗したときだけ証拠を残す。成功時に残すとディスクを食うだけ。
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    // 吉井さんの主な利用端末はiPhone。まずはその幅で見る。
    viewport: { width: 390, height: 844 },
  },
  projects: [
    {
      name: "chromium-mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: BASE_URL,
        // 既に立っていれば使い回す（手元で何度も回すとき速い）。
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
