"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./news.css";
import XDigest from "./XDigest";

// DXニュース。毎朝ここを開いて、追っているテーマの動きを一望する。
//
// 作りの考え方:
//   ・テキストの羅列にしない。カテゴリー色・媒体・時刻を持たせて「紙面」に見せる。
//     見出しだけが並ぶ一覧は、量が増えるほど読まなくなる。
//   ・「前回見た時刻」を端末に覚えさせ、それ以降の記事に🔴を付ける。
//     毎日開く画面でいちばん要るのは「どこまで読んだか」であって全件表示ではない。
//     サーバに既読を持たせないのは、1人で使う道具に同期の仕組みを足す価値が薄いため。
//   ・記事本文は取っていない（RSSの見出しとリンクだけ）。要約を作れるように見せない。
//
// 見た目は Claude Design の「ニュース取得サイトのデザイン」に合わせて 2026-08-22 に
// 作り直した。トークンとクラスは news.css 側（.nw 配下に閉じてある）。
// 旧版はモバイル1カラムのカード並べで、PCで開くと余白ばかりが目立っていた。
//
// 既読の持ち方が旧版と変わっている。旧版は「前回の訪問時刻より新しいか」だけで、
// 開いた記事も🔴のままだった。押した記事のidも覚えて、押した瞬間に薄くする。

type NewsItem = {
  id: number;
  theme: string;
  category: string;
  /** 中カテゴリー。大カテゴリーの下の束ね（例: 生成AI → Anthropic）。 */
  subcategory: string;
  title: string;
  link: string;
  source: string | null;
  pub_date: string | null;
};

type NewsResponse = {
  items: NewsItem[];
  categories: string[];
  themes: { theme: string; category: string; subcategory: string }[];
  days: number;
  rawCount: number;
  error?: string;
};

const LAST_VISIT_KEY = "aiworkos.news.lastVisit";
const READ_IDS_KEY = "aiworkos.news.readIds";

/** 端末に覚えておく既読idの上限。30日ぶんの記事数（1,000件強）に対して余裕を持たせる。 */
const READ_IDS_MAX = 2000;

// カテゴリーの色。テーマではなくカテゴリーに当てる（テーマは増減するが
// カテゴリーは5つで安定しており、色が意味を持ち続ける）。
// 値は news.css のトークン。丸ポチ用と文字用を分けてあるのは、
// 意匠どおりの鮮やかな色のままだと12pxの文字が白地で読めないため。
// 大カテゴリーの色。2026-08-22に大／中の2段へ組み替えた（news_themes.subcategory）。
// 旧カテゴリー名も残してあるのは、テーマを戻したときに色が落ちないようにするため。
const CATEGORY_COLOR: Record<string, { dot: string; text: string }> = {
  生成AI: { dot: "var(--cat-ai)", text: "var(--cat-ai-text)" },
  サービス関連: { dot: "var(--cat-os)", text: "var(--cat-os-text)" },
  団体: { dot: "var(--cat-lobby)", text: "var(--cat-lobby-text)" },
  その他: { dot: "var(--cat-gov)", text: "var(--cat-gov-text)" },
  // 旧カテゴリー名
  "営業×AI": { dot: "var(--cat-sales)", text: "var(--cat-sales-text)" },
  自治体DX: { dot: "var(--cat-gov)", text: "var(--cat-gov-text)" },
  法人OS: { dot: "var(--cat-os)", text: "var(--cat-os-text)" },
  "ロビー活動／他": { dot: "var(--cat-lobby)", text: "var(--cat-lobby-text)" },
};
const FALLBACK_COLOR = { dot: "var(--cat-other)", text: "var(--cat-other-text)" };

function colorOf(category: string) {
  return CATEGORY_COLOR[category] ?? FALLBACK_COLOR;
}

/** JSTの YYYY-MM-DD。日付の区切り（今日/昨日）をJSTで判定するため。 */
function jstDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

function dayLabel(day: string, todayJst: string): string {
  const [, m, d] = day.split("-");
  const wd = WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()];
  if (day === todayJst) return `今日 ${Number(m)}月${Number(d)}日（${wd}）`;
  const y = new Date(new Date(`${todayJst}T00:00:00Z`).getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  if (day === y) return `昨日 ${Number(m)}月${Number(d)}日（${wd}）`;
  return `${Number(m)}月${Number(d)}日（${wd}）`;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

/** ヘッダーに出す今日の日付。 */
function todayLabel(todayJst: string): string {
  const [y, m, d] = todayJst.split("-");
  const wd = WEEKDAY[new Date(`${todayJst}T00:00:00Z`).getUTCDay()];
  return `${y}年${Number(m)}月${Number(d)}日（${wd}）`;
}

export default function NewsPage() {
  const [data, setData] = useState<NewsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState("すべて");
  const [theme, setTheme] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [hideRead, setHideRead] = useState(false);
  // 前回この画面を開いた時刻。読み込み時に1度だけ読み、表示中は動かさない
  // （見ている最中に🔴が消えると、どれが新着だったのか分からなくなる）。
  const [lastVisit, setLastVisit] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    try {
      setLastVisit(window.localStorage.getItem(LAST_VISIT_KEY));
      window.localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
      const raw = window.localStorage.getItem(READ_IDS_KEY);
      if (raw) setReadIds(new Set(JSON.parse(raw) as number[]));
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

  const markRead = useCallback((id: number) => {
    setReadIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        // 新しい方を残す。増え続けると localStorage の枠（5MB前後）を
        // いつか超え、setItem が例外を投げて既読が丸ごと保存されなくなる。
        const arr = Array.from(next).slice(-READ_IDS_MAX);
        window.localStorage.setItem(READ_IDS_KEY, JSON.stringify(arr));
      } catch {
        // 保存できなくても、その場の見た目は変わる
      }
      return next;
    });
  }, []);

  const todayJst = useMemo(() => jstDay(new Date().toISOString()), []);

  /** 未読 = 前回の訪問より後に出た、かつまだ押していない。 */
  const isUnread = useCallback(
    (it: NewsItem) =>
      !!lastVisit && !!it.pub_date && it.pub_date > lastVisit && !readIds.has(it.id),
    [lastVisit, readIds]
  );

  // 中カテゴリーごとの件数。2段目のチップを件数順に並べるのに使う。
  const subCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of data?.items ?? [])
      m.set(it.subcategory, (m.get(it.subcategory) ?? 0) + 1);
    return m;
  }, [data]);

  // カテゴリーごとの件数。押す前に分布が分かるようにする。
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of data?.items ?? []) m.set(it.category, (m.get(it.category) ?? 0) + 1);
    return m;
  }, [data]);

  // いま選んでいるカテゴリーに属する中カテゴリー。api が返す news_themes が正で、
  // 画面側に一覧を持たない（テーマは news_themes に1行足すだけで増える）。
  // 2段目にテーマ（29本）をそのまま並べると多すぎるので、中カテゴリーで束ねて出す。
  const subcategoriesOfCategory = useMemo(() => {
    if (!data || category === "すべて") return [];
    const inCat = data.themes.filter((t) => t.category === category);
    const names = Array.from(new Set(inCat.map((t) => t.subcategory)));
    // 大カテゴリーと同じく件数の多い順。0件のものも末尾に残す。
    return names.sort((a, b) => {
      const d = (subCounts.get(b) ?? 0) - (subCounts.get(a) ?? 0);
      return d !== 0 ? d : a.localeCompare(b, "ja");
    });
  }, [data, category, subCounts]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.items.filter((it) => {
      if (category !== "すべて" && it.category !== category) return false;
      if (theme && it.subcategory !== theme) return false;
      if (hideRead && !isUnread(it)) return false;
      if (!needle) return true;
      return (
        it.title.toLowerCase().includes(needle) ||
        it.theme.toLowerCase().includes(needle) ||
        (it.source ?? "").toLowerCase().includes(needle)
      );
    });
  }, [data, category, theme, q, hideRead, isUnread]);

  // いちばん新しい1件は大見出しで立てる。紙面の一面にあたる。
  // 絞り込みの結果に追随させる（絞った状態で無関係な記事が居座らないように）。
  const hero = filtered[0] ?? null;
  const rest = hero ? filtered.slice(1) : filtered;

  // 日付ごとに束ねる。紙面の「面」に相当する区切り。
  const byDay = useMemo(() => {
    const m = new Map<string, NewsItem[]>();
    for (const it of rest) {
      const day = it.pub_date ? jstDay(it.pub_date) : "日付不明";
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(it);
    }
    return Array.from(m.entries());
  }, [rest]);

  const freshCount = useMemo(
    () => (data ? data.items.filter(isUnread).length : 0),
    [data, isUnread]
  );

  const pickCategory = (c: string) => {
    setCategory(c);
    setTheme(null);
  };

  return (
    <div className="nw">
      <div className="nw-accent" />

      <header className="nw-header">
        <div className="nw-shell nw-masthead">
          <div className="nw-brand">
            <h1 className="nw-logo">
              DX NEWS<span>.</span>
            </h1>
            <span className="nw-tagline">
              毎朝8:00 自動収集 ／ {data ? `${data.themes.length}テーマ・${data.categories.length}カテゴリー` : "収集中"}
              {" ＋ X監視ダイジェスト"}
            </span>
          </div>
          <div className="nw-meta">
            <span className="nw-date">{todayLabel(todayJst)}</span>
            <input
              type="search"
              className="nw-search"
              placeholder="見出しを検索"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="見出し・テーマ・媒体で絞り込む"
            />
          </div>
        </div>

        <div className="nw-shell nw-chiprow">
          {/* APIが件数の多い順で返す。読むものから目に入るようにするため、
              画面側でデザイン順に並べ直さない。 */}
          {["すべて", ...(data?.categories ?? [])].map((c) => {
            const on = c === category;
            const col = c === "すべて" ? { dot: "var(--ff-green-500)" } : colorOf(c);
            const n = c === "すべて" ? (data?.items.length ?? 0) : (counts.get(c) ?? 0);
            return (
              <button
                key={c}
                type="button"
                className="nw-chip"
                aria-pressed={on}
                onClick={() => pickCategory(c)}
              >
                <span className="nw-chip-dot" style={{ background: col.dot }} />
                {c}
                <span className="nw-chip-count">{n}</span>
              </button>
            );
          })}
          <span className="nw-chip-spacer" />
          <button
            type="button"
            className="nw-chip"
            aria-pressed={hideRead}
            onClick={() => setHideRead((v) => !v)}
            title={
              lastVisit
                ? `前回開いた後に出た記事だけを出す（${freshCount}件）`
                : "初回は前回の訪問時刻が無いため、全件が既読扱いになります"
            }
          >
            未読のみ
            <span className="nw-chip-count">{freshCount}</span>
          </button>
        </div>

        {subcategoriesOfCategory.length > 0 && (
          <div className="nw-themebar">
            <div className="nw-shell nw-chiprow">
              <span className="nw-themelabel">内訳：</span>
              {subcategoriesOfCategory.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="nw-chip nw-chip-sm"
                  aria-pressed={theme === t}
                  onClick={() => setTheme(theme === t ? null : t)}
                >
                  {t}
                  <span className="nw-chip-count">{subCounts.get(t) ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <main className="nw-shell nw-main">
        <section className="nw-col" aria-label="ニュース一覧">
          {failed && <p className="nw-empty">取得できませんでした。時間をおいて開き直してください。</p>}

          {!data && !failed && (
            <div aria-hidden>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="nw-skel" />
              ))}
            </div>
          )}

          {data && hero && (
            <article className="nw-hero">
              <div className="nw-hero-tags">
                <span className="nw-badge">
                  {hero.pub_date && jstDay(hero.pub_date) === todayJst ? "今朝のトップ" : "最新の1本"}
                </span>
                <span className="nw-hero-theme" style={{ color: colorOf(hero.category).text }}>
                  {hero.category} ／ {hero.theme}
                </span>
                {isUnread(hero) && <span className="nw-dot-new" aria-label="未読" />}
              </div>
              <a
                href={hero.link}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => markRead(hero.id)}
              >
                <h2 className="nw-hero-title">{hero.title}</h2>
              </a>
              <div className="nw-hero-foot">
                <span style={{ fontFamily: "var(--font-latin)" }}>{timeLabel(hero.pub_date)}</span>
                <span>{hero.source ?? "出典不明"}</span>
                <a
                  href={hero.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "var(--fs-12)" }}
                  onClick={() => markRead(hero.id)}
                >
                  元記事を読む →
                </a>
              </div>
            </article>
          )}

          {data && filtered.length === 0 && (
            <p className="nw-empty">
              {hideRead ? "未読の記事はありません" : "該当する記事はありません"}
            </p>
          )}

          {byDay.map(([day, items]) => (
            <div key={day}>
              <h3 className="nw-dayhead">
                <b>{day === "日付不明" ? "日付不明" : dayLabel(day, todayJst)}</b>
                <span>{items.length}件</span>
              </h3>
              {items.map((it) => {
                const unread = isUnread(it);
                // 薄字にするのは「自分が開いた記事」だけ。
                //
                // 意匠どおり「未読でないもの」を薄くすると、30日ぶんの一覧では
                // 毎朝ほぼ全件が該当して紙面の9割が灰色になる（実機で確認）。
                // 薄字が常態になると、薄いことが何も意味しなくなる。
                // 2つの合図を役割で分ける——🔴は前回以降に出たもの、薄字は開いたもの。
                const dim = readIds.has(it.id);
                return (
                  <a
                    key={it.id}
                    className={`nw-item${dim ? " is-read" : ""}`}
                    href={it.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => markRead(it.id)}
                  >
                    <time>{timeLabel(it.pub_date)}</time>
                    <span className="nw-item-theme" style={{ color: colorOf(it.category).text }}>
                      {it.theme}
                    </span>
                    <span className="nw-item-body">
                      {unread && <span className="nw-dot-new" aria-label="未読" />}
                      <span className="nw-item-title">{it.title}</span>
                      <span className="nw-item-source">{it.source ?? "出典不明"}</span>
                    </span>
                  </a>
                );
              })}
            </div>
          ))}

          {data && (
            <p className="nw-foot">
              直近{data.days}日／重複を除いて {data.items.length}件（取得 {data.rawCount}件）。
              テーマの増減は <Link href="/status">連携ダッシュボード</Link> で確認できます。
              {" ／ "}
              <Link href="/">ホームへ戻る</Link>
            </p>
          )}
        </section>

        <aside className="nw-col" aria-label="X監視ダイジェスト">
          <XDigest />
        </aside>
      </main>
    </div>
  );
}
