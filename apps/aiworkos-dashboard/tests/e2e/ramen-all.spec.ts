import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// 「食べたもの全部」の一覧（/ramen/all）。
// この画面の値打ちは、過去をスクロールせずに見渡せること。だから
// 「開ける」だけでなく、件数が並んでいるか・写真が本当に出ているか・
// 通算杯数から来られるかまで見る。

test.describe("食べたもの全部", () => {
  test.beforeEach(async ({ context, baseURL }) => {
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
  });

  test("通算杯数から一覧へ行ける", async ({ page }) => {
    await page.goto("/ramen");
    // タイルは一覧を読み終えてから出る（/api/ramen は約190KBで数秒かかる）。
    // 待たずに押すとまだ無い
    const tile = page.getByText("通算杯数");
    await expect(tile).toBeVisible({ timeout: 30_000 });
    await tile.click();
    await page.waitForURL("**/ramen/all");
    await expect(page.getByRole("heading", { name: /食べたもの全部/ })).toBeVisible();
  });

  test("1杯1枚で並び、写真が実際に出ている", async ({ page }) => {
    await page.goto("/ramen/all");
    expect(new URL(page.url()).pathname).not.toBe("/login");

    // 200件近くが1枚に並ぶ。数件しか出ていないなら取得か絞り込みが壊れている
    const cards = page.locator("section img, section div.aspect-square");
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    expect(await cards.count(), "一覧の件数が少なすぎます").toBeGreaterThan(100);

    // 割れた画像ではなく本当に読み込めているか
    await page.waitForFunction(
      () => {
        const el = document.querySelector<HTMLImageElement>('img[src*="/api/ramen/photo"]');
        return !!el && el.complete && el.naturalWidth > 0;
      },
      undefined,
      { timeout: 30_000 }
    );

    // 写真が複数ある杯でも、一覧に出るのは1枚だけ
    const perCard = await page.evaluate(() =>
      Array.from(document.querySelectorAll("section > div > div")).map(
        (c) => c.querySelectorAll('img[src*="/api/ramen/photo"]').length
      )
    );
    expect(Math.max(...perCard), "1杯に2枚以上出ています").toBeLessThanOrEqual(1);
  });

  test("日付・杯番号・★・店名がそろって出ている", async ({ page }) => {
    await page.goto("/ramen/all");
    await expect(page.locator("text=/\\d+\\/\\d+（[日月火水木金土]）/").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("text=/\\d+杯目/").first()).toBeVisible();
    await expect(page.locator("text=/★/").first()).toBeVisible();
  });

  test("写真ありだけに絞れる", async ({ page }) => {
    await page.goto("/ramen/all");
    await expect(page.locator("section").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "写真ありのみ" }).click();
    // 絞った後は、写真の無い枠（🍜のプレースホルダ）が1つも残らない
    await expect(page.locator("text=🍜").filter({ hasNotText: "食べたもの" })).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});
