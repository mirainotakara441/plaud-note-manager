import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// /ask（相談窓口）が壊れずに開けるか。
//
// AI生成そのもの（POST）はここでは叩かない——1回1分超・実コストがかかり、
// テストのたびに走らせる種類のものではない。ここで固定するのは
// 「ページが開く・入力欄と送信ボタンがある・過去ログのGETが落ちない」まで。
// 生成の質は ask_log の rating（役に立った/ずれてる）で運用側が測る。

test("/ask（相談窓口）が壊れずに開き、入力欄と送信ボタンが出る", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([
    {
      name: COOKIE_NAME,
      value: authCookieValue(),
      url: baseURL ?? "http://localhost:3020",
    },
  ]);

  // 過去ログのGETが落ちていないこと（テーブル未作成でも200で空を返す規約）。
  const res = await page.request.get("/api/ask");
  expect(res.ok()).toBeTruthy();

  await page.goto("/ask");
  await expect(page.getByRole("heading", { name: /相談窓口/ })).toBeVisible();
  await expect(page.getByPlaceholder(/堺市/)).toBeVisible();
  const submit = page.getByRole("button", { name: "相談する" });
  await expect(submit).toBeVisible();
  // 空のまま押せない（誤タップで1分の生成が走らない）ことも固定する。
  await expect(submit).toBeDisabled();
});
