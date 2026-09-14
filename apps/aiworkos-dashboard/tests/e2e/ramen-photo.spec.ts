import { test, expect } from "@playwright/test";
import { COOKIE_NAME, authCookieValue } from "./auth";

// /ramen に移した写真が、本当に画面へ出ているかを確かめる。
//
// 写真は非公開バケットにあり、公開URLを持たない。表示は /api/ramen/photo という
// プロキシ越しなので、「img タグが並んでいる」だけでは足りない。実際に画像として
// 読み込めたか（naturalWidth > 0）まで見る。ここを見ないと、401や404の代わりに
// 割れた画像アイコンが並ぶ状態を「出ている」と誤認する。

test.describe("ラーメンの写真", () => {
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

  test("サムネイルが実際に読み込まれている", async ({ page }) => {
    await page.goto("/ramen");
    expect(new URL(page.url()).pathname).not.toBe("/login");

    const thumbs = page.locator('img[src*="/api/ramen/photo"]');
    await expect(thumbs.first()).toBeVisible({ timeout: 30_000 });

    const count = await thumbs.count();
    expect(count, "写真のサムネイルが1枚も出ていません").toBeGreaterThan(0);

    // 割れた画像ではなく本当に描画できているか。1枚あたり数百KBあるので、
    // 読み込み終わるのを待つ（待たずに naturalWidth を見ると、まだ0で誤検知する）。
    await page.waitForFunction(
      () => {
        const el = document.querySelector<HTMLImageElement>(
          'img[src*="/api/ramen/photo"]'
        );
        return !!el && el.complete && el.naturalWidth > 0;
      },
      undefined,
      { timeout: 30_000 }
    );

    const first = await thumbs.first().evaluate((el) => ({
      w: (el as HTMLImageElement).naturalWidth,
      src: (el as HTMLImageElement).getAttribute("src") ?? "",
    }));
    expect(first.w, "1枚目が読み込めていません").toBeGreaterThan(0);
    // 一覧は縮小版を使う（原寸をそのまま並べると1か月ぶんで10MBを超える）
    expect(first.src, "一覧のサムネイルが原寸のままです").toContain("w=");
  });

  test("自分の★と食べログの点数が別々に出ている", async ({ page }) => {
    await page.goto("/ramen");
    // 自分の★は記号のまま出す（★★★☆ のような表示）
    await expect(page.locator("text=/★★/").first()).toBeVisible({ timeout: 30_000 });
    // 食べログの点数は「食べログ3.5」の形で、★とは別のバッジに出る
    await expect(page.locator("text=/食べログ\\d\\.\\d/").first()).toBeVisible();
  });

  // /ramen も既定はラーメンだけ（2026-09-13に本人が指定）。
  // うどん・カレー・カフェが混ざると積み上げの杯数が読めなくなる。
  // 月別の一覧は「その月に投稿済みのもの」しか出ないため件数は月次第。
  // データに依らず確かめられる「どの絞り込みが選ばれて開くか」を見る。
  test("既定の絞り込みがラーメンのみになっている", async ({ page }) => {
    await page.goto("/ramen");
    const ramenBtn = page.getByRole("button", { name: "ラーメンのみ" });
    await expect(ramenBtn).toBeVisible({ timeout: 30_000 });
    // 選ばれているボタンだけが塗りつぶし（bg-indigo-600）になる
    await expect(ramenBtn, "開いた直後がラーメンのみになっていません").toHaveClass(
      /bg-indigo-600/
    );
    await expect(
      page.getByRole("button", { name: "すべて" }),
      "「すべて」が既定になっています"
    ).not.toHaveClass(/bg-indigo-600/);
  });

  // /ramen の取得は2段構え（軽い一覧 → 描く行だけ全列）。2段目が落ちると
  // 積み上げや店名は出たまま、下書き・メモだけが黙って消える。
  // 「一覧は出ているので気づかない」が一番たちが悪いので、本文まで見る。
  test("下書きの本文まで読み込めている", async ({ page }) => {
    await page.goto("/ramen");
    // 未処理（下書きまち・投稿まち）は最上段に出る
    await expect(page.getByText("食べログ用").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "本文をコピー" }).first()).toBeVisible();
    // 2段目が落ちたときの注意書きが出ていないこと
    await expect(page.getByText("下書き・メモを読み込めませんでした")).toHaveCount(0);
  });

  // 3.75 のように記号で書けない★を、丸めずにそのまま出せているか。
  // stars は numeric(2,1) だったので Postgres が黙って 3.8 にしていた（2026-09-12に修正）。
  test("記号で書けない★も丸めずに出る", async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
    });
    const res = await ctx.get("/api/ramen");
    const json = await res.json();
    const row = (json.items ?? []).find(
      (i: { id: number }) => i.id === 139
    );
    expect(row, "id=139 の一杯が取れませんでした").toBeTruthy();
    expect(Number(row.stars), "★が丸められています").toBe(3.75);
    expect(row.stars_label, "記号で書けない値に記号が付いています").toBeNull();
    await ctx.dispose();
  });

  // iPhoneの写真は「横倒しの画素＋EXIFの向き情報」で入っていることが多く、
  // 移行した162枚のうち114枚がそれだった。縮小するときに向きを焼き込まないと、
  // 向き情報だけ落ちて一覧にラーメンが横向きで並ぶ（2026-09-13に実際に発生）。
  test("縮小した写真が横倒しにならない", async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
    });
    // 横倒しで保存されている実例（EXIF orientation=6 の写真）
    const path = "217/19024679966159-lrjrqo.jpg";
    const res = await ctx.get(
      `/api/ramen/photo?path=${encodeURIComponent(path)}&w=480`
    );
    expect(res.status()).toBe(200);

    // JPEGのSOF0/SOF2マーカーから縦横を読む（画像ライブラリ無しで確かめる）
    const buf = await res.body();
    let w = 0;
    let h = 0;
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        h = buf.readUInt16BE(i + 5);
        w = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    expect(w, "縮小した画像の大きさが読めませんでした").toBeGreaterThan(0);
    expect(h, `${w}x${h} で返っています。横倒しのままです`).toBeGreaterThan(w);
    await ctx.dispose();
  });

  // 縮小はその場でやると本番で1枚0.7〜1.3秒かかる（実測）。200件の一覧では
  // スクロールのたびにこれが効いて重いので、作り置きを置いて2度目以降は
  // ただ取り出すだけにしてある。その作り置きが本当に効いているかを見る。
  test("縮小した写真は2度目が速い", async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${COOKIE_NAME}=${authCookieValue()}` },
    });
    const list = await ctx.get("/api/ramen");
    const json = await list.json();
    const row = (json.items ?? []).find(
      (i: { photo_urls?: string[] }) => (i.photo_urls ?? []).length > 0
    );
    expect(row, "写真つきの一杯がありません").toBeTruthy();
    const url = `/api/ramen/photo?path=${encodeURIComponent(row.photo_urls[0])}&w=480`;

    // 1度目で作り置きができる（既にあればそのまま）
    expect((await ctx.get(url)).status()).toBe(200);

    const t0 = Date.now();
    const again = await ctx.get(url);
    const ms = Date.now() - t0;
    expect(again.status()).toBe(200);
    // その場で変換していれば軽く1秒を超える。作り置きが効いていれば桁が違う
    expect(ms, `2度目に ${ms}ms かかっています。作り置きが効いていません`).toBeLessThan(1500);
    await ctx.dispose();
  });

  test("写真の配信は合言葉が無いと通らない", async ({ playwright, baseURL }) => {
    const bare = await playwright.request.newContext({ baseURL });
    const res = await bare.get("/api/ramen/photo?path=187%2Fnope.jpg");
    expect(res.status(), "合言葉なしで写真の口が開いています").toBe(401);
    await bare.dispose();
  });
});
