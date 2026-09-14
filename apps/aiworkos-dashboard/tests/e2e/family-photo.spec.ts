import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// 思い出の写真（/family）が、本当に画面へ出ているかを確かめる。
//
// 写真は非公開バケットにあり、公開URLを持たない。表示は /api/family/photo という
// プロキシ越しなので、「img タグが並んでいる」だけでは足りない。実際に画像として
// 読み込めたか（naturalWidth > 0）まで見る。
//
// この画面は 2026-09-13 まで原寸をそのまま返していた（1枚560KB前後・1.2秒）。
// 幅を付けて Storage 側で縮めて返すようにしたので、一覧が縮小版を使っている
// ことも合わせて見張る。

test.describe("思い出の写真", () => {
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
    // 読み取りのみ。画面が勝手に書き込む作りになっていたらここで気づける
    await context.route("**/*", async (route) => {
      const method = route.request().method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        return route.abort("blockedbyclient");
      }
      return route.fallback();
    });
  });

  test("写真が実際に読み込まれている", async ({ page }) => {
    await page.goto("/family");
    expect(new URL(page.url()).pathname).not.toBe("/login");

    const photos = page.locator('img[src*="/api/family/photo"]');
    await expect(photos.first()).toBeVisible({ timeout: 30_000 });

    // 割れた画像ではなく本当に描画できているか
    await page.waitForFunction(
      () => {
        const el = document.querySelector<HTMLImageElement>(
          'img[src*="/api/family/photo"]'
        );
        return !!el && el.complete && el.naturalWidth > 0;
      },
      undefined,
      { timeout: 30_000 }
    );

    const first = await photos.first().evaluate((el) => ({
      w: (el as HTMLImageElement).naturalWidth,
      src: (el as HTMLImageElement).getAttribute("src") ?? "",
    }));
    expect(first.w, "1枚目が読み込めていません").toBeGreaterThan(0);
    // 一覧は縮小版を使う（原寸をそのまま並べると1画面で数MBになる）
    expect(first.src, "一覧の写真が原寸のままです").toContain("w=");
  });

  test("写真の配信は合言葉が無いと通らない", async ({ playwright, baseURL }) => {
    const bare = await playwright.request.newContext({ baseURL });
    const res = await bare.get("/api/family/photo?path=zzz%2Fnope.jpg&w=480");
    expect(res.status(), "合言葉なしで写真の口が開いています").toBe(401);
    await bare.dispose();
  });
});
