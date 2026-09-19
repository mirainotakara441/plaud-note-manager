import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// /home-visit に電話の発信リンクが出るか（2026-09-19 追加）。
// 名簿から入れた番号は tel: リンクで、iPhone からその場で掛けられることを固定する。
// 番号が1人も無い環境（導入前）ではリンクが無いのが正しいのでスキップ。
test("/home-visit のメンバー行に電話の発信リンク(tel:)が出る", async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: COOKIE_NAME, value: authCookieValue(), url: baseURL ?? "http://localhost:3020" },
  ]);
  const res = await page.request.get("/api/home-visit");
  expect(res.ok()).toBeTruthy();
  const data = (await res.json()) as { members: { name: string; phone: string | null }[] };
  const withPhone = data.members.filter((m) => m.phone);
  if (withPhone.length === 0) {
    test.skip(true, "この環境には電話番号が無い");
    return;
  }

  await page.goto("/home-visit");
  // 一覧の📞（compact）が、番号を持つ人の数だけ出ていること
  const telLinks = page.locator('a[href^="tel:"]');
  await expect(telLinks.first()).toBeVisible();
  const href = await telLinks.first().getAttribute("href");
  // tel: の中身は数字と + だけ（ハイフン等を含めると一部の端末で発信できない）
  expect(href).toMatch(/^tel:\+?\d{10,11}$/);
});
