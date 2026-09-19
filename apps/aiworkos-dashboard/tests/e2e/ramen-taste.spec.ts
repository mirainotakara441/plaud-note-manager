import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// /ramen/taste（味を1杯ずつ選ぶ画面。2026-09-19 新設）。
//
// 見るのは「味が決まっていない杯だけが出ること」「1杯に9つの選択肢が出ること」
// 「後回しにすると次の杯へ進むこと」。保存（POST）はこのE2Eでは止めているので、
// 押して保存されるところは /api/ramen/update の既存の口に任せる。

test.describe("味を選ぶ", () => {
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

  test("味が決まっていない杯だけが、1杯ずつ出る", async ({ page, playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
    });
    const q = await (await ctx.get("/api/ramen?view=taste")).json();
    const items: { id: number; is_ramen: boolean; taste: string | null }[] = q.items ?? [];
    expect(items.every((i) => i.is_ramen), "ラーメン以外が混ざっています").toBe(true);
    expect(items.every((i) => i.taste == null), "味が決まっている杯が混ざっています").toBe(true);
    await ctx.dispose();

    await page.goto("/ramen/taste");
    expect(new URL(page.url()).pathname).not.toBe("/login");
    const progress = page.getByTestId("taste-progress");
    await expect(progress).toBeVisible({ timeout: 30_000 });
    await expect(progress).toContainText(`残り ${items.length}`);

    if (items.length === 0) {
      await expect(page.getByText("全部つきました")).toBeVisible();
      return;
    }
    const card = page.getByTestId("taste-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText(`#${items[0].id}`);
    // 9つの味と、後回し
    await expect(page.getByTestId("taste-choices").getByRole("button")).toHaveCount(9);
    await expect(card.getByRole("button", { name: "分からない（後回し）" })).toBeVisible();

    // 後回しにすると次の杯へ（2杯以上あるとき）
    if (items.length >= 2) {
      await card.getByRole("button", { name: "分からない（後回し）" }).click();
      await expect(card).toContainText(`#${items[1].id}`);
      await expect(progress).toContainText(`残り ${items.length}`); // 後回しは減らない
    }
  });

  test("ジャンル別から味を選ぶ画面へ行ける", async ({ page }) => {
    await page.goto("/ramen");
    await page.getByRole("tab", { name: "ジャンル別" }).click();
    const link = page.getByRole("link", { name: /1杯ずつ味をつける/ });
    // 未設定が0になったらこのリンクは消える。あるときだけ辿る
    if ((await link.count()) > 0) {
      await link.click();
      await expect(page).toHaveURL(/\/ramen\/taste$/);
      await expect(page.getByRole("heading", { name: /味を選ぶ/ })).toBeVisible();
    }
  });
});
