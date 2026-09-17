import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ニュース収集（Google News RSS × テーマ数）。pg_cron が毎朝8:00 JSTに叩く。
//
// ■ v4 で何を直したか（2026-09-17）
//   9/15〜17 の3日間、毎朝 HTTP 546（Edge Runtime の実行上限150秒で強制終了）で
//   1件も入らなかった。9/14 までは31テーマを25秒で完走していたので、関数側でなく
//   Google News → Edge の通信が詰まり始めた（9/13 の「200 だが0件」が前兆）。
//   旧実装は「タイムアウト無し・直列・途中経過を捨てる」だったため、外部が1本
//   詰まるだけで全滅する構造だった。外部の機嫌に左右されない形へ:
//     1. 1本ごとに 12秒 のタイムアウト（AbortSignal.timeout）
//     2. 5本ずつ並列（31テーマなら7巡。Google成功なら 7×12=84秒 以内。
//        Google 503→Bing の二段だと最悪 7×24=168秒 になりうるので 3. の締切で守る）
//     3. 全体の締切 110秒。それを過ぎたら残りを「未着手」として返し、546 を踏まない
//     4. テーマごとに console.log（今回は起動→shutdown 以外のログが無く、
//        どこで死んだか見えなかった。次からは見える）
//     5. UA をボット丸出しの "NewsFetcher/1.0" から一般的なブラウザ表記へ
//   upsert はテーマ単位で即時なので、途中まででも入ったぶんは残る。
//
// ■ v4 で見えた真因と、二段構えにした理由（2026-09-17 同日）
//   v4 で初めてテーマごとのログが出て、**31テーマ全部が Google News から 503**
//   （各5〜10秒）だと分かった。同じ URL・同じ UA でも吉井さんの Mac からは 200 なので、
//   Google が Supabase のデータセンターIPを弾いている。コードでは直せない種類の遮断。
//   そこで供給元を Google 一本足にせず、Google が失敗したテーマは Bing News RSS で
//   取り直す（Mac からの実測: 200・0.3秒・12件/テーマ）。Bing のリンクは
//   apiclick.aspx のリダイレクト包みなので、url= から記事の実URLを取り出して入れる
//   （そうしないと同じ記事が Google 経由と別 link になり、重複排除が効かない）。
//   どちらから取れたかは results[theme].provider に残す。
//
// ■ 変えていないもの
//   RSS の解析・dx_news への upsert（onConflict: link）・verify_jwt=false・
//   news_themes(active) を読む点。応答の形（ok / themeCount / results）も維持し、
//   results の各要素に ms と skipped を足しただけ。

const PER_FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 5;
const OVERALL_DEADLINE_MS = 110_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

function decodeEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripCdata(str: string): string {
  const m = str.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : str;
}

function extractTag(itemXml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = itemXml.match(re);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1].trim()));
}

function extractSourceName(itemXml: string): string | null {
  const m = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1].trim()));
}

interface NewsItem {
  title: string;
  link: string;
  source: string | null;
  pub_date: string | null;
}

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    const rawTitle = extractTag(itemXml, "title") || "";
    const link = extractTag(itemXml, "link") || "";
    const pubDateRaw = extractTag(itemXml, "pubDate");
    let source = extractSourceName(itemXml);

    let title = rawTitle;
    if (!source && rawTitle.includes(" - ")) {
      const idx = rawTitle.lastIndexOf(" - ");
      title = rawTitle.slice(0, idx);
      source = rawTitle.slice(idx + 3);
    }

    let pubDateIso: string | null = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw);
      if (!isNaN(d.getTime())) pubDateIso = d.toISOString();
    }

    if (link) {
      items.push({ title: title.trim(), link: link.trim(), source, pub_date: pubDateIso });
    }
  }
  return items;
}

async function fetchRss(url: string, label: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(PER_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  return res.text();
}

async function fetchFromGoogle(theme: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(theme)}&hl=ja&gl=JP&ceid=JP:ja`;
  return parseRss(await fetchRss(url, "google"));
}

// Bing News RSS。<link> は bing.com/news/apiclick.aspx?...&url=<実URL> の包みなので剥がす。
// 配信元は <News:Source>。title に " - 配信元" は付かないので parseRss の分割は効かない。
async function fetchFromBing(theme: string): Promise<NewsItem[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(theme)}&format=rss&setlang=ja&cc=JP`;
  const xml = await fetchRss(url, "bing");
  const items = parseRss(xml);
  const itemXmls = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  return items.map((it, i) => {
    let link = it.link;
    try {
      const u = new URL(link);
      const real = u.searchParams.get("url");
      if (real) link = real;
    } catch { /* 包みでなければそのまま */ }
    const src = itemXmls[i] ? extractTag(itemXmls[i], "News:Source") : null;
    return { ...it, link, source: it.source ?? src };
  });
}

// Google が続けて落ちたら、以降のテーマは Google を飛ばして Bing 直行にする（遮断器）。
// 遮断された日は Google の 503 待ち（各5〜10秒）が31回積み上がり、
// それだけで締切に届いてしまうため。1巡ぶん（CONCURRENCY）連続で落ちたら開く。
let googleConsecutiveFailures = 0;
const GOOGLE_BREAKER_THRESHOLD = CONCURRENCY;

// Google → 失敗なら Bing。どちらで取れたかを返す。
async function fetchThemeNews(theme: string): Promise<{ items: NewsItem[]; provider: string }> {
  let gErr: unknown = "skipped(breaker open)";
  if (googleConsecutiveFailures < GOOGLE_BREAKER_THRESHOLD) {
    try {
      const items = await fetchFromGoogle(theme);
      googleConsecutiveFailures = 0;
      return { items, provider: "google" };
    } catch (e) {
      gErr = e;
      googleConsecutiveFailures++;
      if (googleConsecutiveFailures === GOOGLE_BREAKER_THRESHOLD) {
        console.log(`breaker: google failed ${GOOGLE_BREAKER_THRESHOLD}x in a row, bing-only from here`);
      }
    }
  }
  try {
    return { items: await fetchFromBing(theme), provider: "bing" };
  } catch (bErr) {
    throw new Error(`google: ${String(gErr).slice(0, 60)} / bing: ${String(bErr).slice(0, 60)}`);
  }
}

type ThemeResult = {
  fetched: number;
  inserted: number;
  ms: number;
  provider?: string;
  error?: string;
  skipped?: string;
};

Deno.serve(async (_req: Request) => {
  const started = Date.now();
  googleConsecutiveFailures = 0; // 遮断器は1回の実行内で完結させる（前回の状態を持ち越さない）
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: themeRows, error: themeErr } = await supabase
    .from("news_themes")
    .select("theme")
    .eq("active", true);

  if (themeErr) {
    return new Response(
      JSON.stringify({ ok: false, error: themeErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const themes = (themeRows || []).map((r) => r.theme as string);
  const results: Record<string, ThemeResult> = {};
  console.log(`start: ${themes.length} themes`);

  async function runOne(theme: string): Promise<void> {
    const t0 = Date.now();
    try {
      const { items, provider } = await fetchThemeNews(theme);
      const rows = items.map((it) => ({
        theme,
        title: it.title,
        link: it.link,
        source: it.source,
        pub_date: it.pub_date,
      }));

      let inserted = 0;
      if (rows.length > 0) {
        const { error, count } = await supabase
          .from("dx_news")
          .upsert(rows, { onConflict: "link", ignoreDuplicates: true, count: "exact" });
        if (error) throw error;
        inserted = count ?? 0;
      }
      results[theme] = { fetched: items.length, inserted, ms: Date.now() - t0, provider };
      console.log(`ok[${provider}]: ${theme} fetched=${items.length} inserted=${inserted} ${Date.now() - t0}ms`);
    } catch (err) {
      results[theme] = { fetched: 0, inserted: 0, ms: Date.now() - t0, error: String(err) };
      console.log(`fail: ${theme} ${Date.now() - t0}ms ${String(err).slice(0, 160)}`);
    }
  }

  // 5本ずつ並列。全体の締切を過ぎたら、残りは着手せず「未着手」として返す
  // （546 で全部消えるより、部分成功＋「ここから先は未着手」が残る方が価値がある）。
  for (let i = 0; i < themes.length; i += CONCURRENCY) {
    if (Date.now() - started > OVERALL_DEADLINE_MS) {
      for (const theme of themes.slice(i)) {
        results[theme] = { fetched: 0, inserted: 0, ms: 0, skipped: "deadline" };
      }
      console.log(`deadline: ${themes.length - i} themes skipped`);
      break;
    }
    await Promise.allSettled(themes.slice(i, i + CONCURRENCY).map(runOne));
  }

  const summary = Object.values(results).reduce(
    (a, r) => ({
      inserted: a.inserted + r.inserted,
      failed: a.failed + (r.error ? 1 : 0),
      skipped: a.skipped + (r.skipped ? 1 : 0),
    }),
    { inserted: 0, failed: 0, skipped: 0 },
  );
  console.log(`done: inserted=${summary.inserted} failed=${summary.failed} skipped=${summary.skipped} ${Date.now() - started}ms`);

  // 1本でも通れば ok。全テーマ失敗のときだけ ok:false（監視側が「本当に死んだ」を区別できるように）。
  const allFailed = themes.length > 0 && summary.failed + summary.skipped === themes.length;
  return new Response(
    JSON.stringify({ ok: !allFailed, themeCount: themes.length, ...summary, ms: Date.now() - started, results }),
    { status: allFailed ? 502 : 200, headers: { "Content-Type": "application/json" } },
  );
});
