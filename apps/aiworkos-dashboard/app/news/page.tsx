"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

// DXニュース。毎朝ここを開いて、追っているテーマの動きを一望する。
//
// 作りの考え方:
//   ・テキストの羅列にしない。カテゴリー色・媒体・経過時間を持たせて「紙面」に見せる。
//     見出しだけが並ぶ一覧は、量が増えるほど読まなくなる。
//   ・「前回見た時刻」を端末に覚えさせ、それ以降の記事に🔴を付ける。
//     毎日開く画面でいちばん要るのは「どこまで読んだか」であって全件表示ではない。
//     サーバに既読を持たせないのは、1人で使う道具に同期の仕組みを足す価値が薄いため。
//   ・記事本文は取っていない（RSSの見出しとリンクだけ）。要約を作れるように見せない。

type NewsItem = {
  id: number;
  theme: string;
  category: string;
  title: string;
  link: string;
  source: string | null;
  pub_date: string | null;
};

type NewsResponse = {
  items: NewsItem[];
  categories: string[];
  days: number;
  rawCount: number;
  error?: string;
};

const LAST_VISIT_KEY = "aiworkos.news.lastVisit";

// カテゴリーの見た目。テーマではなくカテゴリーに色を当てる（テーマは増減するが
// カテゴリーは4つで安定しており、色が意味を持ち続ける）。
const CATEGORY_STYLE: Record<string, { chip: string; bar: string; icon: string }> = {
  自治体DX: { chip: "bg-sky-100 text-sky-800", bar: "bg-sky-400", icon: "🏛️" },
  生成AI: { chip: "bg-violet-100 text-violet-800", bar: "bg-violet-400", icon: "🤖" },
  法人OS: { chip: "bg-emerald-100 text-emerald-800", bar: "bg-emerald-400", icon: "📮" },
  "ロビー活動／他": { chip: "bg-amber-100 text-amber-800", bar: "bg-amber-400", icon: "🤝" },
};
const FALLBACK_STYLE = { chip: "bg-gray-100 text-gray-700", bar: "bg-gray-300", icon: "📰" };

function styleOf(category: string) {
  return CATEGORY_STYLE[category] ?? FALLBACK_STYLE;
}

/** JSTの YYYY-MM-DD。日付の区切り（今日/昨日）をJSTで判定するため。 */
function jstDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function dayLabel(day: string, todayJst: string): string {
  if (day === todayJst) return "今日";
  const y = new Date(new Date(`${todayJst}T00:00:00Z`).getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  if (day === y) return "昨日";
  const [, m, d] = day.split("-");
  const wd = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(`${day}T00:00:00Z`).getUTCDay()
  ];
  return `${Number(m)}/${Number(d)}（${wd}）`;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

export default function NewsPage() {
  const [data, setData] = useState<NewsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState<string>("すべて");
  const [q, setQ] = useState("");
  // 前回この画面を開いた時刻。読み込み時に1度だけ読み、表示中は動かさない
  // （見ている最中に🔴が消えると、どれが新着だったのか分からなくなる）。
  const [lastVisit, setLastVisit] = useState<string | null>(null);

  useEffect(() => {
    try {
      setLastVisit(window.localStorage.getItem(LAST_VISIT_KEY));
      window.localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    } catch {
      // プライベートモード等で localStorage が使えなくても本体は動く
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/news?days=30", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const todayJst = useMemo(() => jstDay(new Date().toISOString()), []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.items.filter((it) => {
      if (category !== "すべて" && it.category !== category) return false;
      if (!needle) return true;
      return (
        it.title.toLowerCase().includes(needle) ||
        it.theme.toLowerCase().includes(needle) ||
        (it.source ?? "").toLowerCase().includes(needle)
      );
    });
  }, [data, category, q]);

  // 日付ごとに束ねる。紙面の「面」に相当する区切り。
  const byDay = useMemo(() => {
    const m = new Map<string, NewsItem[]>();
    for (const it of filtered) {
      const day = it.pub_date ? jstDay(it.pub_date) : "日付不明";
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(it);
    }
    return Array.from(m.entries());
  }, [filtered]);

  const freshCount = useMemo(() => {
    if (!data || !lastVisit) return 0;
    return data.items.filter((it) => it.pub_date && it.pub_date > lastVisit).length;
  }, [data, lastVisit]);

  const isFresh = (it: NewsItem) => !!lastVisit && !!it.pub_date && it.pub_date > lastVisit;

  const countOf = (cat: string) =>
    !data ? 0 : cat === "すべて" ? data.items.length : data.items.filter((i) => i.category === cat).length;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-4">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">DXニュース</h1>
        <p className="mt-1 text-sm text-gray-500">
          自治体DX・生成AI・法人請求まわりの直近1か月。毎朝ここで動きを拾います
          {lastVisit && freshCount > 0 && (
            <span className="ml-1 font-bold text-rose-600">／前回以降 {freshCount}件</span>
          )}
        </p>
      </header>

      {failed && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          取得できませんでした。時間をおいて開き直してください。
        </p>
      )}

      {!data && !failed && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-gray-200 bg-gray-100" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* カテゴリー切替。件数を載せて、押す前に分布が分かるようにする */}
          <div className="sticky top-0 z-10 -mx-4 mb-3 bg-gray-50/95 px-4 pb-2 pt-1 backdrop-blur">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {["すべて", ...data.categories].map((cat) => {
                const on = cat === category;
                const st = cat === "すべて" ? FALLBACK_STYLE : styleOf(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategory(cat)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                      on
                        ? "bg-gray-900 text-white"
                        : "border border-gray-200 bg-white text-gray-600 active:bg-gray-100"
                    }`}
                  >
                    {cat === "すべて" ? "📰" : st.icon} {cat}
                    <span className={`ml-1 text-xs ${on ? "text-gray-300" : "text-gray-400"}`}>
                      {countOf(cat)}
                    </span>
                  </button>
                );
              })}
            </div>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="見出し・テーマ・媒体で絞り込む"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>

          {byDay.length === 0 ? (
            <p className="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500">
              該当する記事がありません
            </p>
          ) : (
            byDay.map(([day, items]) => (
              <section key={day} className="mb-5">
                <h2 className="mb-2 flex items-baseline gap-2 border-b border-gray-200 pb-1">
                  <span className="text-base font-bold text-gray-900">
                    {day === "日付不明" ? "日付不明" : dayLabel(day, todayJst)}
                  </span>
                  <span className="text-xs text-gray-400">{items.length}件</span>
                </h2>
                <ul className="space-y-2">
                  {items.map((it) => {
                    const st = styleOf(it.category);
                    return (
                      <li key={it.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                        <a
                          href={it.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex gap-0 active:bg-gray-50"
                        >
                          {/* 左端の色帯でカテゴリーを示す。バッジより先に目に入る */}
                          <span className={`w-1 shrink-0 ${st.bar}`} aria-hidden />
                          <span className="min-w-0 flex-1 px-3 py-2.5">
                            <span className="mb-1 flex flex-wrap items-center gap-1.5">
                              {isFresh(it) && (
                                <span className="shrink-0 rounded-full bg-rose-600 px-1.5 py-0.5 text-[0.625rem] font-bold text-white">
                                  NEW
                                </span>
                              )}
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold ${st.chip}`}
                              >
                                {it.theme}
                              </span>
                              <span className="shrink-0 text-[0.6875rem] text-gray-400">
                                {it.source ?? "出典不明"}
                                {it.pub_date && ` ・ ${timeLabel(it.pub_date)}`}
                              </span>
                            </span>
                            <span className="block text-sm font-semibold leading-snug text-gray-900">
                              {it.title}
                            </span>
                          </span>
                          <span className="shrink-0 self-center pr-3 text-gray-300" aria-hidden>
                            ↗
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}

          <p className="mt-4 text-center text-xs text-gray-400">
            直近{data.days}日／重複を除いて {data.items.length}件（取得 {data.rawCount}件）。
            テーマの増減は{" "}
            <Link href="/status" className="text-indigo-500">
              連携ダッシュボード
            </Link>
            で確認できます
          </p>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}
