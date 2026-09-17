"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type {
  HojinQaCategory,
  HojinQaConstraint,
  HojinQaData,
  HojinQaItem,
} from "@/lib/hojinQa/types";

// 法人請求QA検索の画面本体。
// 商談中に片手で開き、相手が何か言った直後に「相手の発言・キーワード」で引く道具。
// 通信は一切しない（data は page.tsx から渡される）。検索・絞り込み・展開状態の
// URL ハッシュ保存・コピー・印刷をこのファイルだけで完結させる。

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const CATEGORIES: HojinQaCategory[] = ["A", "B", "C", "D"];

/** チップに出す短い呼び名（data.categories[cat].name は長いので） */
const CATEGORY_SHORT: Record<HojinQaCategory, string> = {
  A: "職員に訴求",
  B: "やらない理由",
  C: "議員に訴求",
  D: "議員と職員",
};

/** 使用条件チップの並び順。データに無いものは出さない（ID の決め打ちはしない） */
const CONSTRAINT_ORDER: HojinQaConstraint[] = ["委託限定", "規模限定", "会計・出納部門向け"];

/** ID バッジと選択中チップに使う控えめなカテゴリ色。カード全体には塗らない */
const CATEGORY_BADGE: Record<HojinQaCategory, string> = {
  A: "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100",
  B: "bg-rose-100 text-rose-900 dark:bg-rose-900/50 dark:text-rose-100",
  C: "bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100",
  D: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100",
};

const CATEGORY_CHIP_ON: Record<HojinQaCategory, string> = {
  A: "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-700 dark:bg-sky-900/50 dark:text-sky-100",
  B: "border-rose-300 bg-rose-100 text-rose-900 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-100",
  C: "border-violet-300 bg-violet-100 text-violet-900 dark:border-violet-700 dark:bg-violet-900/50 dark:text-violet-100",
  D: "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-100",
};

/** 横スクロールするチップ列。PC で出るスクロールバーは隠す（iPhone では元々出ない） */
const CHIP_ROW =
  "-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

const CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs leading-none whitespace-nowrap select-none";
const CHIP_OFF =
  "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";
const CHIP_NEUTRAL_ON =
  "border-slate-800 bg-slate-800 text-white dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900";

const MARK_CLASS = "rounded-sm bg-yellow-200 px-0 text-inherit dark:bg-yellow-500/40";

/** 話者マーカー（カテゴリ D の本文にだけ現れる） */
const SPEAKER_RE = /^\*\*【(.+?)】\*\*$/;
/** 行内の **太字**。行をまたぐ太字はデータに無い（生成時に確認済み） */
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

// ---------------------------------------------------------------------------
// 検索の正規化
// ---------------------------------------------------------------------------

/** 検索時に無視する文字（空白・カンマ・読点）。"1,330" と "1330" を同じに扱うため */
function isIgnorable(ch: string): boolean {
  return /[\s,、，]/.test(ch);
}

type Normalized = {
  /** 正規化後の文字列（NFKC → 小文字 → 空白等の除去） */
  text: string;
  /** 正規化後の各 UTF-16 単位が、元文字列のどこから来たか（開始位置） */
  starts: number[];
  /** 同じく終了位置（排他的）。ハイライトの範囲を元文字列に戻すのに使う */
  ends: number[];
};

function normalizeWithMap(src: string): Normalized {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (const ch of src) {
    const n = ch.normalize("NFKC").toLowerCase();
    for (const c of n) {
      if (!isIgnorable(c)) {
        text += c;
        for (let k = 0; k < c.length; k++) {
          starts.push(pos);
          ends.push(pos + ch.length);
        }
      }
    }
    pos += ch.length;
  }
  return { text, starts, ends };
}

function normalizeText(src: string): string {
  return normalizeWithMap(src).text;
}

/** 元文字列の中で、正規化クエリに一致する範囲（元文字列の index）を返す */
function findRanges(src: string, nq: string): Array<[number, number]> {
  if (!nq) return [];
  const { text, starts, ends } = normalizeWithMap(src);
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(nq, from);
    if (i < 0) break;
    out.push([starts[i], ends[i + nq.length - 1]]);
    from = i + nq.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文字列の描画（太字・ハイライト・複数行）
// ---------------------------------------------------------------------------

/** プレーン文字列に <mark> を差し込む */
function highlight(text: string, nq: string): ReactNode {
  const ranges = findRanges(text, nq);
  if (ranges.length === 0) return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([s, e], i) => {
    if (s > last) nodes.push(text.slice(last, s));
    nodes.push(
      <mark key={i} className={MARK_CLASS}>
        {text.slice(s, e)}
      </mark>,
    );
    last = e;
  });
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

/** 1行ぶんの文字列を、**太字** を <strong> にしつつハイライト付きで描く */
function renderInline(text: string, nq: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const re = new RegExp(BOLD_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(<Fragment key={k++}>{highlight(text.slice(last, m.index), nq)}</Fragment>);
    }
    parts.push(
      <strong key={k++} className="font-semibold">
        {highlight(m[1], nq)}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Fragment key={k++}>{highlight(text.slice(last), nq)}</Fragment>);
  }
  return <>{parts}</>;
}

/** 複数行の文字列を、改行と行頭の全角スペースを保ったまま描く */
function renderLines(text: string, nq: string): ReactNode {
  return text.split("\n").map((line, i) => (
    <span key={i} className="block min-h-[1em] whitespace-pre-wrap">
      {renderInline(line, nq)}
    </span>
  ));
}

/** コピー用に **太字** 記法だけ外す（改行はそのまま） */
function stripMarkdown(text: string): string {
  return text.replace(new RegExp(BOLD_RE.source, "g"), "$1");
}

// ---------------------------------------------------------------------------
// カテゴリ D の本文を話者ブロックに分ける
// ---------------------------------------------------------------------------

type Speaker = "giin" | "shokuin" | null;

type SpeakerBlock = {
  /** 例：議員の問い。マーカーが無い先頭部分は null */
  label: string | null;
  speaker: Speaker;
  lines: string[];
};

function speakerOf(label: string): Speaker {
  if (label.includes("職員")) return "shokuin";
  if (label.includes("議員")) return "giin";
  return null;
}

/** 話者マーカーが1つも無ければ null（通常の本文として描く） */
function splitSpeakerBlocks(body: string): SpeakerBlock[] | null {
  const blocks: SpeakerBlock[] = [];
  let cur: SpeakerBlock | null = null;
  for (const line of body.split("\n")) {
    const m = SPEAKER_RE.exec(line.trim());
    if (m) {
      cur = { label: m[1], speaker: speakerOf(m[1]), lines: [] };
      blocks.push(cur);
    } else {
      if (!cur) {
        cur = { label: null, speaker: null, lines: [] };
        blocks.push(cur);
      }
      cur.lines.push(line);
    }
  }
  return blocks.some((b) => b.label !== null) ? blocks : null;
}

const SPEAKER_BLOCK_CLASS: Record<Exclude<Speaker, null> | "none", string> = {
  giin: "border-l-4 border-violet-400 bg-violet-50/70 dark:border-violet-500 dark:bg-violet-950/30",
  shokuin: "border-l-4 border-sky-400 bg-sky-50/70 dark:border-sky-500 dark:bg-sky-950/30",
  none: "border-l-4 border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800/40",
};

const SPEAKER_LABEL_CLASS: Record<Exclude<Speaker, null> | "none", string> = {
  giin: "text-violet-800 dark:text-violet-200",
  shokuin: "text-sky-800 dark:text-sky-200",
  none: "text-slate-600 dark:text-slate-300",
};

// ---------------------------------------------------------------------------
// その他の小道具
// ---------------------------------------------------------------------------

/** ISO 日時を JST の YYYY-MM-DD にする（サーバーとクライアントで同じ結果になるよう timeZone を固定） */
function formatJstDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** URL ハッシュ（#A-10,B-03）を ID の配列にする */
function parseHash(hash: string, valid: Set<string>): string[] {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => valid.has(s));
}

type Prepared = {
  item: HojinQaItem;
  /** 検索対象（title / said / body / tags）を正規化して連結したもの。根拠・注意は含めない */
  searchText: string;
};

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export default function HojinQaClient({ data }: { data: HojinQaData }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<HojinQaCategory | null>(null);
  const [constraints, setConstraints] = useState<Set<HojinQaConstraint>>(() => new Set());
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState<{ id: string; message: string } | null>(null);
  const [printing, setPrinting] = useState(false);
  // 全件ルールは事故防止のため初期状態は開いておく。ただしスマホでは画面1枚ぶんを
  // 占めるので、検索・絞り込みを始めたら自動で畳んで結果を上に出す（null＝自動）。
  // 利用者が手で開閉したら（boolean）その意思を優先する。
  const [rulesOpen, setRulesOpen] = useState<boolean | null>(null);
  const [numbersOpen, setNumbersOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hashRestoredRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nq = useMemo(() => normalizeText(query), [query]);

  // --- 検索の下ごしらえ（データは固定なので1回だけ） ---
  const prepared = useMemo<Prepared[]>(
    () =>
      data.items.map((item) => ({
        item,
        searchText: normalizeText(
          [item.title, item.said ?? "", item.body, ...item.tags].join("\n"),
        ),
      })),
    [data.items],
  );

  const validIds = useMemo(() => new Set(data.items.map((i) => i.id)), [data.items]);

  /** データに実際にある使用条件だけを、決めた順に並べる */
  const constraintKinds = useMemo<HojinQaConstraint[]>(() => {
    const present = new Set<HojinQaConstraint>();
    for (const it of data.items) if (it.constraint) present.add(it.constraint);
    const ordered = CONSTRAINT_ORDER.filter((c) => present.has(c));
    for (const c of present) if (!ordered.includes(c)) ordered.push(c);
    return ordered;
  }, [data.items]);

  const matchQuery = useCallback((p: Prepared) => nq === "" || p.searchText.includes(nq), [nq]);
  const matchCat = useCallback((p: Prepared, c: HojinQaCategory | null) => c === null || p.item.cat === c, []);
  const matchConstraint = useCallback(
    (p: Prepared, ks: Set<HojinQaConstraint>) =>
      ks.size === 0 || (p.item.constraint !== null && ks.has(p.item.constraint)),
    [],
  );

  const results = useMemo(
    () => prepared.filter((p) => matchQuery(p) && matchCat(p, cat) && matchConstraint(p, constraints)),
    [prepared, matchQuery, matchCat, matchConstraint, cat, constraints],
  );

  // チップの件数は「他の条件を適用したうえで、そのチップを選んだら何件になるか」
  const catCounts = useMemo(() => {
    const base = prepared.filter((p) => matchQuery(p) && matchConstraint(p, constraints));
    const counts = { all: base.length } as Record<HojinQaCategory | "all", number>;
    for (const c of CATEGORIES) counts[c] = base.filter((p) => p.item.cat === c).length;
    return counts;
  }, [prepared, matchQuery, matchConstraint, constraints]);

  const constraintCounts = useMemo(() => {
    const base = prepared.filter((p) => matchQuery(p) && matchCat(p, cat));
    const counts = {} as Record<HojinQaConstraint, number>;
    for (const k of constraintKinds) counts[k] = base.filter((p) => p.item.constraint === k).length;
    return counts;
  }, [prepared, matchQuery, matchCat, cat, constraintKinds]);

  /** 「数字の唯一の正」の行のうち、検索に当たったものの index */
  const numberHits = useMemo(() => {
    if (nq === "") return new Set<number>();
    const hits = new Set<number>();
    data.numbers.forEach((row, i) => {
      if (normalizeText(`${row.item}\n${row.value}`).includes(nq)) hits.add(i);
    });
    return hits;
  }, [data.numbers, nq]);

  /** 該当なしのときに出すタグ一覧（出現数の多い順） */
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of data.items) for (const t of it.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
  }, [data.items]);

  // --- 数字の表に当たりがあれば自動で開く ---
  useEffect(() => {
    if (numberHits.size > 0) setNumbersOpen(true);
  }, [numberHits]);

  // --- URL ハッシュ：復元（初回）と hashchange ---
  useEffect(() => {
    const apply = (scroll: boolean) => {
      const ids = parseHash(window.location.hash, validIds);
      setOpenIds(new Set(ids));
      if (scroll && ids.length > 0) {
        // 描画が終わってから対象カードへ寄せる
        requestAnimationFrame(() => {
          document.getElementById(`qa-${ids[0]}`)?.scrollIntoView({ block: "start" });
        });
      }
    };
    apply(true);
    hashRestoredRef.current = true;
    const onHashChange = () => apply(true);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [validIds]);

  // --- URL ハッシュ：書き出し（復元が済んでから） ---
  useEffect(() => {
    if (!hashRestoredRef.current) return;
    const ids = data.items.filter((i) => openIds.has(i.id)).map((i) => i.id);
    const next = ids.length > 0 ? `#${ids.join(",")}` : "";
    if (window.location.hash === next) return;
    // pushState にすると戻るボタンが効かなくなるので replace で置き換える
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
  }, [openIds, data.items]);

  // --- 固定ヘッダーの高さを CSS 変数に載せる（カードへスクロールするときのずらし幅） ---
  useEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;
    if (!header || !root) return;
    const update = () => root.style.setProperty("--hq-header", `${header.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  // --- 印刷時は全カードを展開する ---
  useEffect(() => {
    const before = () => setPrinting(true);
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // --- 操作 ---
  const toggleOpen = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleConstraint = useCallback((k: HojinQaConstraint) => {
    setConstraints((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setQuery("");
    setCat(null);
    setConstraints(new Set());
    inputRef.current?.focus();
  }, []);

  const copyBody = useCallback(async (item: HojinQaItem) => {
    const text = stripMarkdown(item.body);
    let message: string;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      message = "コピーしました";
    } catch {
      message = "コピーできませんでした。本文を長押しして選択してください";
    }
    setCopied({ id: item.id, message });
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(null), 1800);
  }, []);

  const hasFilter = query !== "" || cat !== null || constraints.size > 0;
  const generated = formatJstDate(data.generatedAt);

  return (
    <div
      ref={rootRef}
      className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
    >
      {/* 印刷用：検索・チップ・ボタンを消し、カードは JS 側（printing）で全展開する */}
      <style>{`
        @media print {
          .hq-noprint { display: none !important; }
          .hq-card { break-inside: avoid; }
          details.hq-panel > summary { list-style: none; }
        }
      `}</style>

      {/* ===== 固定ヘッダー：検索とチップ ===== */}
      <header
        ref={headerRef}
        className="hq-noprint sticky top-0 z-20 border-b border-slate-200 bg-slate-50/95 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"
      >
        <div className="mx-auto max-w-3xl px-3 pb-2 pt-2">
          <div className="flex items-baseline justify-between">
            <h1 className="text-xs font-medium tracking-wide text-slate-500 dark:text-slate-400">
              法人請求QA検索
            </h1>
            <p className="text-xs tabular-nums text-slate-500 dark:text-slate-400" aria-live="polite">
              {results.length}件 / {data.total}件
            </p>
          </div>

          <div className="relative mt-1">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              enterKeyHint="search"
              placeholder="相手の発言・キーワードで探す"
              aria-label="相手の発言・キーワードで探す"
              // text-base（16px）未満だと iOS がフォーカス時に拡大するので下げない
              className="w-full rounded-md border border-slate-300 bg-white py-2.5 pl-3 pr-10 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-400"
            />
            {query !== "" && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label="検索語を消す"
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-lg leading-none text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              >
                ×
              </button>
            )}
          </div>

          {/* カテゴリチップ */}
          <div className={`${CHIP_ROW} mt-2`} role="group" aria-label="カテゴリ">
            <button
              type="button"
              onClick={() => setCat(null)}
              aria-pressed={cat === null}
              className={`${CHIP_BASE} ${cat === null ? CHIP_NEUTRAL_ON : CHIP_OFF}`}
            >
              すべて
              <span className="tabular-nums opacity-70">{catCounts.all}</span>
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCat(cat === c ? null : c)}
                aria-pressed={cat === c}
                className={`${CHIP_BASE} ${cat === c ? CATEGORY_CHIP_ON[c] : CHIP_OFF}`}
              >
                <span className="font-semibold">{c}</span>
                {CATEGORY_SHORT[c]}
                <span className="tabular-nums opacity-70">{catCounts[c]}</span>
              </button>
            ))}
          </div>

          {/* 使用条件チップ */}
          {constraintKinds.length > 0 && (
            <div className={`${CHIP_ROW} mt-1.5`} role="group" aria-label="使用条件">
              {constraintKinds.map((k) => {
                const on = constraints.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleConstraint(k)}
                    aria-pressed={on}
                    className={`${CHIP_BASE} ${on ? CHIP_NEUTRAL_ON : CHIP_OFF}`}
                  >
                    {k}
                    <span className="tabular-nums opacity-70">{constraintCounts[k]}</span>
                  </button>
                );
              })}
              {hasFilter && (
                <button
                  type="button"
                  onClick={clearAll}
                  className={`${CHIP_BASE} ml-auto border-transparent bg-transparent text-slate-500 underline-offset-2 hover:underline dark:text-slate-400`}
                >
                  条件をクリア
                </button>
              )}
            </div>
          )}

          {/* カテゴリを1つ選んだときだけ、その方針を短く出す */}
          {cat !== null && (
            <p className="mt-1.5 text-xs leading-snug text-slate-600 dark:text-slate-400">
              {renderLines(data.categories[cat].policy, "")}
            </p>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pb-8">
        {/* ===== 補助パネル ===== */}
        <section className="mt-3 space-y-2" aria-label="補助情報">
          <Panel
            title="全件に効くルール"
            open={
              printing ||
              (rulesOpen ??
                !(query.trim() !== "" || cat !== null || constraints.size > 0))
            }
            onToggle={setRulesOpen}
          >
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
              {data.rules.map((r, i) => (
                <li key={i}>{renderLines(r, "")}</li>
              ))}
            </ol>
          </Panel>

          <Panel
            title={data.numbersHeading}
            badge={numberHits.size > 0 ? `${numberHits.size}行が該当` : undefined}
            open={printing || numbersOpen}
            onToggle={setNumbersOpen}
          >
            <dl className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {data.numbers.map((row, i) => {
                const hit = numberHits.has(i);
                return (
                  <div
                    key={i}
                    className={`py-2 ${hit ? "-mx-2 rounded-sm bg-yellow-50 px-2 dark:bg-yellow-900/20" : ""}`}
                  >
                    <dt className="text-xs text-slate-500 dark:text-slate-400">
                      {renderInline(row.item, nq)}
                    </dt>
                    <dd className="mt-0.5 leading-relaxed">{renderInline(row.value, nq)}</dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-2 text-sm">{renderInline(data.numbersNote, "")}</p>
          </Panel>

          <Panel title="この表の使い方" open={printing || usageOpen} onToggle={setUsageOpen}>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
              {data.usage.map((u, i) => (
                <li key={i}>{renderLines(u, "")}</li>
              ))}
            </ol>
          </Panel>
        </section>

        {/* ===== 一覧 ===== */}
        {results.length === 0 ? (
          <section className="mt-6" aria-live="polite">
            <p className="text-center text-sm text-slate-600 dark:text-slate-400">
              該当なし。別の言葉で試してください
            </p>
            <div className="hq-noprint mt-4 flex flex-wrap justify-center gap-1.5">
              {allTags.map(([tag, n]) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setQuery(tag);
                    setCat(null);
                    setConstraints(new Set());
                  }}
                  className={`${CHIP_BASE} ${CHIP_OFF}`}
                >
                  {tag}
                  <span className="tabular-nums opacity-60">{n}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <ul className="mt-3 space-y-2" aria-label="QA一覧">
            {results.map(({ item }) => (
              <QaCard
                key={item.id}
                item={item}
                nq={nq}
                open={printing || openIds.has(item.id)}
                onToggle={() => toggleOpen(item.id)}
                onCopy={() => copyBody(item)}
                copyMessage={copied?.id === item.id ? copied.message : null}
              />
            ))}
          </ul>
        )}

        <footer className="mt-8 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <p>{data.title}</p>
          <p className="mt-0.5">
            出典：{data.sourceFile}　生成：{generated}
          </p>
        </footer>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 補助パネル（details）
// ---------------------------------------------------------------------------

function Panel({
  title,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  badge?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="hq-panel rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      open={open}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => onToggle(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm font-medium marker:text-slate-400">
        <span>{title}</span>
        {badge && (
          <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-normal text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-100">
            {badge}
          </span>
        )}
      </summary>
      <div className="border-t border-slate-200 px-3 py-2.5 dark:border-slate-800">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// QA カード
// ---------------------------------------------------------------------------

function QaCard({
  item,
  nq,
  open,
  onToggle,
  onCopy,
  copyMessage,
}: {
  item: HojinQaItem;
  nq: string;
  open: boolean;
  onToggle: () => void;
  onCopy: () => void;
  copyMessage: string | null;
}) {
  const blocks = useMemo(() => splitSpeakerBlocks(item.body), [item.body]);
  const bodyId = `qa-${item.id}-body`;

  return (
    <li
      id={`qa-${item.id}`}
      className="hq-card rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      style={{ scrollMarginTop: "calc(var(--hq-header, 0px) + 8px)" }}
    >
      {/* 見出し部分。ここ全体がボタン（片手で押しやすいよう当たり判定を広く） */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="block w-full px-3 py-2.5 text-left"
      >
        <div className="flex items-start gap-2">
          <span
            className={`mt-0.5 inline-block shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${CATEGORY_BADGE[item.cat]}`}
          >
            {item.id}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium leading-snug">{renderInline(item.title, nq)}</span>
            {item.constraintLabel && (
              <span className="mt-1 inline-block rounded border border-slate-300 px-1.5 py-0.5 text-[11px] leading-none text-slate-600 dark:border-slate-600 dark:text-slate-300">
                {item.constraintLabel}
              </span>
            )}
          </span>
          <span
            aria-hidden="true"
            className={`mt-1 shrink-0 text-xs text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
          >
            ›
          </span>
        </div>
        {item.said !== null && (
          <p className="mt-1.5 truncate text-sm text-slate-600 dark:text-slate-400">
            {renderInline(item.said, nq)}
          </p>
        )}
        {item.tags.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {item.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] leading-none text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {renderInline(t, nq)}
              </span>
            ))}
          </p>
        )}
      </button>

      {open && (
        <div id={bodyId} className="border-t border-slate-200 px-3 pb-3 pt-2.5 dark:border-slate-800">
          {/* 1. 場面 */}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            <span className="mr-1 font-medium">場面</span>
            {renderInline(item.scene, "")}
          </p>

          {/* 2. 本文（主役：カード内で最も大きく、最も濃い） */}
          <div className="mt-2 text-base leading-relaxed text-slate-900 dark:text-slate-50">
            {blocks ? (
              <div className="space-y-2">
                {blocks.map((b, i) => {
                  const kind = b.speaker ?? "none";
                  return (
                    <div key={i} className={`rounded-r-md py-2 pl-3 pr-2 ${SPEAKER_BLOCK_CLASS[kind]}`}>
                      {b.label && (
                        <p className={`mb-1 text-xs font-semibold ${SPEAKER_LABEL_CLASS[kind]}`}>{b.label}</p>
                      )}
                      {b.lines.map((line, j) => (
                        <span key={j} className="block min-h-[1em] whitespace-pre-wrap">
                          {renderInline(line, nq)}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              renderLines(item.body, nq)
            )}
          </div>

          {/* 3. コピー */}
          <div className="hq-noprint mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 active:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:active:bg-slate-700"
            >
              本文をコピー
            </button>
            {copyMessage && (
              <span className="text-xs text-slate-600 dark:text-slate-300" role="status">
                {copyMessage}
              </span>
            )}
          </div>

          {/* 4. 注意（琥珀色の枠で区別。赤で塗らない） */}
          {item.caution && (
            <div className="mt-3 border-l-2 border-amber-400 bg-amber-50 py-2 pl-3 pr-2 text-sm leading-relaxed text-amber-950 dark:border-amber-500 dark:bg-amber-950/30 dark:text-amber-50">
              <p className="mb-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">注意</p>
              {renderLines(item.caution, "")}
            </div>
          )}

          {/* 5. 根拠（折りたたみ） */}
          {item.evidence && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer select-none text-xs text-slate-500 dark:text-slate-400">
                根拠を見る
              </summary>
              <div className="mt-1 leading-relaxed text-slate-700 dark:text-slate-300">
                {renderLines(item.evidence, "")}
              </div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
