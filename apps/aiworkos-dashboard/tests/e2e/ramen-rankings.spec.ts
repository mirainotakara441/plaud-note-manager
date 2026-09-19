import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// /ramen の「ランキング」枠（2026-09-19 新設）。
//
//   杯数が多い順 … 行った回数が多い店のベスト5
//   ジャンル別   … 形態と味・系統ごとの杯数
//   駅別         … 最寄り駅ごとの杯数
//   マイベスト   … 自分の★が高い順
//   百名店       … 食べログ「ラーメン TOKYO 百名店 2025」100店の 行った／まだ
//
// 「タブが並んでいる」だけでは足りない。切り替えたら中身が入れ替わり、
// 数字が実データと合っていることまで見る（集計が静かに間違うのを防ぐ）。

test.describe("ラーメンのランキング", () => {
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

  test("杯数が多い順にベスト5が出る", async ({ page }) => {
    await page.goto("/ramen");
    const list = page.getByTestId("rank-shops");
    await expect(list).toBeVisible({ timeout: 30_000 });
    const rows = list.locator("li");
    await expect(rows).toHaveCount(5);
    // 回数が降順に並んでいる
    const counts = await rows.locator("span.font-bold.text-gray-900").allTextContents();
    const nums = counts.map((c) => Number(c));
    expect(nums.length).toBe(5);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i], `${i + 1}位が${i}位より多い`).toBeLessThanOrEqual(nums[i - 1]);
    }
    expect(nums[0], "1位が2回未満です").toBeGreaterThanOrEqual(2);
  });

  test("ジャンル別に形態と味の杯数が出て、形態の合計がラーメン総数と一致する", async ({
    page,
    playwright,
    baseURL,
  }) => {
    // 正解はAPIから取る（画面が数え間違えていないかを突き合わせる）
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
    });
    const json = await (await ctx.get("/api/ramen?view=list")).json();
    const ramen = (json.items ?? []).filter((i: { is_ramen: boolean }) => i.is_ramen);
    const styleTotal = ramen.length;
    const tasteKnown = ramen.filter((i: { taste: string | null }) => i.taste).length;
    await ctx.dispose();

    await page.goto("/ramen");
    await page.getByRole("tab", { name: "ジャンル別" }).click();
    const box = page.getByTestId("rank-types");
    await expect(box).toBeVisible();
    // 形態の棒には「つけ麺」が必ずある（実データに32杯）
    await expect(box.getByText("つけ麺", { exact: true })).toBeVisible();
    // 棒の数字を全部足すと、形態＝ラーメン総数、味＝判定できた杯数 になる
    const nums = (await box.locator("span.font-bold.text-gray-900").allTextContents()).map(Number);
    const sum = nums.reduce((a, b) => a + b, 0);
    expect(sum, "形態＋味の合計が実データと合いません").toBe(styleTotal + tasteKnown);
  });

  test("駅別・マイベストに切り替わる", async ({ page }) => {
    await page.goto("/ramen");
    await page.getByRole("tab", { name: "駅別" }).click();
    await expect(page.getByTestId("rank-stations")).toBeVisible();
    await expect(page.getByTestId("rank-stations").locator("span.font-bold.text-gray-900").first()).toBeVisible();

    await page.getByRole("tab", { name: "マイベスト" }).click();
    const best = page.getByTestId("rank-best");
    await expect(best).toBeVisible();
    // 1位は★付き
    await expect(best.locator("li").first().getByText(/★/)).toBeVisible();
  });

  test("百名店は訪問済みの数が出て、まだの店へ食べログのリンクがある", async ({ page }) => {
    await page.goto("/ramen");
    await page.getByRole("tab", { name: "百名店" }).click();
    const box = page.getByTestId("rank-hyaku");
    await expect(box.getByText(/訪問済み/)).toBeVisible({ timeout: 15_000 });
    const text = await box.getByText(/訪問済み/).textContent();
    const m = /訪問済み\s*(\d+)\s*\/\s*100/.exec(text ?? "");
    expect(m, "訪問済み n / 100 の形で出ていません").toBeTruthy();
    const done = Number(m![1]);
    // 2026-09-19 時点で9店。将来増えるので下限だけ見る
    expect(done).toBeGreaterThanOrEqual(9);
    expect(done).toBeLessThanOrEqual(100);

    // 既定は「まだの店だけ」。件数は 100 − 訪問済み
    const items = box.locator("li");
    await expect(items).toHaveCount(100 - done);
    const href = await items.first().locator("a").getAttribute("href");
    expect(href, "食べログの店ページへ飛べません").toMatch(/^https:\/\/tabelog\.com\/tokyo\//);

    // 「全部」に切り替えると100店
    await box.getByRole("button", { name: "まだの店だけ" }).click();
    await expect(items).toHaveCount(100);
  });

  test("百名店の口は合言葉が無いと通らない", async ({ playwright, baseURL }) => {
    const bare = await playwright.request.newContext({ baseURL });
    const res = await bare.get("/api/ramen/hyakumeiten");
    expect(res.status()).toBe(401);
    await bare.dispose();
  });
});
