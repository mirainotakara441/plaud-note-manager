import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// ホームの「今朝の示唆」カード（夜間参謀 Phase 1）が、実データで描画されるか。
//
// なぜ要るか:
//   このカードは insights テーブルが空・未作成のときは何も描かない作りになっている
//   （毎朝「示唆はありません」を出すと、カードごと読まれなくなるため）。
//   その"静かに消える"性質のせいで、壊れて出なくなっても気づけない。
//   本文と3ボタンが実際に出ることを固定しておく。
//
// 示唆が0件の環境（導入前・材料が薄い日）ではカードが出ないのが正しいので、
// その場合はスキップする。カード自体の有無をテストの失敗にしない。

test("ホームの「今朝の示唆」カードが、示唆があるときだけ本文と判断ボタンを出す", async ({
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

  // 先にAPIを見て、この環境に示唆があるかを判定する。
  const res = await page.request.get("/api/night-advisor");
  expect(res.ok()).toBeTruthy();
  const data = (await res.json()) as {
    available: boolean;
    insights: { title: string }[];
  };

  await page.goto("/");

  if (!data.available || data.insights.length === 0) {
    // 未導入・示唆なしの環境では、カードが出ていないことこそが正しい。
    await expect(page.locator("#night-insight-card")).toHaveCount(0);
    test.skip(true, "この環境には示唆が無いので、カードが出ないことだけ確かめた");
    return;
  }

  const card = page.locator("#night-insight-card");
  await expect(card).toBeVisible();

  // 事実ではなく仮説だと分かる表示になっていること。ここが崩れると、
  // 上の「今朝の気づき」（機械判定の事実）と同じ重みで読まれてしまう。
  await expect(card).toContainText("仮説");

  // 先頭の示唆の本文が出ていること（見出しだけのカードにしない）。
  await expect(card).toContainText(data.insights[0].title);

  // 判断の3ボタン。ここが押されないと翌晩の参謀が何も学べないので、
  // 表示されていること自体を固定する。
  await expect(card.getByRole("button", { name: "採用" })).toBeVisible();
  await expect(card.getByRole("button", { name: "見送り" })).toBeVisible();
  await expect(card.getByRole("button", { name: "的外れ" })).toBeVisible();
});
