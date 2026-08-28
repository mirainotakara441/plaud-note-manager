import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { authCookieValue, COOKIE_NAME } from "./auth";

// 主要画面が「本当にブラウザで開けるか」だけを見るE2E。
//
// AGENTS.md のルール「UIを触ったら push する前に必ずブラウザで1回開く」を機械化したもの。
// 深い機能テストではない。狙いは、tsc と build を通り抜けてしまう
// 「開いたら落ちる」事故を自動で捕まえること。
//
// ■ 守っていること
//   ・読み取りのみ。POST / PUT / PATCH / DELETE は一切出さない（下でブロックしている）
//   ・本番データを書き換えない
//   ・合言葉は cookie を直接仕込んで通す（値はログに出さない。tests/e2e/auth.ts 参照）

/** 最初に見る5画面。日々使う導線から選んでいる。 */
const TARGETS = [
  { path: "/", name: "ホーム" },
  { path: "/organizations", name: "団体別攻略" },
  { path: "/actions", name: "日々のToDo" },
  { path: "/search", name: "横断検索" },
  { path: "/status", name: "連携ダッシュボード" },
];

/**
 * 画面に出ていたら失敗とみなす文言。
 *
 * このアプリは「取得に失敗したのを空データとして見せない」方針で作ってあり、
 * 失敗時はこれらの文言を必ず画面に出す。逆に言えば、これが出ている＝
 * 裏で何かが落ちているということなので、E2Eの失敗として扱ってよい。
 */
const FAILURE_TEXTS = [
  "取得に失敗しました",
  "通信エラー",
  "取得できませんでした",
  "読み込めませんでした",
  "サーバー設定エラー",
  "Application error",
  "Unhandled Runtime Error",
];

/**
 * console.error のうち、画面の壊れとは関係が無いものを見逃す。
 *
 * ここを広げすぎると検知が効かなくなるので、足すときは理由を書くこと。
 */
const IGNORED_CONSOLE = [
  // ブラウザ拡張・DevTools由来のノイズ
  /Download the React DevTools/i,
  // 画像やアイコンの404は画面の破綻ではない（別途 network で見ている）
  /Failed to load resource: the server responded with a status of 404/i,
];

function isIgnorableConsole(text: string): boolean {
  return IGNORED_CONSOLE.some((re) => re.test(text));
}

type Collected = {
  consoleErrors: string[];
  pageErrors: string[];
  badResponses: string[];
};

/** ページに監視を仕掛け、集めた不具合を返す入れ物を用意する。 */
function watch(page: Page): Collected {
  const c: Collected = { consoleErrors: [], pageErrors: [], badResponses: [] };

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isIgnorableConsole(text)) return;
    c.consoleErrors.push(text);
  });

  // 未捕捉の例外（Reactのクラッシュはたいていここに出る）
  page.on("pageerror", (err) => {
    c.pageErrors.push(err.message);
  });

  // 5xx を拾う。画面が一見出ていても、裏のAPIが落ちていれば不合格にする。
  page.on("response", (res) => {
    if (res.status() >= 500) {
      c.badResponses.push(`${res.status()} ${new URL(res.url()).pathname}`);
    }
  });

  return c;
}

test.beforeEach(async ({ context }) => {
  // 合言葉を通す。値はここでも表示しない。
  const url = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3024");
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: authCookieValue(),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  // ★書き込みを絶対に出さない。読み取り専用であることを仕組みで保証する。
  //   （画面が勝手にPOSTする作りになっていたら、ここで落ちて気づける）
  await context.route("**/*", async (route) => {
    const method = route.request().method();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
});

// 認証そのものが効いているかを見る。
//
// これが無いと、うっかり合言葉を外してしまっても他のテストは全部通ってしまう
// （中身が見えている＝正常、と判定されるため）。守りが外れたことに気づけるよう、
// 「間違ったcookieなら /login へ飛ぶ」ことを明示的に確かめる。
test("合言葉が違えば /login へ飛ばされる（守りが効いていること）", async ({ browser, baseURL }) => {
  const url = new URL(baseURL ?? "http://127.0.0.1:3024");
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

    // 1. そのページ自体が 5xx で返っていないこと
    expect(res, `${target.path} の応答が取れませんでした`).not.toBeNull();
    expect(res!.status(), `${target.path} が HTTP ${res!.status()} を返しました`).toBeLessThan(500);

    // 2. 合言葉が通っていること（/login へ飛ばされていない）
    expect(
      new URL(page.url()).pathname,
      `${target.path} が /login へリダイレクトされました（合言葉cookieの計算が合っていない可能性）`
    ).not.toBe("/login");

    // 3. 中身が描画されていること。<main> が出るまで待つ
    await expect(page.locator("main")).toBeVisible();

    // データ取得は後から走るので、落ち着くまで少し待つ（ここで console.error も出そろう）
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {
      // networkidle にならない画面（ポーリング等）でも検査は続ける
    });

    const body = (await page.locator("body").innerText()).trim();

    // 4. Reactのクラッシュ画面になっていないこと
    expect(found.pageErrors, `${target.path} で未捕捉の例外が出ました`).toEqual([]);
    expect(
      body,
      `${target.path} がNext.jsのエラー画面になっています`
    ).not.toMatch(/Application error: a client-side exception has occurred/i);

    // 5. 真っ白でないこと（描画は成功したが中身が無い、を弾く）
    expect(body.length, `${target.path} の本文がほぼ空です`).toBeGreaterThan(50);

    // 6. 裏のAPIが 5xx を返していないこと
    expect(found.badResponses, `${target.path} で5xxが出ました`).toEqual([]);

    // 7. 画面に「失敗しました」系の表示が出ていないこと
    const shown = FAILURE_TEXTS.filter((t) => body.includes(t));
    expect(shown, `${target.path} に失敗の表示が出ています`).toEqual([]);

    // 8. console.error が出ていないこと
    expect(found.consoleErrors, `${target.path} で console.error が出ました`).toEqual([]);
  });
}
