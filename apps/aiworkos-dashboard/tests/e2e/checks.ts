import {
  expect,
  type APIRequestContext,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type PlaywrightWorkerArgs,
} from "@playwright/test";
import { authCookieValue, COOKIE_NAME } from "./auth";

// E2Eの共通部品。pages.spec.ts と query-params.spec.ts の両方から使う。
//
// 画面ごとの検査内容（5xx・Reactクラッシュ・console.error・失敗表示）は
// どのテストでも同じなので、1か所に集めて食い違いが出ないようにする。

/**
 * 画面に出ていたら失敗とみなす文言。
 *
 * このアプリは「取得に失敗したのを空データとして見せない」方針で作ってあり、
 * 失敗時はこれらの文言を必ず画面に出す。逆に言えば、これが出ている＝
 * 裏で何かが落ちているということなので、E2Eの失敗として扱ってよい。
 */
export const FAILURE_TEXTS = [
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
 * ここを広げすぎると検知が効かなくなるので、足すときは理由を書くこと。
 */
const IGNORED_CONSOLE = [
  // ブラウザ拡張・DevTools由来のノイズ
  /Download the React DevTools/i,
  // 画像やアイコンの404は画面の破綻ではない（別途 network で見ている）
  /Failed to load resource: the server responded with a status of 404/i,
];

export type Collected = {
  consoleErrors: string[];
  pageErrors: string[];
  badResponses: string[];
};

/** ページに監視を仕掛け、集めた不具合を返す入れ物を用意する。 */
export function watch(page: Page): Collected {
  const c: Collected = { consoleErrors: [], pageErrors: [], badResponses: [] };

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
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

/**
 * 合言葉cookieを仕込み、書き込みを機械的に塞ぐ。
 *
 * ★このE2Eは読み取り専用。POST/PUT/PATCH/DELETE はここで落とす
 *   （画面が勝手に書き込む作りになっていたら、そこで気づける）。
 */
export async function prepareContext(context: BrowserContext, baseURL: string | undefined) {
  const url = new URL(baseURL ?? "http://localhost:3024");
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

  await context.route("**/*", async (route) => {
    const method = route.request().method();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
}

/** 読み取り専用のAPI呼び出し用に、合言葉を通した文脈を作る。 */
export async function authedRequest(
  playwright: PlaywrightWorkerArgs["playwright"],
  baseURL: string | undefined
): Promise<APIRequestContext> {
  const base = baseURL ?? "http://localhost:3024";
  return playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
  });
}

/**
 * 「この画面は壊れていない」を一通り確かめる。
 *
 * 開けること・認証が通っていること・描画されていること・
 * 5xxやクラッシュや失敗表示が無いこと。狙いは深い機能検証ではなく、
 * tsc と build を通り抜ける「開いたら落ちる」を捕まえること。
 */
export async function expectHealthyPage(
  page: Page,
  found: Collected,
  label: string,
  res: Awaited<ReturnType<Page["goto"]>>
): Promise<string> {
  // 1. そのページ自体が 5xx で返っていないこと
  expect(res, `${label} の応答が取れませんでした`).not.toBeNull();
  expect(res!.status(), `${label} が HTTP ${res!.status()} を返しました`).toBeLessThan(500);

  // 2. 合言葉が通っていること（/login へ飛ばされていない）
  expect(
    new URL(page.url()).pathname,
    `${label} が /login へリダイレクトされました（合言葉cookieの計算が合っていない可能性）`
  ).not.toBe("/login");

  // 3. 中身が描画されていること
  await expect(page.locator("main")).toBeVisible();

  // データ取得は後から走るので、落ち着くまで待つ（ここで console.error も出そろう）
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {
    // networkidle にならない画面（ポーリング等）でも検査は続ける
  });

  const body = (await page.locator("body").innerText()).trim();

  // 4. Reactのクラッシュ画面になっていないこと
  expect(found.pageErrors, `${label} で未捕捉の例外が出ました`).toEqual([]);
  expect(body, `${label} がNext.jsのエラー画面になっています`).not.toMatch(
    /Application error: a client-side exception has occurred/i
  );

  // 5. 真っ白でないこと
  expect(body.length, `${label} の本文がほぼ空です`).toBeGreaterThan(50);

  // 6. 裏のAPIが 5xx を返していないこと
  expect(found.badResponses, `${label} で5xxが出ました`).toEqual([]);

  // 7. 画面に「失敗しました」系の表示が出ていないこと
  expect(
    FAILURE_TEXTS.filter((t) => body.includes(t)),
    `${label} に失敗の表示が出ています`
  ).toEqual([]);

  // 8. console.error が出ていないこと
  expect(found.consoleErrors, `${label} で console.error が出ました`).toEqual([]);

  return body;
}
