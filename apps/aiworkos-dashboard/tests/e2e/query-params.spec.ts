import { test, expect, type PlaywrightWorkerArgs } from "@playwright/test";
import { authedRequest, expectHealthyPage, prepareContext, watch } from "./checks";

/** Playwrightが渡してくる playwright フィクスチャの型。 */
type PlaywrightFixture = PlaywrightWorkerArgs["playwright"];

// クエリパラメータ付きの導線を見るE2E。
//
// ■ なぜこの2本を選んだか
// 過去の障害はどちらも「素のURLでは起きず、パラメータ付きでだけ落ちる」形だった。
//   ・/weapons  … /api/organizations が {name,count} の配列を返すのに文字列として
//                 描画してクラッシュ（curlだけで検証して本番に出した）
//   ・/weapons?actions=… … useEffect の依存に searchParams オブジェクトを入れていたため
//                 setCandidates → 再レンダー → 再実行の無限ループになり、
//                 モバイルのWebViewが「This page couldn't load」で落ちた
//                 （app/weapons/page.tsx のコメントに経緯が残っている）
// AGENTS.md にも「パラメータ付きの導線はパラメータ付きのURLで開くこと」とある。
// ここはその指示を機械にやらせる場所。
//
// ■ 使う値
//   org     … /api/organizations?include=weekly（GET）から実データを1件取る。
//             団体名をハードコードすると、その団体を消したときにテストが嘘になる。
//   actions … 実データを読める口が無い（/api/agent は POST のみで GET が無く、
//             このE2Eは書き込みを出さない方針）。そのため合成した文字列を渡す。
//             ここで見たいのは「JSON配列のパラメータを渡しても壊れず、画面に出るか」
//             であって打ち手の中身ではないので、合成値で目的を満たせる。
//
// 読み取りのみ。POST/PUT/PATCH/DELETE は checks.ts の prepareContext が塞いでいる。

/** /weapons へ渡す打ち手。実データではなく、テストだと分かる合成値。 */
const TEST_ACTIONS = ["導入効果を数字で示す", "課長への接触ルートを確保する"];

test.beforeEach(async ({ context, baseURL }) => {
  await prepareContext(context, baseURL);
});

/** 実データから団体名を1つ取る（GETのみ）。取れなければテストを飛ばす。 */
async function pickOrganization(
  playwright: PlaywrightFixture,
  baseURL: string | undefined
): Promise<string> {
  const api = await authedRequest(playwright, baseURL);
  const res = await api.get("/api/organizations?include=weekly");
  expect(res.status(), "/api/organizations が取得できませんでした").toBe(200);
  const body = (await res.json()) as { organizations?: { name?: string }[] };
  await api.dispose();

  const name = body.organizations?.find((o) => typeof o.name === "string" && o.name.trim())?.name;
  // 団体が1件も無い環境ではこのテストは成立しない。黙って通すより飛ばす。
  test.skip(!name, "団体データが無いため、この導線は検証できません");
  return name!.trim();
}

test("/agent?org=… が壊れずに開き、団体が選ばれた状態になる", async ({ page, playwright, baseURL }) => {
  const org = await pickOrganization(playwright, baseURL);
  const label = `/agent?org=${org}`;

  const found = watch(page);
  const res = await page.goto(`/agent?org=${encodeURIComponent(org)}`, {
    waitUntil: "domcontentloaded",
  });
  await expectHealthyPage(page, found, label, res);

  // ★パラメータが画面に反映されていること。
  //   /agent はマウント時に location から org を読んで団体セレクタに入れる。
  //   ここが効かないと「提案 →」から来ても毎回選び直しになる。
  const selectedValues = await page
    .locator("select")
    .evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value));
  expect(
    selectedValues,
    `${label}: org がどのセレクタにも反映されていません（実際の値: ${JSON.stringify(selectedValues)}）`
  ).toContain(org);
});

test("/weapons?org=…&actions=… が壊れずに開き、打ち手が候補に出る", async ({
  page,
  playwright,
  baseURL,
}) => {
  const org = await pickOrganization(playwright, baseURL);
  const actionsParam = JSON.stringify(TEST_ACTIONS);
  const label = "/weapons?org=…&actions=…";

  const found = watch(page);
  const res = await page.goto(
    `/weapons?org=${encodeURIComponent(org)}&actions=${encodeURIComponent(actionsParam)}`,
    { waitUntil: "domcontentloaded" }
  );
  const body = await expectHealthyPage(page, found, label, res);

  // ★パラメータが画面に反映されていること（2つとも）。
  //   actions は JSON配列を渡す形。ここが壊れると /agent からの引き継ぎが切れる。
  for (const action of TEST_ACTIONS) {
    expect(body, `${label}: 打ち手「${action}」が画面に出ていません`).toContain(action);
  }

  // org 側も入っていること。セレクタか入力欄のどちらかに入る作りなので両方見る。
  const values = await page
    .locator("select, input")
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLSelectElement | HTMLInputElement).value).filter(Boolean)
    );
  expect(
    values,
    `${label}: org が画面に反映されていません（実際の値: ${JSON.stringify(values)}）`
  ).toContain(org);
});

// 無限ループの再発を捕まえるための番人。
//
// 過去の不具合は「落ちる」のではなく「再レンダーが止まらない」形だった。
// pageerror にも console.error にも出ないことがあるため、
// パラメータ付きで開いたあと画面が静かになるかどうかを別に見る。
test("/weapons?actions=… が再レンダーの無限ループに陥らない", async ({
  page,
  playwright,
  baseURL,
}) => {
  const org = await pickOrganization(playwright, baseURL);
  const actionsParam = JSON.stringify(TEST_ACTIONS);

  await page.goto(
    `/weapons?org=${encodeURIComponent(org)}&actions=${encodeURIComponent(actionsParam)}`,
    { waitUntil: "domcontentloaded" }
  );
  await expect(page.locator("main")).toBeVisible();

  // 落ち着いたはずの時点から一定時間、DOMが書き換わり続けていないかを数える。
  await page.waitForTimeout(1500);
  const mutations = await page.evaluate(async () => {
    let count = 0;
    const ob = new MutationObserver((records) => {
      count += records.length;
    });
    ob.observe(document.body, { childList: true, subtree: true, attributes: true });
    await new Promise((r) => setTimeout(r, 2000));
    ob.disconnect();
    return count;
  });

  // 通常は0〜数十。ループしていると桁違いに増える。
  expect(
    mutations,
    `/weapons が静止しません（2秒間のDOM変化 ${mutations} 件）。再レンダーのループを疑ってください`
  ).toBeLessThan(500);
});
