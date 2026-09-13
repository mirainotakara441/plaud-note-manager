import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

async function fetchThemeNews(theme: string): Promise<NewsItem[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(theme)}&hl=ja&gl=JP&ceid=JP:ja`;
  const res = await fetch(rssUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsFetcher/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed for "${theme}": ${res.status}`);
  }
  const xml = await res.text();
  return parseRss(xml);
}

Deno.serve(async (_req: Request) => {
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
  const results: Record<string, { fetched: number; inserted: number; error?: string }> = {};

  for (const theme of themes) {
    try {
      const items = await fetchThemeNews(theme);
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
      results[theme] = { fetched: items.length, inserted };
    } catch (err) {
      results[theme] = { fetched: 0, inserted: 0, error: String(err) };
    }
  }

  return new Response(
    JSON.stringify({ ok: true, themeCount: themes.length, results }),
    { headers: { "Content-Type": "application/json" } },
  );
});
