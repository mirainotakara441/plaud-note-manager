import { test } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// 写真のプロキシが、原寸と縮小版で何を返しているかを実測する。
// 「200で返っている」だけでなく「縮小版がちゃんと軽い」ところまで見る。
test("写真の口が何を返すか", async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
  });
  const list = await ctx.get("/api/ramen");
  const json = await list.json();
  const withPhoto = (json.items ?? []).filter(
    (i: { photo_urls?: string[] }) => (i.photo_urls ?? []).length > 0
  );
  console.log("写真つきの杯:", withPhoto.length);
  for (const row of withPhoto.slice(0, 3)) {
    const p = row.photo_urls[0];
    const sizes: string[] = [];
    for (const w of ["", "&w=480", "&w=1280"]) {
      const res = await ctx.get(`/api/ramen/photo?path=${encodeURIComponent(p)}${w}`);
      const label = w === "" ? "原寸" : w.replace("&w=", "幅");
      sizes.push(
        res.headers()["content-type"]?.startsWith("image")
          ? `${label} ${res.status()} ${Math.round((await res.body()).length / 1024)}KB`
          : `${label} ${res.status()} ${(await res.text()).slice(0, 80)}`
      );
    }
    console.log(`id=${row.id} ${row.shop}  ${sizes.join(" / ")}`);
  }
  await ctx.dispose();
});
