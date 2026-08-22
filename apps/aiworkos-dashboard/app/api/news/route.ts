import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// DXニュース。fetch-*-news が毎朝 Google ニュースのRSSから dx_news へ溜めているものを読む。
//
// 1,600件超を集めながら見る画面が無く、誰も読んでいなかった。集めただけのものは
// 資産ではないので、毎日開ける形にする。
//
// 読み取り専用。service role を使うのは dx_news に anon の SELECT ポリシーが無いため。

export const dynamic = "force-dynamic";

type Row = {
  id: number;
  theme: string;
  title: string;
  link: string;
  source: string | null;
  pub_date: string | null;
};

export type NewsItem = {
  id: number;
  theme: string;
  category: string;
  /** 中カテゴリー。大カテゴリーの下の束ね（例: 生成AI → Claude関係）。 */
  subcategory: string;
  title: string;
  link: string;
  source: string | null;
  pub_date: string | null;
};

/**
 * 見出しの掃除。Googleニュースの見出しは以下の癖があり、そのまま並べると読みにくい。
 *   ・末尾に「 - 媒体名」が付く（source列と同じ内容の重複）
 *   ・同じ記事が「（画像）（1/3枚目）」「（2/3枚目）」で複数行に増える
 * 表示用の見出しを作ると同時に、重複判定のキーにも使う。
 */
function cleanTitle(raw: string, source: string | null): string {
  let t = raw.trim();

  // ① 末尾の「 - 媒体名」を先に落とす。
  //
  // 順序が肝。ギャラリー表記より媒体名が後ろに来る（「…（2/2枚目） - ITmedia」）ため、
  // 先にギャラリー側を末尾固定で削ろうとしても永久に届かない。実際それで26件が
  // 掃除されず、同じ記事が枚数ぶん並んだままになっていた。
  //
  // source と一致する時だけ削るので、見出し本文のハイフンを誤って切らない。
  // 大文字小文字を無視して繰り返すのは、Googleニュースが
  // 「… - CHOSUNBIZ - Chosunbiz」と表記違いで二重に付けてくることがあるため。
  if (source) {
    const needle = source.trim().toLowerCase();
    for (let i = 0; i < 3; i++) {
      const lower = t.toLowerCase();
      const sep = lower.lastIndexOf(" - ");
      if (sep === -1) break;
      if (lower.slice(sep + 3).trim() !== needle) break;
      t = t.slice(0, sep).trim();
    }
  }

  // ② source と綴りが違う媒体名が残ることがある（source が Yahoo!ニュースなのに
  // 見出しの末尾は「 - エキスパート」など）。末尾の短い断片だけを媒体名とみなして削る。
  // 20字を上限にし、読点・句点を含むものは残す——「… - 正職員全体の約7割が参加、…」の
  // ような副題まで削ると、見出しから意味が落ちてしまう。
  const tail = /\s+-\s+([^-]{1,20})$/u.exec(t);
  if (tail && !/[、。]/u.test(tail[1]) && t.length - tail[0].length >= 10) {
    t = t.slice(0, t.length - tail[0].length).trim();
  }

  // ③ 画像ギャラリーの連番。同じ記事が枚数ぶん行を増やすので、ここを削って
  // 初めて重複としてまとめられる。媒体ごとに表記が違うので4通りを見る。
  t = t.replace(/^写真・図版[（(][^）)]*[）)]\s*[|｜]\s*/u, "").trim();
  t = t.replace(/(?:[（(][^）)]{0,12}(?:枚目|画像)[）)]\s*)+$/gu, "").trim();
  t = t.replace(/\s*\d+枚目の写真(?:・画像)?\s*$/u, "").trim();
  t = t.replace(/[（(]\d+\s*\/\s*\d+\s*(?:ページ)?[）)]\s*$/u, "").trim();

  // ④ 末尾の「 (アスキー)」型の媒体名。同じ記事が付き/なしの2行になるため、
  // これを落として初めて重複としてまとまる。20字以内・読点句点なしに限る
  // （意味のある括弧書きの副題を削らないため）。
  t = t.replace(/\s+[（(]([^）)]{1,20})[）)]\s*$/u, (m, inner: string) =>
    /[、。]/u.test(inner) ? m : ""
  ).trim();

  return t || raw.trim();
}

/** 重複判定のキー。記号と空白の揺れを吸収する。 */
function dedupeKey(title: string): string {
  return title.replace(/[\s"'「」『』（）()【】\-–—:：]/gu, "").toLowerCase();
}

export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 30), 1), 90);

  try {
    // テーマ→カテゴリーの対応。active なテーマだけを対象にする
    // （停止したテーマの古い記事が混ざると、いま追っている話題が埋もれる）。
    const themeRes = await fetch(
      `${c.url}/rest/v1/news_themes?select=theme,category,subcategory,active&active=eq.true`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!themeRes.ok) {
      return NextResponse.json({ error: `テーマ取得失敗 ${themeRes.status}` }, { status: 502 });
    }
    const themes: { theme: string; category: string | null; subcategory: string | null }[] =
      await themeRes.json();
    const categoryOf = new Map(themes.map((t) => [t.theme, t.category ?? "その他"]));
    // 中カテゴリー。未設定のテーマは大カテゴリー名をそのまま中にも入れて、
    // 2段目の絞り込みで行方不明にならないようにする。
    const subcategoryOf = new Map(
      themes.map((t) => [t.theme, t.subcategory ?? t.category ?? "その他"])
    );

    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const res = await fetch(
      `${c.url}/rest/v1/dx_news?select=id,theme,title,link,source,pub_date` +
        `&pub_date=gte.${encodeURIComponent(since)}` +
        // 30日ぶんが収まる余裕を持たせる。ここで溢れると古い側から静かに欠け、
        // 記事が少ないテーマ（法人OSなど）が「0件」に見えてしまう。
        `&order=pub_date.desc&limit=1500`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
    }
    const rows: Row[] = await res.json();

    // 新しい順に見て、同じ見出しの2件目以降を落とす。
    // Googleニュースは同じ記事を媒体違い・画像違いで何度も返してくる。
    const seen = new Set<string>();
    const items: NewsItem[] = [];
    for (const r of rows) {
      if (!categoryOf.has(r.theme)) continue; // 停止テーマ
      const title = cleanTitle(r.title, r.source);
      const key = dedupeKey(title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: r.id,
        theme: r.theme,
        category: categoryOf.get(r.theme) ?? "その他",
        subcategory: subcategoryOf.get(r.theme) ?? "その他",
        title,
        link: r.link,
        source: r.source,
        pub_date: r.pub_date,
      });
    }

    // 画面のタブに出す並び。件数の多い順（実際に読むものから目に入るように）。
    // 件数0のカテゴリーも末尾に残す（「今日は無い」と「そもそも追っていない」を
    // 区別できるように）。
    const countByCategory = new Map<string, number>();
    for (const it of items) {
      countByCategory.set(it.category, (countByCategory.get(it.category) ?? 0) + 1);
    }
    const categories = Array.from(new Set(themes.map((t) => t.category ?? "その他"))).sort(
      (a, b) => {
        const d = (countByCategory.get(b) ?? 0) - (countByCategory.get(a) ?? 0);
        return d !== 0 ? d : a.localeCompare(b, "ja");
      }
    );

    return NextResponse.json({
      items,
      categories,
      themes: themes.map((t) => ({
        theme: t.theme,
        category: t.category ?? "その他",
        subcategory: t.subcategory ?? t.category ?? "その他",
      })),
      days,
      /** 重複を落とす前の件数。取り込み側が壊れていないかの目安として画面に出す。 */
      rawCount: rows.length,
    });
  } catch (err) {
    console.error("GET /api/news: 取得エラー", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 502 });
  }
}
