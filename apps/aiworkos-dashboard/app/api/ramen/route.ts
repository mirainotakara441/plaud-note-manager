import { NextRequest, NextResponse } from "next/server";
import { serviceCreds } from "@/lib/supabase";
import { captureAuthorized, thumbPathsFor } from "@/lib/ramen";
import { bowlStyleOf, bowlTasteOf } from "@/lib/ramenBowlType.mjs";

// ラーメン（ライフOS側）：1行＝1杯（1訪問）の記録 ramen_logs を読む。
// 食べログ（mirainotakara）の口コミと X（@0kara1_man）の投稿を同じ行に束ねてあり、
// 「食べた → 食べログに書いた → Xに出した」までを1本の線で追える。
// 日報録・週報と同じく anonキーで Supabase PostgREST を server 側から叩く
// （RLSは anon にSELECTのみ許可。合言葉認証の内側なので anonキーはブラウザに出ない）。

export const dynamic = "force-dynamic";

const TABLE = "ramen_logs";

const COLUMNS = [
  "id",
  "eaten_on",
  "bowl_no",
  "bowl_label",
  "shop",
  "area",
  "genre",
  "visit_count",
  "menu",
  "price",
  "score",
  "score_time",
  "score_food",
  "score_service",
  "score_mood",
  "score_cp",
  "title",
  "excerpt",
  "photo_count",
  "tabelog_url",
  "tabelog_shop_url",
  "x_url",
  "x_posted_on",
  "x_excerpt",
  "is_ramen",
  "note",
  "stars",
  "stars_label",
  "status",
  "memo",
  "draft_tabelog",
  "draft_x",
  "photo_urls",
  "bowl_style",
  "bowl_taste",
].join(",");

// 一覧だけを描く画面（/ramen/all）向けの軽い列。
//
// 全列だと229件で213KB返る。その44%が excerpt・memo・draft_tabelog・draft_x
// といった下書き・本文系で、一覧は日付・杯番号・★・店名・写真しか使わない。
// 下書き全文まで毎回運ぶと、サムネイルが出始めるまでの待ちがその分延びる
// （2026-09-13 実測）。
const LIST_COLUMN_NAMES = [
  "id",
  "eaten_on",
  "bowl_no",
  "bowl_label",
  "shop",
  "area",
  "menu",
  "stars",
  "stars_label",
  "score",
  "photo_urls",
  "is_ramen",
  // /ramen 側が積み上げの集計（X投稿率）・未処理の抽出・よく行く店の
  // リンクに使う。いずれも短い列
  "status",
  "x_url",
  "tabelog_shop_url",
];


// view=list で「種別」を付けるためにサーバー側だけで読む列。
// 判定（lib/ramenBowlType.mjs）は menu・title・memo・excerpt・genre と手入力の2列を見る。
// 本文は返す前に落とすので、端末へ行く量は増えない。
const CLASSIFY_ONLY_COLUMNS = [
  "menu",
  "title",
  "memo",
  "excerpt",
  "genre",
  "bowl_style",
  "bowl_taste",
];

// view=taste 用。味・系統が決まっていないラーメンを、本人が1杯ずつ選ぶための列。
// 写真・店名・メニュー・題名・本文の一部を見て思い出せるだけあればよい。
const TASTE_QUEUE_COLUMNS = [
  "id",
  "eaten_on",
  "bowl_no",
  "shop",
  "area",
  "genre",
  "menu",
  "title",
  "excerpt",
  "memo",
  "photo_urls",
  "is_ramen",
  "bowl_style",
  "bowl_taste",
].join(",");

// view=text 用。ある月のカードを描くのに要る行だけを、全列で取り直すときに使う。
// 月の指定は "YYYY-MM" だけを許す（そのままクエリへ入るため、形を絞る）。
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** その月の翌月1日。PostgREST へ gte / lt で渡すため。 */
function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function creds() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

export async function GET(req: NextRequest) {
  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const view = sp.get("view");

  // view=list は一覧用の軽い列だけ。view=taste は味を選ぶ画面用。指定が無ければ全列。
  const columns =
    view === "list"
      ? [...LIST_COLUMN_NAMES, ...CLASSIFY_ONLY_COLUMNS.filter((c) => !LIST_COLUMN_NAMES.includes(c))].join(",")
      : view === "taste"
        ? TASTE_QUEUE_COLUMNS
        : COLUMNS;

  // view=text は「いま画面に出す行」だけを全列で取る。
  //
  // /ramen は下書き・メモ・本文を出すが、実際に描くのは未処理と選んだ月だけ。
  // それでも全230件ぶんの本文を運んでいて、混み合うと落ちていた
  // （画像100枚と並行で叩くと10秒超・タイムアウト・500。2026-09-13 実測）。
  // 集計と月の一覧は view=list が担い、こちらは描く行だけに絞る。
  const month = sp.get("month") ?? "";
  let filter = "";
  if (view === "taste") {
    // 味を選ぶのはラーメンだけ（うどん・カレーに味の系統は付けない）
    filter = "&is_ramen=eq.true";
  }
  if (view === "text") {
    if (!MONTH_RE.test(month)) {
      return NextResponse.json({ error: "monthの形式が不正です" }, { status: 400 });
    }
    // 未処理（下書きまち・投稿まち）は月に関係なく常に要る。画面の最上段に出るため
    filter =
      `&or=(status.neq.posted,status.is.null,` +
      `and(eaten_on.gte.${month}-01,eaten_on.lt.${nextMonthStart(month)}))`;
  }

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=${columns}${filter}` +
      `&order=eaten_on.desc,bowl_no.desc,id.desc`,
    {
      headers: {
        apikey: c.anon,
        Authorization: `Bearer ${c.anon}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }

  const raw: Record<string, unknown>[] = await res.json();

  // 種別（形態・味）を付けて返す。手入力があればそれ、無ければ本文から判定。
  // 判定は1か所（lib/ramenBowlType.mjs）に寄せ、画面では数えるだけにする。
  const items = raw.flatMap((row) => {
    const withType = {
      ...row,
      style: bowlStyleOf(row),
      taste: bowlTasteOf(row),
    };
    // view=taste は味が決まっていない杯だけ。手で付けた杯は消える＝進む
    if (view === "taste") return withType.taste ? [] : [withType];
    if (view !== "list") return [withType];
    // 一覧には判定用に読んだ本文を渡さない（一覧の列に無いものを落とす）
    for (const col of CLASSIFY_ONLY_COLUMNS) {
      if (!LIST_COLUMN_NAMES.includes(col)) delete (withType as Record<string, unknown>)[col];
    }
    return [withType];
  });
  return NextResponse.json({ items });
}

// 1杯を削除する。
//
// 記録を始めたが写真の保存や下書き生成の途中で止まり、中身が半端なまま
// 残る行が出る（実際に id=224 / 230 がそうなった）。消せないと一覧の先頭に
// 居座り、通算杯数の勘定も狂って見える。
//
// Xへ投稿済みのものは既定では消さない。投稿だけ残って記録が消えると、
// 「Xに出したのに手元に無い」という一番たちの悪いズレになるため、
// 消すなら force を明示させる。写真はStorageからも消す（本文だけ消えて
// 生写真が残り続けるのは、消したつもりとして一番危ない）。
export async function DELETE(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const svc = serviceCreds();
  const c = creds();
  if (!svc || !c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const id = parseInt(sp.get("id") ?? "", 10);
  const force = sp.get("force") === "true";
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const getRes = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id,shop,x_url,photo_urls&id=eq.${id}`,
    { headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}` }, cache: "no-store" }
  );
  if (!getRes.ok) return NextResponse.json({ error: "対象の取得に失敗" }, { status: 502 });
  const row = (await getRes.json())[0];
  if (!row) return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });

  if (row.x_url && !force) {
    return NextResponse.json(
      { error: "この一杯はXへ投稿済みです。消すとXの投稿だけが残ります。", x_url: row.x_url },
      { status: 409 }
    );
  }

  // 写真を先に消す。行を先に消すとパスが分からなくなり、生写真が孤児として残る。
  const paths: string[] = Array.isArray(row.photo_urls) ? row.photo_urls : [];
  if (paths.length > 0) {
    try {
      // 縮小した作り置きも一緒に消す。原本だけ消すと、誰も辿れない絵が残り続ける。
      const all = [...paths, ...paths.flatMap((p) => thumbPathsFor(p))];
      await fetch(`${svc.url}/storage/v1/object/ramen-photos`, {
        method: "DELETE",
        headers: {
          apikey: svc.key,
          Authorization: `Bearer ${svc.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: all }),
      });
    } catch (err) {
      // 写真が消せなくても行は消す。ここで止めると半端な行が消せなくなる
      console.error("DELETE /api/ramen: 写真の削除に失敗", err);
    }
  }

  const del = await fetch(`${svc.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "DELETE",
    headers: {
      apikey: svc.key,
      Authorization: `Bearer ${svc.key}`,
      Prefer: "return=representation",
    },
  });
  if (!del.ok) {
    const detail = await del.text().catch(() => "");
    return NextResponse.json({ error: `削除失敗 ${del.status}`, detail: detail.slice(0, 200) },
      { status: 502 });
  }
  const removed = await del.json();
  if (!Array.isArray(removed) || removed.length === 0) {
    return NextResponse.json({ error: "削除できませんでした" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: id, photos: paths.length });
}
