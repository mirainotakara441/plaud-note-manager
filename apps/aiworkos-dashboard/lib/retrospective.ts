// 振り返り（週次・月次）の型・カテゴリー定義と、貼り付けMarkdownの解析。
//
// 週報（weekly_reports）が「団体ごとの事実のログ」なのに対し、こちらは
// ★評価・総括・示唆・次期の予定という「解釈」を溜めるもの。別物なので混ぜない。
//
// 吉井さんの運用は「Claudeが整形したMarkdown（★や表を含む）を貼り付ける」なので、
// この解析器はその本文を節・★・表・示唆・予定に切り出す。ただし解釈できなかった
// 行は絶対に捨てず warnings に積んで画面に出し、その場で直せるようにする
// （黙って落とすと、書いたのに残っていないという最悪の壊れ方をするため）。
//
// 純粋関数だけなので、サーバ（route.ts）からもクライアント（フォーム）からも使える。

export type PeriodType = "週次" | "月次";

export const PERIOD_TYPES: PeriodType[] = ["週次", "月次"];

// 節の表（自治体・事業者など）の1行。
export type SectionItem = { name: string; move: string; eval: string };

export type NextPlan = { date: string; label: string };

export type DraftSection = {
  category: string;
  rating: number | null; // ★の数（1..5）。★が無い節は null
  body: string;
  items: SectionItem[];
};

export type RetroDraft = {
  period_type: PeriodType;
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD
  title: string;
  one_liner: string;
  insights: string[];
  next_plans: NextPlan[];
  sections: DraftSection[];
};

// Supabaseから読んだ行（retrospective_sections を埋め込んだ形）。
export type RetroSectionRow = {
  id: string;
  retrospective_id: string;
  category: string;
  rating: number | null;
  body: string | null;
  items: SectionItem[] | null;
  position: number;
};

export type RetroRow = {
  id: string;
  period_type: PeriodType;
  period_start: string;
  period_end: string;
  title: string | null;
  one_liner: string | null;
  insights: string[] | null;
  next_plans: NextPlan[] | null;
  notion_page_id: string | null;
  created_at: string;
  updated_at: string;
  sections: RetroSectionRow[];
};

// 解釈できなかった／推測で埋めた箇所。画面に必ず出す。
export type ParseWarning = { label: string; detail: string };

export type ParseResult = { draft: RetroDraft; warnings: ParseWarning[] };

// ---------------------------------------------------------------------------
// カテゴリー
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "仕事（総括）",
  "自治体",
  "事業者・委託会社",
  "議員・国",
  "スキルアップ・生成AI",
  "信心",
  "健康",
] as const;

// 表示上の色。未知のカテゴリーはグレーにフォールバックする。
const CATEGORY_ACCENT: Record<string, string> = {
  "仕事（総括）": "bg-slate-100 text-slate-700",
  自治体: "bg-sky-100 text-sky-700",
  "事業者・委託会社": "bg-amber-100 text-amber-700",
  "議員・国": "bg-indigo-100 text-indigo-700",
  "スキルアップ・生成AI": "bg-teal-100 text-teal-700",
  信心: "bg-violet-100 text-violet-700",
  健康: "bg-lime-100 text-lime-700",
};

export function categoryAccent(category: string): string {
  return CATEGORY_ACCENT[category] ?? "bg-gray-100 text-gray-600";
}

// 見出し文字列を突き合わせ用のキーに正規化する。
// 空白・括弧・中点・装飾記号のゆれを吸収する。
function normalizeKey(raw: string): string {
  return raw
    .replace(/[\s　]/g, "")
    .replace(/[【】[\]]/g, "")
    .replace(/^[■◆▽▼●○◎*＊\-–—]+/, "")
    .replace(/[:：]+$/, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[･・]/g, "")
    .toUpperCase();
}

const CATEGORY_ALIASES: Record<string, string> = {};
function registerCategory(canonical: string, aliases: string[]) {
  CATEGORY_ALIASES[normalizeKey(canonical)] = canonical;
  for (const a of aliases) CATEGORY_ALIASES[normalizeKey(a)] = canonical;
}
registerCategory("仕事（総括）", ["仕事", "総括", "仕事総括", "全体総括", "総括(仕事)", "ビジネス"]);
registerCategory("自治体", ["自治体営業", "官公庁", "自治体・官公庁"]);
registerCategory("事業者・委託会社", ["事業者", "委託会社", "委託", "事業者・委託", "パートナー"]);
registerCategory("議員・国", ["議員", "国", "議員・国会", "政治", "議連"]);
registerCategory("スキルアップ・生成AI", ["スキルアップ", "生成AI", "AI", "学び", "自己研鑽", "スキル"]);
registerCategory("信心", ["信仰", "学会", "信心・学会"]);
registerCategory("健康", ["体調", "健康・体調"]);

type SpecialTarget = "title" | "one_liner" | "insights" | "next_plans";

const SPECIAL_ALIASES: Record<string, SpecialTarget> = {};
function registerSpecial(target: SpecialTarget, aliases: string[]) {
  for (const a of aliases) SPECIAL_ALIASES[normalizeKey(a)] = target;
}
registerSpecial("title", ["タイトル", "表題", "件名"]);
registerSpecial("one_liner", ["一言で", "一言", "ひとことで", "ひとこと", "一言でいうと", "要約", "サマリー", "総論"]);
registerSpecial("insights", ["示唆", "示唆・気づき", "気づき", "インサイト", "そうか", "学び・示唆", "示唆と学び"]);
registerSpecial("next_plans", [
  "次期の予定",
  "次期予定",
  "来週の予定",
  "来月の予定",
  "次週の予定",
  "今後の予定",
  "次の予定",
  "予定",
  "これからの予定",
]);

export function canonicalCategory(raw: string): string | null {
  return CATEGORY_ALIASES[normalizeKey(raw)] ?? null;
}

// ---------------------------------------------------------------------------
// ★表示
// ---------------------------------------------------------------------------

// ★は視覚的に。null（★のない節）は「—」を返す。
export function formatStars(rating: number | null | undefined): string {
  if (rating === null || rating === undefined) return "—";
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// ★の数に応じた色。低いほど注意色にする。
export function ratingColor(rating: number | null | undefined): string {
  if (rating === null || rating === undefined) return "text-gray-300";
  if (rating >= 5) return "text-emerald-500";
  if (rating >= 4) return "text-indigo-500";
  if (rating >= 3) return "text-amber-500";
  return "text-rose-500";
}

export function ratingBarColor(rating: number | null | undefined): string {
  if (rating === null || rating === undefined) return "bg-gray-200";
  if (rating >= 5) return "bg-emerald-500";
  if (rating >= 4) return "bg-indigo-500";
  if (rating >= 3) return "bg-amber-400";
  return "bg-rose-400";
}

// ★のある節だけで平均を出す。★が1つも無ければ null。
export function averageRating(sections: { rating: number | null }[]): number | null {
  const rated = sections.map((s) => s.rating).filter((r): r is number => typeof r === "number");
  if (rated.length === 0) return null;
  return rated.reduce((a, b) => a + b, 0) / rated.length;
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// "2026-07-27" / "2026/7/27" / "2026年7月27日" / "7/27" / "7月27日" を受ける。
export function parseDateToken(token: string, defaultYear: number): string | null {
  const s = token.trim();
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) return isoDate(defaultYear, Number(m[1]), Number(m[2]));
  return null;
}

const DATE_SCAN =
  /(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/.月]\d{1,2}日?)/g;

// 文中から日付らしきものを拾う。"15:30-16:30" のような時刻範囲は月>12で弾かれる。
function scanDates(text: string, defaultYear: number): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(DATE_SCAN)) {
    const iso = parseDateToken(m[1], defaultYear);
    if (iso) found.push(iso);
  }
  return found;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function formatPeriod(start: string, end: string): string {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (!sy || !ey) return `${start} 〜 ${end}`;
  const same = sy === ey;
  return same
    ? `${sy}年${sm}月${sd}日 〜 ${em}月${ed}日`
    : `${sy}年${sm}月${sd}日 〜 ${ey}年${em}月${ed}日`;
}

// 一覧・推移の軸ラベル用の短い表記（7/27 など）。
export function shortPeriodLabel(start: string, periodType: PeriodType): string {
  const [, m, d] = start.split("-").map(Number);
  if (periodType === "月次") return `${m}月`;
  return `${m}/${d}`;
}

export function formatPlanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return `${m}/${d}（${wd}）`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// ★の抽出
// ---------------------------------------------------------------------------

// 見出しから★評価を取り出し、★部分を除いた見出し文字列を返す。
// "自治体 ★★★★☆" / "自治体 ★×4" / "自治体 評価：4" / "自治体 4/5" に対応。
export function extractRating(text: string): { rating: number | null; rest: string } {
  let rating: number | null = null;
  let rest = text;

  const mul = rest.match(/★\s*[×xX*＊]\s*([1-5])/);
  if (mul) {
    rating = Number(mul[1]);
    rest = rest.replace(mul[0], " ");
  }
  if (rating === null) {
    const colon = rest.match(/(?:評価|★|星)\s*[:：=＝]\s*([1-5])/);
    if (colon) {
      rating = Number(colon[1]);
      rest = rest.replace(colon[0], " ");
    }
  }
  if (rating === null) {
    const frac = rest.match(/([1-5])\s*[/／]\s*5/);
    if (frac) {
      rating = Number(frac[1]);
      rest = rest.replace(frac[0], " ");
    }
  }
  if (rating === null) {
    const stars = (rest.match(/[★⭐✭]/g) ?? []).length;
    if (stars >= 1 && stars <= 5) rating = stars;
  }

  rest = rest
    .replace(/[★☆⭐✭✩]/g, "")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/[\s　]+/g, " ")
    .replace(/^[-–—:：\s]+|[-–—:：\s]+$/g, "")
    .trim();

  return { rating, rest };
}

// ---------------------------------------------------------------------------
// 表（Markdownテーブル）
// ---------------------------------------------------------------------------

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.length > 1;
}

function tableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?[-–—=]{2,}:?$/.test(c.replace(/\s/g, "")));
}

const HEADER_HINTS = {
  name: ["団体", "名称", "名前", "対象", "項目", "相手", "先"],
  move: ["動き", "内容", "出来事", "アクション", "概要", "できごと", "状況"],
  eval: ["評価", "結果", "所感", "判定", "コメント"],
};

function looksLikeHeader(cells: string[]): boolean {
  const all = [...HEADER_HINTS.name, ...HEADER_HINTS.move, ...HEADER_HINTS.eval];
  return cells.some((c) => all.some((h) => c.includes(h)));
}

function columnMap(header: string[] | null): { name: number; move: number; eval: number } {
  const map = { name: 0, move: 1, eval: 2 };
  if (!header) return map;
  header.forEach((c, i) => {
    if (HEADER_HINTS.name.some((h) => c.includes(h))) map.name = i;
    else if (HEADER_HINTS.move.some((h) => c.includes(h))) map.move = i;
    else if (HEADER_HINTS.eval.some((h) => c.includes(h))) map.eval = i;
  });
  return map;
}

// バケット（1つの節に属する行の塊）を、本文と表に切り分ける。
function splitBucket(lines: string[]): {
  body: string;
  items: SectionItem[];
  notes: string[];
} {
  const bodyLines: string[] = [];
  const items: SectionItem[] = [];
  const notes: string[] = [];

  let header: string[] | null = null;
  let map = columnMap(null);
  let inTable = false;

  for (const line of lines) {
    if (!isTableRow(line)) {
      if (inTable && line.trim() === "") {
        inTable = false;
        header = null;
        map = columnMap(null);
      }
      bodyLines.push(line);
      continue;
    }
    const cells = tableCells(line);
    if (isSeparatorRow(cells)) {
      inTable = true;
      continue;
    }
    if (!inTable && header === null && looksLikeHeader(cells)) {
      header = cells;
      map = columnMap(cells);
      inTable = true;
      continue;
    }
    inTable = true;
    const expected = header?.length ?? 3;
    if (header && cells.length !== expected) {
      notes.push(`表の列数が見出しと合いません（見出し${expected}列・この行${cells.length}列）: ${line.trim()}`);
    }
    const pick = (i: number) => (i >= 0 && i < cells.length ? cells[i] : "");
    const item: SectionItem = {
      name: pick(map.name),
      move: pick(map.move),
      eval: pick(map.eval),
    };
    // 使わなかった列があれば黙って捨てずに知らせる。
    const used = new Set([map.name, map.move, map.eval]);
    const leftover = cells.filter((c, i) => !used.has(i) && c !== "");
    if (leftover.length > 0) {
      notes.push(`表の余った列を取り込めませんでした: ${leftover.join(" / ")}`);
    }
    if (item.name || item.move || item.eval) items.push(item);
  }

  return { body: trimBlock(bodyLines), items, notes };
}

function trimBlock(lines: string[]): string {
  return lines.join("\n").replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

// 箇条書きの記号を落として1件の文字列にする。
function stripBullet(line: string): string {
  return line
    .replace(/^[\s　]*(?:[-*＊・･●○◆■◇▶▸>]+|\d+[.)、]|[（(]\d+[)）])[\s　]*/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// 見出し検出
// ---------------------------------------------------------------------------

type Heading = { text: string; level: number };

function detectHeading(line: string): Heading | null {
  const t = line.trim();
  if (t === "") return null;

  let m = t.match(/^(#{1,6})\s*(.+?)\s*$/);
  if (m) return { text: m[2], level: m[1].length };

  m = t.match(/^\*\*(.+?)\*\*\s*[:：]?\s*$/);
  if (m) return { text: m[1], level: 2 };

  m = t.match(/^【(.+?)】\s*(.*)$/);
  if (m) return { text: `${m[1]} ${m[2]}`.trim(), level: 2 };

  m = t.match(/^[■◆▼●]\s*(.+?)\s*$/);
  if (m) return { text: m[1], level: 2 };

  // 記号なしでも「自治体 ★★★★☆」のような短い行は見出しとみなす。
  if (t.length <= 30 && !isTableRow(t)) {
    const { rest } = extractRating(t);
    const key = normalizeKey(rest);
    if (rest !== "" && (CATEGORY_ALIASES[key] || SPECIAL_ALIASES[key])) {
      return { text: t, level: 2 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

type Bucket =
  | { kind: "section"; category: string; rating: number | null; lines: string[] }
  | { kind: "special"; target: SpecialTarget; lines: string[] }
  | { kind: "unknown"; heading: string; lines: string[] }
  | { kind: "preamble"; lines: string[] };

// 「タイトル：」見出し配下を表す内部マーカー。実在の見出し名と衝突しない文字列。
const TITLE_BUCKET = " title";

export function parseRetrospectiveMarkdown(text: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const buckets: Bucket[] = [];
  let current: Bucket = { kind: "preamble", lines: [] };
  buckets.push(current);

  let metaTitle = "";
  let metaPeriodRaw = "";
  let metaTypeRaw = "";
  let sawSection = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    // メタ情報行（期間：／種別：／タイトル：）はどこにあっても拾う。
    if (current.kind === "preamble") {
      const meta = line.match(/^[\s　]*(期間|対象期間|対象)[\s　]*[:：][\s　]*(.+)$/);
      if (meta) {
        metaPeriodRaw = meta[2];
        continue;
      }
      const type = line.match(/^[\s　]*(種別|区分|周期|単位)[\s　]*[:：][\s　]*(.+)$/);
      if (type) {
        metaTypeRaw = type[2];
        continue;
      }
      const title = line.match(/^[\s　]*(タイトル|表題|件名)[\s　]*[:：][\s　]*(.+)$/);
      if (title) {
        metaTitle = title[2].trim();
        continue;
      }
    }

    const heading = detectHeading(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }

    const { rating, rest } = extractRating(heading.text);
    const key = normalizeKey(rest);
    const special = SPECIAL_ALIASES[key];
    const category = CATEGORY_ALIASES[key];

    if (special === "title") {
      // 「タイトル」見出しの中身は次の行以降。目印つきのバケットに入れて後で拾う。
      current = { kind: "unknown", heading: TITLE_BUCKET, lines: [] };
      buckets.push(current);
      continue;
    }
    if (special) {
      current = { kind: "special", target: special, lines: [] };
      buckets.push(current);
      continue;
    }
    if (category) {
      sawSection = true;
      current = { kind: "section", category, rating, lines: [] };
      buckets.push(current);
      continue;
    }
    // 先頭のレベル1見出しで、まだ節が出ていなければタイトルとみなす。
    if (!sawSection && metaTitle === "" && heading.level <= 2) {
      metaTitle = rest;
      current = { kind: "preamble", lines: [] };
      buckets.push(current);
      continue;
    }
    current = { kind: "unknown", heading: rest || heading.text, lines: [] };
    buckets.push(current);
  }

  // ---- 期間・種別 ----
  const preambleText = buckets
    .filter((b) => b.kind === "preamble")
    .flatMap((b) => b.lines)
    .join("\n");
  const periodSource = [metaPeriodRaw, metaTitle, preambleText].filter(Boolean).join("\n");
  const guessYear = new Date().getFullYear();
  const dates = scanDates(periodSource, guessYear);

  let periodType: PeriodType = "週次";
  const typeSource = `${metaTypeRaw} ${metaTitle} ${preambleText}`;
  if (/月次|月報|今月|ひと月/.test(typeSource)) periodType = "月次";
  if (/週次|週報|今週/.test(metaTypeRaw)) periodType = "週次";

  let periodStart = dates[0] ?? "";
  let periodEnd = dates[1] ?? "";
  if (periodStart === "") {
    warnings.push({
      label: "期間を読み取れませんでした",
      detail: "開始日・終了日を手で入れてください（「期間：2026-07-27 〜 2026-07-31」の行があると自動で読めます）。",
    });
    periodStart = todayIso();
    periodEnd = todayIso();
  } else if (periodEnd === "") {
    periodEnd = periodType === "週次" ? addDays(periodStart, 6) : addDays(periodStart, 29);
    warnings.push({
      label: "終了日を推定しました",
      detail: `本文に終了日が見つからなかったため ${periodEnd} と置きました。違う場合は直してください。`,
    });
  }
  const planYear = Number(periodStart.slice(0, 4)) || guessYear;
  const planMonth = Number(periodStart.slice(5, 7)) || 1;

  // ---- 各バケットを詰める ----
  let title = metaTitle;
  let oneLiner = "";
  const insights: string[] = [];
  const nextPlans: NextPlan[] = [];
  const sections: DraftSection[] = [];

  for (const b of buckets) {
    if (b.kind === "preamble") {
      const leftover = trimBlock(b.lines);
      if (leftover !== "") {
        warnings.push({
          label: "どの節にも属さない行がありました",
          detail: leftover,
        });
      }
      continue;
    }

    if (b.kind === "unknown") {
      const content = trimBlock(b.lines);
      if (b.heading === TITLE_BUCKET) {
        if (title === "" && content !== "") title = content.split("\n")[0];
        else if (content !== "") {
          warnings.push({ label: "タイトル見出しの余りの行", detail: content });
        }
        continue;
      }
      warnings.push({
        label: `見出し「${b.heading}」は既知の節ではありません`,
        detail: content === "" ? "（中身なし）中身がある場合は節名を直して貼り直してください。" : content,
      });
      continue;
    }

    if (b.kind === "special") {
      if (b.target === "one_liner") {
        oneLiner = trimBlock(b.lines.map(stripBullet));
        continue;
      }
      if (b.target === "insights") {
        const { items, body, notes } = splitBucket(b.lines);
        for (const n of notes) warnings.push({ label: "示唆の表", detail: n });
        for (const it of items) {
          const merged = [it.name, it.move, it.eval].filter(Boolean).join(" ");
          if (merged) insights.push(merged);
        }
        for (const l of body.split("\n")) {
          const s = stripBullet(l);
          if (s !== "") insights.push(s);
        }
        continue;
      }
      // next_plans
      const { items, body, notes } = splitBucket(b.lines);
      for (const n of notes) warnings.push({ label: "次期の予定の表", detail: n });
      for (const it of items) {
        const iso = parseDateToken(it.name, planYear);
        const label = [it.move, it.eval].filter(Boolean).join(" ");
        if (iso) nextPlans.push({ date: rollYear(iso, planYear, planMonth), label });
        else {
          nextPlans.push({ date: "", label: [it.name, label].filter(Boolean).join(" ") });
          warnings.push({
            label: "予定の日付を読み取れませんでした",
            detail: `${it.name} ${label}`.trim(),
          });
        }
      }
      for (const l of body.split("\n")) {
        const s = stripBullet(l);
        if (s === "") continue;
        const m = s.match(
          /^((?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)[\s　]*(?:[（(][日月火水木金土][）)])?[\s　]*[-–—:：]?[\s　]*(.*)$/
        );
        const iso = m ? parseDateToken(m[1], planYear) : null;
        if (m && iso) {
          nextPlans.push({ date: rollYear(iso, planYear, planMonth), label: m[2].trim() });
        } else {
          nextPlans.push({ date: "", label: s });
          warnings.push({ label: "予定の日付を読み取れませんでした", detail: s });
        }
      }
      continue;
    }

    // section
    const { body, items, notes } = splitBucket(b.lines);
    for (const n of notes) {
      warnings.push({ label: `「${b.category}」の表`, detail: n });
    }
    sections.push({ category: b.category, rating: b.rating, body, items });
  }

  // 同じ節が2回出てきたら（UNIQUE制約に触れるので）警告してから後勝ちで畳む。
  const seen = new Map<string, DraftSection>();
  for (const s of sections) {
    if (seen.has(s.category)) {
      warnings.push({
        label: `「${s.category}」の節が2回出てきました`,
        detail: "1つの振り返りに同じ節は1つまでです。後に出てきた方を採用しました。",
      });
    }
    seen.set(s.category, s);
  }
  const uniqueSections = Array.from(seen.values());

  if (uniqueSections.length === 0) {
    warnings.push({
      label: "節を1つも読み取れませんでした",
      detail:
        "「## 自治体 ★★★★☆」のように、節名を見出しにして★を添える形にすると読み取れます。下のフォームで手入力もできます。",
    });
  }

  if (title === "" && oneLiner !== "") title = oneLiner.split("\n")[0];

  return {
    draft: {
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      title,
      one_liner: oneLiner,
      insights,
      next_plans: nextPlans,
      sections: uniqueSections,
    },
    warnings,
  };
}

// 「8/1」のように年が書かれていない予定は、振り返りの期間の年で解釈する。
// 12月の振り返りに「1/5」とあれば翌年とみなす。
function rollYear(iso: string, baseYear: number, baseMonth: number): string {
  const m = Number(iso.slice(5, 7));
  if (baseMonth >= 10 && m <= 3 && Number(iso.slice(0, 4)) === baseYear) {
    return `${baseYear + 1}${iso.slice(4)}`;
  }
  return iso;
}

// ---------------------------------------------------------------------------
// 空のドラフト
// ---------------------------------------------------------------------------

export function emptyDraft(): RetroDraft {
  const today = todayIso();
  return {
    period_type: "週次",
    period_start: today,
    period_end: addDays(today, 6),
    title: "",
    one_liner: "",
    insights: [],
    next_plans: [],
    sections: [],
  };
}

export function draftFromRow(row: RetroRow): RetroDraft {
  return {
    period_type: row.period_type,
    period_start: row.period_start,
    period_end: row.period_end,
    title: row.title ?? "",
    one_liner: row.one_liner ?? "",
    insights: Array.isArray(row.insights) ? row.insights : [],
    next_plans: Array.isArray(row.next_plans) ? row.next_plans : [],
    sections: [...(row.sections ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        category: s.category,
        rating: s.rating,
        body: s.body ?? "",
        items: Array.isArray(s.items) ? s.items : [],
      })),
  };
}

// ---------------------------------------------------------------------------
// 検証（APIとフォームで共有）
// ---------------------------------------------------------------------------

export function validateDraft(draft: RetroDraft): string | null {
  if (!PERIOD_TYPES.includes(draft.period_type)) return "種別は週次か月次を選んでください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.period_start)) return "開始日を入れてください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.period_end)) return "終了日を入れてください";
  if (draft.period_end < draft.period_start) return "終了日が開始日より前になっています";
  if (draft.sections.length === 0) return "節が1つもありません";
  const seen = new Set<string>();
  for (const s of draft.sections) {
    const cat = s.category.trim();
    if (cat === "") return "節の名前が空のものがあります";
    if (seen.has(cat)) return `節「${cat}」が重複しています`;
    seen.add(cat);
    if (s.rating !== null && (s.rating < 1 || s.rating > 5)) {
      return `節「${cat}」の★は1〜5で入れてください`;
    }
  }
  return null;
}
