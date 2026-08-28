import { test, expect } from "@playwright/test";
import { COOKIE_NAME } from "./auth";
import { expectHealthyPage, prepareContext, watch } from "./checks";

// 主要画面が「本当にブラウザで開けるか」だけを見るE2E。
//
// AGENTS.md のルール「UIを触ったら push する前に必ずブラウザで1回開く」を機械化したもの。
// 深い機能テストではない。狙いは、tsc と build を通り抜けてしまう
// 「開いたら落ちる」事故を自動で捕まえること。
//
// 検査の中身と認証・書き込み遮断は tests/e2e/checks.ts に集約している
// （クエリパラメータ付き導線を見る query-params.spec.ts と共通にするため）。

/** 最初に見る5画面。日々使う導線から選んでいる。 */
const TARGETS = [
  { path: "/", name: "ホーム" },
  { path: "/organizations", name: "団体別攻略" },
  { path: "/actions", name: "日々のToDo" },
  { path: "/search", name: "横断検索" },
  { path: "/status", name: "連携ダッシュボード" },
];

test.beforeEach(async ({ context, baseURL }) => {
  await prepareContext(context, baseURL);
});

// 認証そのものが効いているかを見る。
//
// これが無いと、うっかり合言葉を外してしまっても他のテストは全部通ってしまう
// （中身が見えている＝正常、と判定されるため）。守りが外れたことに気づけるよう、
// 「間違ったcookieなら /login へ飛ぶ」ことを明示的に確かめる。
test("合言葉が違えば /login へ飛ばされる（守りが効いていること）", async ({ browser, baseURL }) => {
  const url = new URL(baseURL ?? "http://localhost:3024");
  const ctx = await browser.newContext();
  await ctx.addCookies([
    {
      name: COOKIE_NAME,
      // わざと通らない値。合言葉そのものは使わない。
      value: "0".repeat(64),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.goto("/status", { waitUntil: "domcontentloaded" });
  expect(
    new URL(page.url()).pathname,
    "間違ったcookieでも中に入れてしまいました（認証が外れている可能性）"
  ).toBe("/login");
  await ctx.close();
});

for (const target of TARGETS) {
  test(`${target.path}（${target.name}）が壊れずに開ける`, async ({ page }) => {
    const found = watch(page);
    const res = await page.goto(target.path, { waitUntil: "domcontentloaded" });
    await expectHealthyPage(page, found, target.path, res);
  });
}
