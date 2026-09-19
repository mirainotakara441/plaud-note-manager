"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartTitle, StatTile } from "@/app/components/charts";
import { PHOTO_RENDER_VERSION, starsText, withShopHashtag } from "@/lib/ramen";
import {
  BOWL_STYLES,
  BOWL_TASTES,
  normalizeShopName,
  summarizeBowlTypes,
  tabelogShopId,
} from "@/lib/ramenBowlType.mjs";
import { stationKey } from "@/lib/stationGeo.mjs";
import dynamic from "next/dynamic";

// 地図は Leaflet（window 前提）なので、サーバー側では描かない
const RamenMap = dynamic(() => import("./RamenMap"), { ssr: false });

// ラーメン（ライフOS側の第1ブロック）。1行＝1杯（1訪問）。
// データは /api/ramen（Supabase ramen_logs・読み取り専用）。
//
// この画面が引き受けている流れ:
//   ① 店で「一杯を記録」（店名＋その場の一言）→ status=captured
//   ② 「文章を作る」で食べログ用とX用を同時生成 → status=drafted
//   ③ 食べログは本文をコピーして貼る（投稿ボタンは本人が押す・半自動）
//      Xは「Xへ投稿」でAPI経由そのまま出る → status=posted
// 月次の4本立て（まとめ／特徴／金賞・殿堂／思い出の4枚）も同じ画面から生成する。

type Log = {
  id: number;
  eaten_on: string;
  bowl_no: number | null;
  bowl_label: string | null;
  shop: string;
  area: string | null;
  genre: string | null;
  visit_count: number | null;
  menu: string | null;
  price: number | null;
  score: number | null;
  score_time: string | null;
  // stars は自分の★（半分刻み）。score は食べログに付けた点数で、別物。
  stars: number | null;
  stars_label: string | null;
  title: string | null;
  excerpt: string | null;
  memo: string | null;
  status: "captured" | "drafted" | "posted";
  draft_tabelog: string | null;
  draft_x: string | null;
  photo_count: number;
  photo_urls: string[] | null;
  tabelog_url: string | null;
  tabelog_shop_url: string | null;
  x_url: string | null;
  x_posted_on: string | null;
  x_excerpt: string | null;
  is_ramen: boolean;
  // 種別。style/taste はAPIが付けた判定結果（手入力があればそれ）、
  // bowl_style/bowl_taste は手入力そのもの（null なら自動判定）
  style?: string;
  taste?: string | null;
  bowl_style?: string | null;
  bowl_taste?: string | null;
  note: string | null;
};

const C_BOWL = "#eb6834";
const C_X = "#4a3aa7";

type FilterKey = "all" | "ramen" | "no_x";

// 既定はラーメンだけ。積み上げを見る画面なので、うどん・カレー・カフェが
// 混ざると杯数が読めなくなる（2026-09-13に本人が指定）。
// 「すべて」だけがラーメン以外も見せる逃げ道で、他はラーメンが前提。
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ramen", label: "ラーメンのみ" },
  { key: "no_x", label: "X未リンク" },
  { key: "all", label: "すべて" },
];

const MONTHLY_KINDS = [
  { key: "summary", label: "ラーメンまとめ" },
  { key: "feature", label: "今月の特徴" },
  { key: "awards", label: "金賞・殿堂入り" },
  { key: "memories", label: "思い出の4枚" },
] as const;

const WD = ["日", "月", "火", "水", "木", "金", "土"];

// 自分の★は半分刻み。1杯ずつ押して保存するので、選択肢を並べる方が速い。
const STAR_CHOICES = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];

function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${m}/${day}（${WD[new Date(y, m - 1, day).getDay()] ?? ""}）`;
}

function fmtMonth(ym: string) {
  return `${Number(ym.split("-")[1])}月`;
}

// 写真は非公開バケットに置いてあり、公開URLを持たない。
// 表示はこのプロキシ経由（合言葉認証の内側の端末からしか見えない）。
//
// w を付けるとサーバー側で縮めて返す。原寸は1枚0.7〜3.2MBあり、一覧に並べると
// 1か月ぶんで10MBを超える。
// v は作り方の版（lib/ramen.ts）。上げると端末のキャッシュを取り直させられる。
//
// 拡大表示も 1280 を使う。原寸は3.0秒かかるのに対し1280は0.24秒で、
// iPhoneの幅390pxに対して3倍の解像度がある（写真のメモ欄の手書き★も読める）。
// /ramen/all の拡大も同じ 1280（2026-09-13に揃えた）。
function photoUrl(path: string, width?: 480 | 1280) {
  const w = width ? `&w=${width}&v=${PHOTO_RENDER_VERSION}` : "";
  return `/api/ramen/photo?path=${encodeURIComponent(path)}${w}`;
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {children}
    </section>
  );
}

function MonthlyBars({ rows }: { rows: { ym: string; ramen: number; other: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.ramen + r.other));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.ym} className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-right text-xs font-medium text-gray-500">
            {fmtMonth(r.ym)}
          </span>
          <div className="flex h-5 flex-1 items-stretch overflow-hidden rounded-md bg-gray-100">
            <div style={{ width: `${(r.ramen / max) * 100}%`, backgroundColor: C_BOWL }} />
            <div style={{ width: `${(r.other / max) * 100}%`, backgroundColor: "#d8d3cd" }} />
          </div>
          <span className="w-16 shrink-0 text-xs text-gray-500">
            <span className="font-bold text-gray-900">{r.ramen}</span>杯
            {r.other > 0 && <span className="text-gray-400"> +{r.other}</span>}
          </span>
        </div>
      ))}
      <p className="pt-1 text-[0.625rem] text-gray-400">
        オレンジ＝ラーメン／グレー＝それ以外（うどん・そば・とんかつ等）
      </p>
    </div>
  );
}

// 横棒1本。ラベル・本数・最大値から幅を出す（ジャンル別・駅別で共用）
function CountBar({
  label,
  count,
  max,
  color,
  sub,
}: {
  label: string;
  count: number;
  max: number;
  color: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-right text-xs font-medium text-gray-600">
        {label}
      </span>
      <div className="h-5 flex-1 overflow-hidden rounded-md bg-gray-100">
        <div className="h-full" style={{ width: `${(count / Math.max(1, max)) * 100}%`, backgroundColor: color }} />
      </div>
      <span className="w-14 shrink-0 text-xs text-gray-500">
        <span className="font-bold text-gray-900">{count}</span>杯
        {sub && <span className="ml-1 text-gray-400">{sub}</span>}
      </span>
    </div>
  );
}

type Hyakumeiten = {
  id: number;
  list_order: number;
  shop: string;
  station: string | null;
  holiday: string | null;
  tabelog_url: string;
  tabelog_shop_id: string;
};

type RankTab = "shops" | "types" | "stations" | "best" | "hyaku" | "map";
const RANK_TABS: { key: RankTab; label: string }[] = [
  { key: "shops", label: "杯数が多い順" },
  { key: "types", label: "ジャンル別" },
  { key: "stations", label: "駅別" },
  { key: "best", label: "マイベスト" },
  { key: "hyaku", label: "百名店" },
  { key: "map", label: "地図" },
];

type StationGeo = { station: string; lat: number; lng: number };

// ラーメンの積み上げを切り口を変えて見る枠。
//
//   杯数が多い順 … 行った回数が多い店のベスト5
//   ジャンル別   … 形態（つけ麺・まぜそば…）と味・系統（塩・豚骨…）ごとの杯数
//   駅別         … 食べログの最寄り駅ごとの杯数
//   マイベスト   … 自分の★が高い順
//   百名店       … 食べログ「ラーメン TOKYO 百名店」100店のうち、行った／まだ
//
// 種別の判定はAPI（lib/ramenBowlType.mjs）が付けたものを数えるだけ。ここでは決めない。
// 対象はラーメン（is_ramen）のみ。うどん・カレーが混ざると杯数が読めなくなる。
function RamenRankings({ ramen }: { ramen: Log[] }) {
  const [tab, setTab] = useState<RankTab>("shops");
  const [hyaku, setHyaku] = useState<Hyakumeiten[] | null>(null);
  const [hyakuError, setHyakuError] = useState(false);
  const [onlyUnvisited, setOnlyUnvisited] = useState(true);
  const [geo, setGeo] = useState<{ items: StationGeo[]; unresolved: number; deferred: number } | null>(null);
  const [geoError, setGeoError] = useState(false);

  // 駅の座標は地図を開いた時だけ取る（無い駅はAPIがその場で引いて足す）
  useEffect(() => {
    if (tab !== "map" || geo) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ramen/stations", { cache: "no-store" });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d?.error ?? `status ${res.status}`);
        if (alive) setGeo({ items: d.items ?? [], unresolved: d.unresolved ?? 0, deferred: d.deferred ?? 0 });
      } catch {
        if (alive) setGeoError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, geo]);

  // 百名店は開いた時だけ取る（毎回100行を運ばない）。地図でも使う
  useEffect(() => {
    if ((tab !== "hyaku" && tab !== "map") || hyaku) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ramen/hyakumeiten", { cache: "no-store" });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d?.error ?? `status ${res.status}`);
        if (alive) setHyaku(d.items ?? []);
      } catch {
        if (alive) setHyakuError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, hyaku]);

  // 店ごとの回数。同数なら最後に行った日が新しい方を上に
  const shops = useMemo(() => {
    const map = new Map<string, { shop: string; count: number; url: string | null; last: string }>();
    for (const r of ramen) {
      const cur = map.get(r.shop);
      if (cur) {
        cur.count += 1;
        if (r.eaten_on > cur.last) cur.last = r.eaten_on;
        if (!cur.url && r.tabelog_shop_url) cur.url = r.tabelog_shop_url;
      } else {
        map.set(r.shop, { shop: r.shop, count: 1, url: r.tabelog_shop_url, last: r.eaten_on });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
      .slice(0, 5);
  }, [ramen]);

  // 再訪率。訪問した店のうち2回以上行った店の割合と、再訪で食べた杯数
  const revisit = useMemo(() => {
    const perShop = new Map<string, number>();
    for (const r of ramen) perShop.set(r.shop, (perShop.get(r.shop) ?? 0) + 1);
    const shopsTotal = perShop.size;
    const repeatShops = Array.from(perShop.values()).filter((n) => n >= 2).length;
    const repeatBowls = Array.from(perShop.values()).reduce((a, n) => a + Math.max(0, n - 1), 0);
    return {
      shopsTotal,
      repeatShops,
      repeatBowls,
      rate: shopsTotal ? Math.round((repeatShops / shopsTotal) * 100) : 0,
    };
  }, [ramen]);

  const types = useMemo(() => summarizeBowlTypes(ramen), [ramen]);

  // 駅別。食べログの最寄り駅は「地下鉄成増、成増」のように複数書かれているので先頭だけ使う。
  // 駅が入っていない杯は「（駅なし）」で別に数え、棒には混ぜない
  const stations = useMemo(() => {
    const map = new Map<string, number>();
    let none = 0;
    for (const r of ramen) {
      const st = (r.area ?? "").split(/[、,]/)[0]?.trim() ?? "";
      if (!st) {
        none += 1;
        continue;
      }
      map.set(st, (map.get(st) ?? 0) + 1);
    }
    const rows = Array.from(map.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja"))
      .slice(0, 8);
    return { rows, none, total: map.size };
  }, [ramen]);

  // 自分の★が高い順。同点は新しい方を上に。★を付けていない杯は入らない
  const best = useMemo(
    () =>
      ramen
        .filter((r) => r.stars != null)
        .sort((a, b) => Number(b.stars) - Number(a.stars) || (a.eaten_on < b.eaten_on ? 1 : -1))
        .slice(0, 10),
    [ramen]
  );

  // 百名店との突き合わせ。食べログの店ID（URL末尾の数字）で当て、
  // 店URLが入っていない杯のために店名（空白・全半角だけ吸収）でも当てる
  const visited = useMemo(() => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const r of ramen) {
      const id = tabelogShopId(r.tabelog_shop_url);
      if (id) ids.add(id);
      names.add(normalizeShopName(r.shop));
    }
    return { ids, names };
  }, [ramen]);
  const hyakuRows = useMemo(() => {
    if (!hyaku) return null;
    const rows = hyaku.map((h) => ({
      ...h,
      done: visited.ids.has(h.tabelog_shop_id) || visited.names.has(normalizeShopName(h.shop)),
    }));
    return { rows, doneCount: rows.filter((r) => r.done).length };
  }, [hyaku, visited]);

  // 地図の点。駅ごとにまとめ、訪問した駅は杯数、百名店の未訪問だけの駅は店数を持つ
  const mapPoints = useMemo(() => {
    if (!geo) return [];
    const coord = new Map(geo.items.map((g) => [g.station, g]));
    const visitedByStation = new Map<string, { count: number; shops: Map<string, number> }>();
    for (const r of ramen) {
      const k = stationKey(r.area);
      if (!k || !coord.has(k)) continue;
      const cur = visitedByStation.get(k) ?? { count: 0, shops: new Map<string, number>() };
      cur.count += 1;
      cur.shops.set(r.shop, (cur.shops.get(r.shop) ?? 0) + 1);
      visitedByStation.set(k, cur);
    }
    const todoByStation = new Map<string, { name: string; url: string }[]>();
    for (const h of hyakuRows?.rows ?? []) {
      if (h.done) continue;
      const k = stationKey(h.station);
      if (!k || !coord.has(k)) continue;
      const list = todoByStation.get(k) ?? [];
      list.push({ name: h.shop, url: h.tabelog_url });
      todoByStation.set(k, list);
    }
    const out: import("./RamenMap").MapPoint[] = [];
    for (const [k, v] of visitedByStation) {
      const g = coord.get(k)!;
      const shops = Array.from(v.shops.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => ({ name, sub: `${n}杯` }));
      const todo = todoByStation.get(k) ?? [];
      out.push({
        key: k,
        lat: g.lat,
        lng: g.lng,
        kind: "visited",
        count: v.count,
        shops: [...shops, ...todo.map((t) => ({ name: t.name, sub: "百名店・まだ", url: t.url }))],
      });
    }
    for (const [k, list] of todoByStation) {
      if (visitedByStation.has(k)) continue;
      const g = coord.get(k)!;
      out.push({ key: k, lat: g.lat, lng: g.lng, kind: "todo", count: list.length, shops: list });
    }
    return out;
  }, [geo, ramen, hyakuRows]);

  const maxStyle = Math.max(1, ...types.styles.map((x) => x.count));
  const maxTaste = Math.max(1, ...types.tastes.map((x) => x.count));
  const maxStation = Math.max(1, ...stations.rows.map((x) => x.count));

  return (
    <Section>
      <ChartTitle color={C_BOWL} title="ランキング" hint={`ラーメン${ramen.length}杯から`} />
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="ランキングの切り口">
        {RANK_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full px-3 py-1 text-xs font-bold transition active:scale-95 ${
              tab === t.key ? "text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"
            }`}
            style={tab === t.key ? { backgroundColor: C_BOWL } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "shops" && (
        <p className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600" data-testid="rank-revisit">
          訪問した <span className="font-bold text-gray-900">{revisit.shopsTotal}</span> 店のうち、2回以上行った店は{" "}
          <span className="font-bold text-gray-900">{revisit.repeatShops}</span> 店（再訪率{" "}
          <span className="font-bold text-gray-900">{revisit.rate}%</span>）。再訪で食べた杯数 {revisit.repeatBowls} 杯。
        </p>
      )}
      {tab === "shops" && (
        <ol className="space-y-2" data-testid="rank-shops">
          {shops.map((r, i) => (
            <li key={r.shop} className="flex items-center gap-3">
              <span className="w-4 shrink-0 text-xs font-bold text-gray-400">{i + 1}</span>
              {r.url ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 underline decoration-gray-300 active:opacity-70"
                >
                  {r.shop}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">{r.shop}</span>
              )}
              <span className="shrink-0 text-sm text-gray-500">
                <span className="font-bold text-gray-900">{r.count}</span>回
              </span>
            </li>
          ))}
        </ol>
      )}

      {tab === "types" && (
        <div data-testid="rank-types">
          <p className="mb-1 text-[0.625rem] font-bold text-gray-400">形態</p>
          <div className="space-y-2">
            {types.styles.map((x) => (
              <CountBar key={x.label} label={x.label} count={x.count} max={maxStyle} color={C_BOWL} />
            ))}
          </div>
          <p className="mb-1 mt-4 text-[0.625rem] font-bold text-gray-400">味・系統</p>
          <div className="space-y-2">
            {types.tastes.map((x) => (
              <CountBar key={x.label} label={x.label} count={x.count} max={maxTaste} color="#c9a227" />
            ))}
          </div>
          <p className="pt-2 text-[0.625rem] text-gray-400">
            種別はメニュー欄・題名・本文の言葉から自動で判定。カードの「種別」を押せば直せます。
          </p>
          {types.tasteUnknown > 0 && (
            <Link
              href="/ramen/taste"
              className="mt-2 flex items-center justify-between rounded-xl bg-orange-50 px-3 py-2 text-sm font-bold text-orange-900 ring-1 ring-orange-200 active:opacity-70"
            >
              <span>味が読み取れなかった {types.tasteUnknown} 杯に、1杯ずつ味をつける</span>
              <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      )}

      {tab === "stations" && (
        <div data-testid="rank-stations">
          <div className="space-y-2">
            {stations.rows.map((x) => (
              <CountBar key={x.label} label={x.label} count={x.count} max={maxStation} color={C_BOWL} />
            ))}
          </div>
          <p className="pt-2 text-[0.625rem] text-gray-400">
            食べログの最寄り駅（先頭の駅）で数えた上位{stations.rows.length}駅／全{stations.total}駅。
            {stations.none > 0 && <>駅の無い{stations.none}杯は含みません。</>}
          </p>
        </div>
      )}

      {tab === "best" && (
        <ol className="space-y-2" data-testid="rank-best">
          {best.map((r, i) => (
            <li key={r.id} className="flex items-center gap-3">
              <span className="w-4 shrink-0 text-xs font-bold text-gray-400">{i + 1}</span>
              <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-800 ring-1 ring-orange-200">
                {starsText(r.stars, r.stars_label)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-gray-800">{r.shop}</span>
                <span className="block truncate text-[0.6875rem] text-gray-400">
                  {r.eaten_on.slice(5).replace("-", "/")}
                  {r.menu ? `・${r.menu}` : ""}
                </span>
              </span>
            </li>
          ))}
          {best.length === 0 && <li className="text-sm text-gray-400">★を付けた杯がまだありません</li>}
        </ol>
      )}

      {tab === "hyaku" && (
        <div data-testid="rank-hyaku">
          {hyakuError && <p className="text-sm text-rose-600">百名店の一覧を読み込めませんでした</p>}
          {!hyakuRows && !hyakuError && <p className="text-sm text-gray-400">読み込み中…</p>}
          {hyakuRows && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <p className="text-sm text-gray-600">
                  ラーメン TOKYO 百名店 2025 ─ 訪問済み{" "}
                  <span className="font-bold text-gray-900">{hyakuRows.doneCount}</span> / 100
                </p>
                <button
                  type="button"
                  onClick={() => setOnlyUnvisited((v) => !v)}
                  className={`ml-auto rounded-full px-2 py-0.5 text-xs font-bold ring-1 active:scale-95 ${
                    onlyUnvisited ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-gray-600 ring-gray-200"
                  }`}
                >
                  {onlyUnvisited ? "まだの店だけ" : "全部"}
                </button>
              </div>
              <ol className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                {hyakuRows.rows
                  .filter((r) => !onlyUnvisited || !r.done)
                  .map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <span className={`w-4 shrink-0 text-center text-xs ${r.done ? "text-emerald-600" : "text-gray-300"}`}>
                        {r.done ? "✓" : "・"}
                      </span>
                      <a
                        href={r.tabelog_url}
                        target="_blank"
                        rel="noreferrer"
                        className={`min-w-0 flex-1 truncate text-sm underline decoration-gray-300 active:opacity-70 ${
                          r.done ? "text-gray-400" : "font-medium text-gray-800"
                        }`}
                      >
                        {r.shop}
                      </a>
                      <span className="shrink-0 text-[0.6875rem] text-gray-500">{r.station ?? ""}</span>
                    </li>
                  ))}
              </ol>
              <p className="pt-2 text-[0.625rem] text-gray-400">
                出典：食べログ（2025年12月2日発表）。行ったかどうかは食べログの店URLで突き合わせ。
              </p>
            </>
          )}
        </div>
      )}

      {tab === "map" && (
        <div data-testid="rank-map">
          {geoError && <p className="text-sm text-rose-600">駅の座標を読み込めませんでした</p>}
          {!geo && !geoError && <p className="text-sm text-gray-400">駅の座標を読み込み中…</p>}
          {geo && mapPoints.length > 0 && <RamenMap points={mapPoints} />}
          {geo && (
            <p className="pt-2 text-[0.625rem] leading-relaxed text-gray-400">
              <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ backgroundColor: C_BOWL }} />
              訪問した駅（丸の大きさ＝杯数）
              <span className="ml-3 mr-2 inline-block h-2.5 w-2.5 rounded-full border-2 border-indigo-600 bg-white align-middle" />
              百名店でまだの店がある駅。
              店の位置ではなく最寄り駅に置いている。
              {geo.unresolved > 0 && <>座標が引けなかった駅が{geo.unresolved}あり、その分は出ていない。</>}
              {geo.deferred > 0 && <>残り{geo.deferred}駅は次に開いた時に引く。</>}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-700 active:scale-95"
    >
      {done ? "コピーしました" : label}
    </button>
  );
}

// 種別のバッジ。タップで選択肢が開き、選ぶと手入力として保存される。
// 「自動」を選ぶと手入力を消して自動判定に戻す。
function BowlTypeBadges({
  log,
  busy,
  onPick,
}: {
  log: Log;
  busy: boolean;
  onPick: (field: "bowl_style" | "bowl_taste", value: string | null) => void;
}) {
  const [open, setOpen] = useState<"bowl_style" | "bowl_taste" | null>(null);
  const style = log.style ?? "ラーメン";
  const taste = log.taste ?? null;
  const manualStyle = !!log.bowl_style;
  const manualTaste = !!log.bowl_taste;

  const chip = (
    label: string,
    manual: boolean,
    field: "bowl_style" | "bowl_taste",
    placeholder: boolean
  ) => (
    <button
      type="button"
      onClick={() => setOpen(open === field ? null : field)}
      className={`rounded-full px-2 py-0.5 text-xs font-bold ring-1 active:scale-95 ${
        placeholder
          ? "bg-white text-gray-400 ring-dashed ring-gray-300"
          : manual
            ? "bg-gray-800 text-white ring-gray-800"
            : "bg-gray-100 text-gray-700 ring-gray-200"
      }`}
      title={manual ? "手で選んだ種別" : "本文からの自動判定（押して直せる）"}
    >
      {label}
    </button>
  );

  const choices = open === "bowl_style" ? BOWL_STYLES : BOWL_TASTES;
  const current = open === "bowl_style" ? style : taste;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[0.625rem] font-bold text-gray-400">種別</span>
        {chip(style, manualStyle, "bowl_style", false)}
        {chip(taste ?? "味は未設定", manualTaste, "bowl_taste", taste == null)}
      </div>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-gray-50 p-2">
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              onClick={() => {
                onPick(open, c);
                setOpen(null);
              }}
              className={`rounded-full px-2 py-0.5 text-xs font-medium active:scale-95 disabled:opacity-50 ${
                c === current ? "bg-indigo-600 text-white" : "bg-white text-gray-700 ring-1 ring-gray-200"
              }`}
            >
              {c}
            </button>
          ))}
          {(open === "bowl_style" ? manualStyle : manualTaste) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onPick(open, null);
                setOpen(null);
              }}
              className="rounded-full px-2 py-0.5 text-xs text-gray-500 underline active:scale-95 disabled:opacity-50"
            >
              自動に戻す
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LogCard({ log, onChanged }: { log: Log; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 引用リポストの引用元URL。空なら通常の投稿。
  const [quote, setQuote] = useState("");
  // 写真の拡大表示（タップした1枚のパス）
  const [zoom, setZoom] = useState<string | null>(null);
  // 「点数と写真を直す」パネルの開閉と、点数の入力値
  const [editing, setEditing] = useState(false);
  const [scoreInput, setScoreInput] = useState(
    log.score != null ? log.score.toFixed(1) : ""
  );
  const [starsInput, setStarsInput] = useState(
    log.stars != null ? String(Number(log.stars)) : ""
  );

  const photos = log.photo_urls ?? [];

  async function call(path: string, body: unknown, what: string) {
    setBusy(what);
    setErr(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `失敗しました（${res.status}）`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "失敗しました");
    } finally {
      setBusy(null);
    }
  }

  // 点数・写真の後付け。/api/ramen/update は変更したい項目だけを受けるので、
  // 点数を直すときに写真を送らない（送ると配列ごと入れ替わってしまう）。
  async function patch(body: Record<string, unknown>, what: string) {
    setBusy(what);
    setErr(null);
    try {
      const res = await fetch("/api/ramen/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: log.id, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `失敗しました（${res.status}）`);
      onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "失敗しました");
      return false;
    } finally {
      setBusy(null);
    }
  }

  // 後から写真を足す。Storageへ1枚ずつ上げてパスを集め、最後に一度だけ行へ書く。
  // 1枚ごとに行を更新すると、途中で失敗したときに何枚入ったのか分からなくなる。
  async function addPhotos(picked: File[]) {
    if (picked.length === 0) return;
    setBusy("photo");
    setErr(null);
    try {
      const paths: string[] = [];
      for (let i = 0; i < picked.length; i++) {
        const { dataUrl, type } = await downscaleToJpeg(picked[i]);
        const approxBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        if (approxBytes > 4_000_000) {
          throw new Error(
            `${i + 1}枚目が大きすぎます（約${(approxBytes / 1024 / 1024).toFixed(1)}MB）`
          );
        }
        const up = await fetch("/api/ramen/photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl, content_type: type, id: log.id }),
        });
        // 413はJSONで返らない。素の json() だと原因が写真だと分からなくなる。
        const upText = await up.text();
        let upJson: { path?: string; error?: string } = {};
        try {
          upJson = JSON.parse(upText);
        } catch {
          throw new Error(
            up.status === 413
              ? `${i + 1}枚目が大きすぎて送れませんでした（サーバー上限）`
              : `${i + 1}枚目の保存に失敗しました（${up.status}）`
          );
        }
        if (!up.ok || !upJson.path) {
          throw new Error(upJson?.error ?? "写真の保存に失敗しました");
        }
        paths.push(upJson.path);
      }
      setBusy(null);
      await patch({ add_photos: paths }, "photo");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "写真の保存に失敗しました");
      setBusy(null);
    }
  }

  // 記録の削除。写真の保存や下書き生成の途中で止まった半端な行を片付けるためのもの。
  // 消えると戻せないので、店名を出して一度確かめる。Xへ投稿済みのものはサーバー側が
  // 409で止めるので、その時だけ「Xの投稿だけ残る」ことを承知のうえで押し直してもらう。
  async function remove(force = false) {
    const label = `${fmtDate(log.eaten_on)}の「${log.shop || "無題"}」`;
    if (!force && !window.confirm(`${label}を削除します。写真も一緒に消えます。\n元に戻せません。よろしいですか？`)) {
      return;
    }
    setBusy("del");
    setErr(null);
    try {
      const res = await fetch(
        `/api/ramen?id=${log.id}${force ? "&force=true" : ""}`,
        { method: "DELETE" }
      );
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        if (window.confirm(`${label}は既にXへ投稿済みです。\n削除するとXの投稿だけが残ります。それでも消しますか？`)) {
          setBusy(null);
          return remove(true);
        }
        return;
      }
      if (!res.ok) throw new Error(json?.error ?? `削除に失敗しました（${res.status}）`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-bold text-gray-900">{fmtDate(log.eaten_on)}</span>
        {log.bowl_label && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
            style={{ backgroundColor: C_BOWL }}
          >
            {log.bowl_label}
          </span>
        )}
        {log.status !== "posted" && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
            {log.status === "captured" ? "文章まち" : "投稿まち"}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {/* 自分の★（写真のメモ欄に手書きしてあるもの）が主。
              食べログの点数は別物なので、並べて出して混ぜない。 */}
          {starsText(log.stars, log.stars_label) && (
            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-800 ring-1 ring-orange-200">
              {starsText(log.stars, log.stars_label)}
            </span>
          )}
          {log.score != null && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200">
              食べログ{log.score.toFixed(1)}
              {log.score_time && (
                <span className="ml-1 font-normal text-amber-600">{log.score_time}</span>
              )}
            </span>
          )}
        </span>
      </div>

      <h3 className="mt-2 text-base font-bold leading-snug text-gray-900">{log.shop}</h3>
      <p className="mt-0.5 text-xs text-gray-500">
        {[log.area, log.genre].filter(Boolean).join(" / ")}
        {log.visit_count != null && (
          <span className="ml-1 text-gray-400">・{log.visit_count}回目</span>
        )}
      </p>

      {/* 種別（形態・味）。自動判定はメニュー欄や本文の言葉に引きずられることが
          あるので、押せば直せる。手入力は自動判定より必ず優先される。 */}
      <BowlTypeBadges
        log={log}
        busy={busy === "type"}
        onPick={(field, value) => patch({ [field]: value }, "type")}
      />

      {log.menu && (
        <p className="mt-2 text-sm font-medium text-gray-700">
          🍜 {log.menu}
          {log.price != null && (
            <span className="ml-1 text-gray-400">{log.price.toLocaleString()}円</span>
          )}
        </p>
      )}

      {photos.length > 0 && (
        <div
          className={`mt-3 grid gap-1.5 ${
            photos.length === 1 ? "grid-cols-1" : "grid-cols-3"
          }`}
        >
          {photos.map((p, i) => (
            <button
              key={p}
              type="button"
              onClick={() => setZoom(p)}
              className="overflow-hidden rounded-lg active:opacity-80"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoUrl(p, photos.length === 1 ? 1280 : 480)}
                alt={`${log.shop} の写真 ${i + 1}`}
                loading="lazy"
                decoding="async"
                className={`w-full object-cover ${
                  photos.length === 1 ? "max-h-72" : "aspect-square"
                }`}
              />
            </button>
          ))}
        </div>
      )}

      {log.memo && (
        <p className="mt-2 rounded-lg bg-gray-50 p-2 text-sm leading-relaxed text-gray-600">
          <span className="mr-1 text-xs font-bold text-gray-400">メモ</span>
          {log.memo}
        </p>
      )}

      {log.title && (
        <p className="mt-2 text-sm font-bold leading-snug text-gray-800">「{log.title}」</p>
      )}
      {log.excerpt && <p className="mt-1 text-sm leading-relaxed text-gray-600">{log.excerpt}</p>}

      {log.x_excerpt && (
        <p
          className="mt-2 border-l-2 pl-3 text-sm leading-relaxed text-gray-500"
          style={{ borderColor: C_X }}
        >
          {log.x_excerpt}
        </p>
      )}

      {/* 下書きができている一杯だけ、貼り付け用の本文と投稿ボタンを出す */}
      {(log.draft_tabelog || log.draft_x) && (
        <div className="mt-3 space-y-3 rounded-xl bg-gray-50 p-3">
          {log.draft_tabelog && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-bold text-orange-700">食べログ用</span>
                <CopyButton text={log.draft_tabelog} label="本文をコピー" />
                <a
                  href={log.tabelog_shop_url ?? "https://tabelog.com/"}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-indigo-500 underline active:opacity-70"
                >
                  店ページを開く →
                </a>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {log.draft_tabelog}
              </p>
            </div>
          )}
          {log.draft_x && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-bold text-violet-700">X用</span>
                {/* 実際に送る本文＝店名タグ込み。見えている文と送る文がズレると、
                    コピーして手で投げたときにタグだけ落ちる。 */}
                <CopyButton
                  text={withShopHashtag(log.draft_x, log.shop)}
                  label="本文をコピー"
                />
                {!log.x_url && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      // 公開かつ取り消せない操作。隣がコピーボタンなので、押し間違いをここで止める。
                      const q = quote.trim();
                      const msg = q
                        ? "この本文と写真を、貼った投稿への引用リポストとしてXへ公開します。取り消せません。"
                        : "この本文と写真をXへ公開します。取り消せません。";
                      if (!window.confirm(msg)) return;
                      call("/api/ramen/post-x", { id: log.id, quote: q || undefined }, "x");
                    }}
                    className="rounded-full bg-violet-600 px-3 py-1 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
                  >
                    {busy === "x" ? "投稿中…" : quote.trim() ? "引用してXへ投稿" : "Xへ投稿"}
                  </button>
                )}
              </div>
              {/* 引用リポスト。URLは本文には入れず quote_tweet_id で送るので、
                  本文にURLを貼る方式と違って課金の跳ね上がりガードに引っかからない。 */}
              {!log.x_url && (
                <div className="mb-2">
                  <input
                    type="url"
                    inputMode="url"
                    value={quote}
                    onChange={(e) => setQuote(e.target.value)}
                    placeholder="引用リポストするならXの投稿URLを貼る（任意）"
                    className="w-full rounded-lg border border-gray-300 px-2 py-1 text-xs"
                  />
                </div>
              )}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {withShopHashtag(log.draft_x, log.shop)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 点数と写真を後から直すところ。店名・日付・杯番号は触らない
          （食べログ側の取り込みと突合しているので、ここで動かすと合わなくなる）。 */}
      {editing && (
        <div className="mt-3 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div>
            <label className="block text-xs font-bold text-amber-800">
              自分の★（半分刻み）
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {STAR_CHOICES.map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => patch({ stars: n }, "stars")}
                  className={`rounded-full px-2 py-1 text-xs font-bold active:scale-95 disabled:opacity-50 ${
                    log.stars === n
                      ? "bg-orange-600 text-white"
                      : "bg-white text-orange-700 ring-1 ring-orange-200"
                  }`}
                >
                  {n.toFixed(1)}
                </button>
              ))}
              {log.stars != null && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => patch({ stars: null }, "stars")}
                  className="ml-1 text-xs text-orange-700 underline active:opacity-70 disabled:opacity-40"
                >
                  消す
                </button>
              )}
            </div>
            {/* 3.75 のように記号で書けない値も付けるので、細かく入れる口も置く */}
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="0.25"
                min="0"
                max="5"
                value={starsInput}
                onChange={(e) => setStarsInput(e.target.value)}
                placeholder="例：3.75"
                className="w-24 rounded-lg border border-orange-300 bg-white px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => patch({ stars: starsInput.trim() }, "stars")}
                className="rounded-full bg-orange-600 px-3 py-1 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
              >
                細かく入れる
              </button>
            </div>
            <p className="mt-1 text-[0.625rem] text-amber-700">
              {busy === "stars"
                ? "保存中…"
                : log.stars != null
                  ? `いま ${starsText(log.stars, log.stars_label)}（${Number(log.stars)}）`
                  : "ボタンは押すとその場で保存されます"}
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-amber-800">
              食べログに付けた点数（0.0〜5.0）
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0"
                max="5"
                value={scoreInput}
                onChange={(e) => setScoreInput(e.target.value)}
                placeholder="例：3.8"
                className="w-24 rounded-lg border border-amber-300 bg-white px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => patch({ score: scoreInput.trim() }, "score")}
                className="rounded-full bg-amber-600 px-3 py-1 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
              >
                {busy === "score" ? "保存中…" : "点数を保存"}
              </button>
              {log.score != null && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setScoreInput("");
                    patch({ score: null }, "score");
                  }}
                  className="text-xs text-amber-700 underline active:opacity-70 disabled:opacity-40"
                >
                  点数を消す
                </button>
              )}
            </div>
            <p className="mt-1 text-[0.625rem] text-amber-700">
              ★とは別の欄。平均点のタイルはこちらを見ています
            </p>
          </div>

          <div>
            <label className="block">
              <span className="inline-block w-full cursor-pointer rounded-lg border border-dashed border-amber-400 bg-white px-3 py-2 text-center text-sm font-bold text-amber-800 active:bg-amber-100">
                {busy === "photo" ? "写真を上げています…" : "📷 この一杯に写真を足す"}
              </span>
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={busy !== null}
                onChange={(e) => {
                  // FileList は value を空にすると中身も消える。先に配列へ写す。
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  addPhotos(picked);
                }}
              />
            </label>
            <p className="mt-1 text-[0.625rem] text-amber-700">
              iPhoneの写真アプリから複数まとめて選べます（1杯12枚まで・Xに出るのは先頭4枚）
            </p>
          </div>

          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <span key={p} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoUrl(p, 480)}
                    alt={`写真 ${i + 1}`}
                    loading="lazy"
                    className="h-16 w-16 rounded-lg object-cover"
                  />
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm("この写真を外します。元に戻せません。")) return;
                      patch({ remove_photo: p }, "photo");
                    }}
                    className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-gray-900 text-xs font-bold text-white disabled:opacity-40"
                    aria-label="この写真を外す"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {log.status === "captured" && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => call("/api/ramen/draft", { id: log.id }, "draft")}
            className="rounded-full bg-gray-900 px-3 py-1 text-xs font-bold text-white active:scale-95 disabled:opacity-50"
          >
            {busy === "draft" ? "書いています…" : "文章を作る"}
          </button>
        )}
        {log.tabelog_url && (
          <a
            href={log.tabelog_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700 ring-1 ring-orange-200 active:opacity-70"
          >
            食べログ口コミ →
          </a>
        )}
        {log.x_url ? (
          <a
            href={log.x_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200 active:opacity-70"
          >
            X投稿 →
          </a>
        ) : (
          <span className="rounded-full bg-gray-50 px-3 py-1 text-xs text-gray-400 ring-1 ring-gray-200">
            X未リンク
          </span>
        )}
        {/* 手元の写真（photo_urls）と、食べログ口コミに付けた枚数（photo_count）は別物。
            画面で見られるのは手元のぶんだけなので、そちらを優先して出す。 */}
        {photos.length > 0 ? (
          <span className="text-xs text-gray-400">📷 {photos.length}枚</span>
        ) : (
          log.photo_count > 0 && (
            <span className="text-xs text-gray-300">📷 食べログに{log.photo_count}枚</span>
          )
        )}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={`rounded-full px-3 py-1 text-xs font-bold active:scale-95 ${
            editing
              ? "bg-amber-600 text-white"
              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
          }`}
        >
          {editing ? "閉じる" : "✏️ 点数・写真"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => remove()}
          aria-label="この一杯を削除"
          className="ml-auto rounded-full px-2 py-1 text-xs text-gray-300 transition active:bg-gray-100 active:text-rose-500 disabled:opacity-40"
        >
          {busy === "del" ? "削除中…" : "🗑 削除"}
        </button>
      </div>

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(zoom, 1280)}
            alt={log.shop}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </article>
  );
}

const MAX_PHOTOS = 4;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

// 送る前に必ず縮める。
//
// iPhoneの写真は1枚2〜5MBあり、base64にすると約1.33倍に膨らむ。Vercelの
// リクエスト上限は4.5MBなので、原寸のまま送ると1枚でも超えて 413 が返る
// （本文だけの投稿は通るのに写真つきだけ落ちる、という症状の正体がこれ）。
// Xの上限5MBにも同時に効く。
//
// canvas に描き直すので、iPhoneのHEICもJPEGになる。XはHEICを受け付けないため
// この変換自体にも意味がある。
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;

async function downscaleToJpeg(file: File): Promise<{ dataUrl: string; type: string }> {
  const original = await fileToDataUrl(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("画像を読み込めませんでした"));
      el.src = original;
    });

    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvasが使えませんでした");
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), type: "image/jpeg" };
  } catch {
    // 縮小に失敗しても、そのまま送って上限に当たるよりはマシ……ではない。
    // ここで諦めて原寸を返すと結局413になるので、呼び出し側で大きさを見て弾く。
    return { dataUrl: original, type: file.type || "image/jpeg" };
  }
}

function CaptureForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [shop, setShop] = useState("");
  const [menu, setMenu] = useState("");
  const [memo, setMemo] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 保存できたことを、その場で即座に伝えるための控え。
  // 一覧の再取得（/api/ramen は219件・約187KBあり、実測0.5〜2.9秒かかる）を
  // 待ってから知らせると、その間ずっと画面が変わらず「登録できていない」と
  // 誤解される。実際にそう報告を受けた（2026-08-28）。
  const [saved, setSaved] = useState<string | null>(null);

  // 選んだ写真をその場で見せる。反映されたことが目で分かるようにするため。
  useEffect(() => {
    const urls = photos.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [photos]);

  // 受け取るのは File[]。FileList のまま渡すと、onChange で入力欄を空にした時点で
  // 中身が消え、後から走る setState が空を見てしまう（iOS Safariで実際に発生）。
  function onPickPhotos(picked: File[]) {
    if (picked.length === 0) return;
    setPhotos((prev) => [...prev, ...picked].slice(0, MAX_PHOTOS));
  }

  function removePhoto(i: number) {
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    if (!shop.trim()) {
      setErr("店名を入れてください");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // 写真は先にStorageへ上げてパスだけ受け取り、その後の記録本体にpathを渡す
      // （Xへの投稿時にはこのpathからサーバーが写真を取り出す）。
      const photo_urls: string[] = [];
      for (let i = 0; i < photos.length; i++) {
        const file = photos[i];
        const { dataUrl, type } = await downscaleToJpeg(file);
        // base64 の実バイト数で見張る。Vercelの上限4.5MBに当たると、
        // 返ってくるのはJSONではないので下の parse も失敗して原因が分からなくなる。
        const approxBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        if (approxBytes > 4_000_000) {
          throw new Error(
            `${i + 1}枚目の写真が大きすぎます（約${(approxBytes / 1024 / 1024).toFixed(1)}MB）。` +
              `別の写真を選ぶか、サイズを小さくしてください。`
          );
        }
        const up = await fetch("/api/ramen/photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl, content_type: type }),
        });
        // 413などサーバー手前で弾かれると本文がJSONではない。素の json() だと
        // 「Unexpected token」になって、写真が原因だと分からなくなる。
        const upText = await up.text();
        let upJson: { path?: string; error?: string } = {};
        try {
          upJson = JSON.parse(upText);
        } catch {
          throw new Error(
            up.status === 413
              ? `${i + 1}枚目の写真が大きすぎて送れませんでした（サーバー上限）`
              : `${i + 1}枚目の写真の保存に失敗しました（${up.status}）`
          );
        }
        if (!up.ok) throw new Error(upJson?.error ?? "写真の保存に失敗しました");
        if (!upJson.path) throw new Error("保存先のパスが返りませんでした");
        photo_urls.push(upJson.path);
      }

      const res = await fetch("/api/ramen/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, menu, memo, photo_urls }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "記録に失敗しました");
      // ★一覧の再取得を待たずに、先に「入った」ことを知らせる。
      //   待たせると画面が数秒変わらず、二重登録の原因になる。
      setSaved(shop.trim());
      setShop("");
      setMenu("");
      setMemo("");
      setPhotos([]);
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "記録に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-6">
        {saved && (
          <div className="mb-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">
            ✅ 「{saved}」を記録しました。下の一覧に出るまで少しかかります。
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
          className="w-full rounded-2xl border border-dashed border-orange-300 bg-orange-50 p-4 text-sm font-bold text-orange-700 active:bg-orange-100"
        >
          ＋ 一杯を記録する
        </button>
      </div>
    );
  }

  return (
    <Section>
      <ChartTitle color={C_BOWL} title="一杯を記録" hint="文章は後から生成する" />
      <div className="space-y-2">
        <input
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          placeholder="店名（必須）"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />
        <input
          value={menu}
          onChange={(e) => setMenu(e.target.value)}
          placeholder="注文したもの"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={4}
          placeholder="その場の一言（音声入力でOK）。ここが文章の一次情報になります"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
        />

        <div className="space-y-1">
          <label className="block">
            <span className="inline-block w-full cursor-pointer rounded-xl border border-dashed border-gray-300 px-3 py-2 text-center text-sm text-gray-500 active:bg-gray-50">
              📷 写真を選ぶ（最大{MAX_PHOTOS}枚・Xに添付されます）
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              // display:noneだとiOS Safariでchangeイベントが発火しないことがあるため、
              // 要素としては存在させたまま見た目だけ消す（sr-only）。
              className="sr-only"
              disabled={photos.length >= MAX_PHOTOS}
              onChange={(e) => {
                // value を空にすると FileList の中身も消える。setState は後から走るので、
                // 実体をここで配列に写しておかないと空を渡すことになる。
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                onPickPhotos(picked);
              }}
            />
          </label>
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="w-full text-xs font-bold text-orange-700">
                写真 {photos.length}枚を添付します
              </span>
              {photos.map((f, i) => (
                <span key={i} className="relative">
                  {previews[i] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previews[i]}
                      alt={f.name}
                      className="h-16 w-16 rounded-lg object-cover"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-gray-900 text-xs font-bold text-white"
                    aria-label="この写真を外す"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {err && <p className="text-xs text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex-1 rounded-xl bg-gray-900 py-2 text-sm font-bold text-white active:scale-95 disabled:opacity-50"
          >
            {saving ? "保存中…" : "記録する"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-xl px-4 py-2 text-sm text-gray-500"
          >
            やめる
          </button>
        </div>
      </div>
    </Section>
  );
}

// month は同一ページ下部の月セレクトと同じ状態（ページ側で1つに持つ）。
// ここに別のuseStateを置くと「上で選んだ月」と「下で選んだ月」がズレる。
function MonthlyDrafts({
  months,
  month,
  onMonthChange,
}: {
  months: string[];
  month: string;
  onMonthChange: (m: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    setDrafts(null);
    try {
      const res = await fetch("/api/ramen/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "生成に失敗しました");
      setDrafts(json.drafts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "生成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section>
      <ChartTitle color={C_X} title="月次振り返り（Xの4本立て）" hint="まとめ / 特徴 / 金賞・殿堂 / 思い出の4枚" />
      <div className="flex items-center gap-2">
        <select
          value={month}
          onChange={(e) => onMonthChange(e.target.value)}
          className="rounded-xl border border-gray-200 px-3 py-2 text-sm"
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {m.replace("-", "年")}月
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={generate}
          disabled={busy || !month}
          className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-bold text-white active:scale-95 disabled:opacity-50"
        >
          {busy ? "書いています…" : "4本つくる"}
        </button>
      </div>
      {err && <p className="mt-2 text-sm text-rose-600">{err}</p>}
      {drafts && (
        <div className="mt-4 space-y-4">
          {MONTHLY_KINDS.map((k) =>
            drafts[k.key] ? (
              <div key={k.key} className="rounded-xl bg-gray-50 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-xs font-bold text-gray-700">{k.label}</span>
                  <CopyButton text={drafts[k.key]} label="コピー" />
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {drafts[k.key]}
                </p>
              </div>
            ) : null
          )}
        </div>
      )}
    </Section>
  );
}

export default function RamenPage() {
  // 取得は2段構え。
  //
  // 1段目（view=list）… 全行の軽い列。積み上げ・月次グラフ・月の一覧を出す
  // 2段目（view=text）… 実際にカードを描く行だけを全列で。未処理＋選んだ月
  //
  // 以前は全230件を全列（339KB）で1回取っていた。描くのは未処理と1か月ぶんだけ
  // なのに全部の下書き本文を運んでいて、混み合うと10秒超・タイムアウト・500で
  // 「ラーメン記録の取得に失敗しました」になっていた（2026-09-13 実測）。
  const [base, setBase] = useState<Log[] | null>(null);
  const [texts, setTexts] = useState<Record<number, Log>>({});
  const [error, setError] = useState<string | null>(null);
  // 2段目だけが失敗した状態。画面は出せるので、赤いエラー箱とは分けて持つ
  const [textError, setTextError] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("ramen");
  const [month, setMonth] = useState<string>("");

  // 再取得中かどうか。初回の loading とは別に持つ。
  // 2回目以降は items が既にあるため loading が false のままで、
  // 数秒かかる再取得の間「何も起きていない」ように見えていた（2026-08-28）。
  const [refreshing, setRefreshing] = useState(false);

  // 子（記録フォーム・カードの操作）から「取り直して」と言われた回数。
  // 増えると1段目・2段目の両方が走る
  const [reloadCount, setReloadCount] = useState(0);
  const load = useCallback(() => setReloadCount((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setError(null);
      setRefreshing(true);
      try {
        const res = await fetch("/api/ramen?view=list", { cache: "no-store" });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d?.error ?? `status ${res.status}`);
        if (alive) setBase(d.items ?? []);
      } catch {
        if (alive) setError("ラーメン記録の取得に失敗しました");
      } finally {
        if (alive) setRefreshing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadCount]);

  useEffect(() => {
    if (!month) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/ramen?view=text&month=${month}`, {
          cache: "no-store",
        });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d?.error ?? `status ${res.status}`);
        const map: Record<number, Log> = {};
        for (const row of d.items ?? []) map[row.id] = row;
        if (alive) {
          setTexts(map);
          setTextError(false);
        }
      } catch {
        // ここが失敗しても、1段目で出した積み上げと一覧の骨格は残る。
        // 本文が出ないことだけを伝えて、画面ごと消さない
        if (alive) setTextError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [month, reloadCount]);

  // 軽い行に、取れた本文を重ねる。描かない行は本文が無いままでよい
  const items = useMemo(
    () => (base ? base.map((r) => ({ ...r, ...(texts[r.id] ?? {}) })) : null),
    [base, texts]
  );

  const months = useMemo(() => {
    const set = new Set((items ?? []).map((i) => i.eaten_on.slice(0, 7)));
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [items]);

  useEffect(() => {
    if (!month && months.length > 0) setMonth(months[0]);
  }, [months, month]);

  const stats = useMemo(() => {
    const all = items ?? [];
    const ramen = all.filter((i) => i.is_ramen);
    const bowls = ramen.map((i) => i.bowl_no).filter((n): n is number => n != null);
    const scored = all.map((i) => i.score).filter((s): s is number => s != null);
    const posted = ramen.filter((i) => i.x_url).length;
    return {
      latestBowl: bowls.length ? Math.max(...bowls) : null,
      ramenCount: ramen.length,
      total: all.length,
      avgScore: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      posted,
      postRate: ramen.length ? Math.round((posted / ramen.length) * 100) : null,
      // 写真がこの画面で見られる杯数。iPhoneのアルバムから移し終えたかの目印になる。
      withPhoto: all.filter((i) => (i.photo_urls ?? []).length > 0).length,
      noStars: all.filter((i) => i.stars == null).length,
    };
  }, [items]);

  const monthly = useMemo(() => {
    const map = new Map<string, { ym: string; ramen: number; other: number }>();
    for (const i of items ?? []) {
      const ym = i.eaten_on.slice(0, 7);
      const row = map.get(ym) ?? { ym, ramen: 0, other: 0 };
      if (i.is_ramen) row.ramen += 1;
      else row.other += 1;
      map.set(ym, row);
    }
    return Array.from(map.values()).sort((a, b) => (a.ym < b.ym ? 1 : -1));
  }, [items]);

  // ランキングの対象はラーメンだけ（うどん・カレーが混ざると杯数が読めない）
  const ramenOnly = useMemo(() => (items ?? []).filter((i) => i.is_ramen), [items]);

  // 未処理（文章まち・投稿まち）はいつでも最上段。埋もれると運用が止まるため。
  const pending = useMemo(
    () => (items ?? []).filter((i) => i.status !== "posted"),
    [items]
  );

  const shown = useMemo(() => {
    let all = (items ?? []).filter((i) => i.status === "posted");
    if (month) all = all.filter((i) => i.eaten_on.slice(0, 7) === month);
    // ラーメン以外を出すのは「すべて」を選んだときだけ。
    // 「X未リンク」でうどんが戻ってくると、絞ったつもりが絞れていない
    if (filter !== "all") all = all.filter((i) => i.is_ramen);
    if (filter === "no_x") all = all.filter((i) => !i.x_url);
    return all;
  }, [items, filter, month]);

  const loading = !items && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">🍜 ラーメン</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          食べログ（mirainotakara）とX（@0kara1_man）を一杯ごとに1本の線でつなぎ、
          記録から投稿までをここで回す
        </p>
      </header>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <p>{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-full bg-rose-600 px-3 py-1 text-xs font-bold text-white active:scale-95"
          >
            再読み込み
          </button>
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />
          ))}
        </div>
      )}

      {/* 下書き・メモだけが取れなかったとき。積み上げと一覧は出ているので、
          画面を消さずに「本文が欠けている」ことだけを伝える */}
      {textError && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>下書き・メモを読み込めませんでした（記録そのものは出ています）</span>
          <button
            type="button"
            onClick={load}
            className="ml-auto shrink-0 rounded-full bg-amber-600 px-2 py-0.5 font-bold text-white active:scale-95"
          >
            取り直す
          </button>
        </div>
      )}

      {/* 記録0件や取得失敗の日でも「一杯を記録する」だけは失わないよう、
          一覧の条件分岐の外でも出す（一覧がある時は従来どおり積み上げの下に出る）。 */}
      {!loading && (!items || items.length === 0) && <CaptureForm onSaved={load} />}

      {items && items.length > 0 && (
        <>
          <Section>
            <ChartTitle
              color={C_BOWL}
              title="いまの積み上げ"
              hint={
                refreshing
                  ? "更新中…"
                  : `記録 ${stats.total}件・写真つき ${stats.withPhoto}杯・★なし ${stats.noStars}杯`
              }
            />
            <div className="flex gap-2">
              {/* 通算杯数は「食べたもの全部」への入口。過去を遡るのに
                  この画面を延々スクロールさせないため（2026-09-13）。 */}
              <Link href="/ramen/all" className="flex-1 active:opacity-70">
                <StatTile
                  label="通算杯数"
                  value={stats.latestBowl != null ? `${stats.latestBowl}` : "—"}
                  sub="杯目 ／ 全部見る →"
                  color={C_BOWL}
                />
              </Link>
              <StatTile
                label="ラーメン"
                value={`${stats.ramenCount}`}
                sub={`／記録${stats.total}件`}
              />
              <StatTile
                label="平均点"
                value={stats.avgScore != null ? stats.avgScore.toFixed(2) : "—"}
                sub="自分の点数"
              />
              <StatTile
                label="X投稿率"
                value={stats.postRate != null ? `${stats.postRate}%` : "—"}
                sub={`${stats.posted}／${stats.ramenCount}杯`}
                color={C_X}
              />
            </div>
          </Section>

          <CaptureForm onSaved={load} />

          {pending.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-bold text-gray-500">🕒 いま手を動かす一杯</h2>
              <div className="space-y-3">
                {pending.map((log) => (
                  <LogCard key={log.id} log={log} onChanged={load} />
                ))}
              </div>
            </div>
          )}

          <Section>
            <ChartTitle color={C_BOWL} title="月別の杯数" />
            <MonthlyBars rows={monthly} />
          </Section>

          <RamenRankings ramen={ramenOnly} />

          <MonthlyDrafts months={months} month={month} onMonthChange={setMonth} />

          <div className="mb-3 mt-8 flex flex-wrap items-center gap-2">
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-medium text-gray-700"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {m.replace("-", "年")}月
                </option>
              ))}
            </select>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
                  filter === f.key
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-600 ring-1 ring-gray-200"
                }`}
              >
                {f.label}
              </button>
            ))}
            <span className="ml-auto text-xs text-gray-400">{shown.length}件</span>
          </div>

          <div className="space-y-3">
            {shown.map((log) => (
              <LogCard key={log.id} log={log} onChanged={load} />
            ))}
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-gray-400">
            食べログ{" "}
            <a
              href="https://tabelog.com/rvwr/000776165/"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 underline active:opacity-70"
            >
              mirainotakara
            </a>{" "}
            ／ X{" "}
            <a
              href="https://x.com/0kara1_man"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 underline active:opacity-70"
            >
              @0kara1_man
            </a>
          </p>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホームに戻る
        </Link>
      </div>
    </main>
  );
}
