import { test, expect, type BrowserContext } from "@playwright/test";
import {
  COOKIE_NAME,
  HOJIN_QA_COOKIE_NAME,
  authCookieValue,
  hojinQaCookieValue,
} from "./auth";
import { expectHealthyPage, watch } from "./checks";

// 法人請求QA検索（/hojin-qa）の守りと表示。
//
// 2026-09-17 にQAの実体を本体へ取り込み、法人請求チームのメンバーへ配る前提にした。
// ここで固定したいのは1点に尽きる：
//   「QA専用の合言葉 cookie では /hojin-qa だけ開けて、本体の他ページには入れない」
// これが崩れると、メンバーに本体（日記・商談データ・生成API）が見える事故になる。
// 逆方向（本体の cookie だけでは /hojin-qa に入れず /qa-gate へ送られる）も見る。
//
// 検査は読み取りのみ。POST は叩かない（合言葉照合そのものは検査対象にしない）。

async function addCookie(context: BrowserContext, baseURL: string | undefined, name: string, value: string) {
  const url = new URL(baseURL ?? "http://localhost:3024");
  await context.addCookies([
    { name, value, domain: url.hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  ]);
}

test.describe("QA専用cookieだけを持つメンバー", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await addCookie(context, baseURL, HOJIN_QA_COOKIE_NAME, hojinQaCookieValue());
    await context.route("**/*", async (route) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(route.request().method())) {
        return route.abort("blockedbyclient");
      }
      return route.fallback();
    });
  });

  test("/hojin-qa が開き、検索窓と87件の一覧が出る", async ({ page }) => {
    const found = watch(page);
    const res = await page.goto("/hojin-qa", { waitUntil: "domcontentloaded" });
    const body = await expectHealthyPage(page, found, "法人請求QA検索", res);
    expect(new URL(page.url()).pathname).toBe("/hojin-qa");
    expect(body).toContain("法人請求QA検索");
    expect(body).toContain("87");
    await expect(page.getByPlaceholder("相手の発言・キーワードで探す")).toBeVisible();
    // 本体の導線（下部タブ）は出さない。押しても /login に弾かれるだけなので。
    await expect(page.getByRole("navigation", { name: "主要ページ" })).toHaveCount(0);
  });

  test("検索「キャッシュレス」で B-08 と C-17 が残る", async ({ page }) => {
    await page.goto("/hojin-qa", { waitUntil: "domcontentloaded" });
    const input = page.getByPlaceholder("相手の発言・キーワードで探す");
    await input.fill("キャッシュレス");
    const body = page.locator("body");
    await expect(body).toContainText("B-08");
    await expect(body).toContainText("C-17");
    // 絞れていること（全件のままではない）
    await expect(body).not.toContainText("A-01 ");
  });

  test("本体のページには入れない（/ は /login へ、API は 401）", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname).toBe("/login");

    await page.goto("/diary", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname).toBe("/login");

    const api = await page.request.get("/api/status");
    expect(api.status()).toBe(401);
  });

  test("/qa-gate を開き直すと合言葉を聞かず /hojin-qa へ送られる", async ({ page }) => {
    await page.goto("/qa-gate", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname).toBe("/hojin-qa");
  });
});

test.describe("本体のcookieしか持たない場合", () => {
  test("/hojin-qa は /qa-gate へ送られる（本体の合言葉では代用できない）", async ({
    context,
    page,
    baseURL,
  }) => {
    await addCookie(context, baseURL, COOKIE_NAME, authCookieValue());
    await page.goto("/hojin-qa", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname).toBe("/qa-gate");
    await expect(page.getByPlaceholder("合言葉")).toBeVisible();
  });
});

test.describe("cookieなし", () => {
  test("/hojin-qa は /qa-gate へ、間違ったQA cookie でも同じ", async ({ context, page, baseURL }) => {
    await page.goto("/hojin-qa", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname).toBe("/qa-gate");

    await addCookie(context, baseURL, HOJIN_QA_COOKIE_NAME, "0".repeat(64));
    await page.goto("/hojin-qa", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname).toBe("/qa-gate");
  });
});
