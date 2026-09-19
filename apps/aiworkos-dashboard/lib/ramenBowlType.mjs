// ラーメン1杯の「種別」を決める純粋ロジック。
//
// ■ 役割
//   ramen_logs の1行から、形態（ラーメン／つけ麺／…）と味・系統（塩／豚骨／…）を出す。
//   「ジャンル別に何杯食べたか」の集計はここの結果を数えるだけ。
//   I/Oを持たないので、合成データでそのまま試せる（tests/ramen-bowl-type.mjs）。
//
// ■ 決め方（2026-09-19 に実データ162杯で確かめた）
//   1. 本人が手で入れた bowl_style / bowl_taste があればそれ（自動判定より必ず優先）
//   2. 無ければ本文からキーワードで判定する。見る順は
//        menu（食べたもの）→ title（題名）→ memo → excerpt（食べログ本文）→ 店ジャンル
//      menu が書いてあればそこで決め切る（本文まで見ると「隣の人のつけ麺」を拾う）。
//      具体的な語（つけ麺・まぜそば・冷やし…）を先に当て、最後に「ラーメン」へ落とす。
//      is_ramen=true の行しか来ないので、何も当たらなければ「ラーメン」で正しい。
//   形態は162杯すべてこれで決まった。味・系統は本文に手がかりの無い杯が68あり
//   6割止まりなので、決められない杯は null を返す（無理に当てない）。
//
// ■ 語彙はここが唯一の定義
//   DBには CHECK 制約を置かず、画面の選択肢もここから出す。2箇所に書くと片方だけ育つ。

export const BOWL_STYLES = Object.freeze([
  "ラーメン",
  "つけ麺",
  "まぜそば・油そば",
  "冷やし",
  "担々麺",
  "ちゃんぽん",
]);

export const BOWL_TASTES = Object.freeze([
  "醤油",
  "塩",
  "味噌",
  "豚骨",
  "煮干し・魚介",
  "鶏",
  "家系",
  "二郎系",
  "辛",
]);

// 形態。上から順に当てる（具体的なものが先）。
// 「担々麺」は汁ありでも汁なしでも担々麺に寄せる（味の軸でも「辛」に入る）。
const STYLE_RULES = [
  ["つけ麺", /つけ麺|つけそば|つけ蕎麦|もりそば|つけめん/],
  ["まぜそば・油そば", /まぜそば|混ぜそば|油そば|あぶらそば|汁なし|汁無し/],
  ["冷やし", /冷やし|冷し|冷麺/],
  ["担々麺", /担々|担担|タンタン|坦々/],
  ["ちゃんぽん", /ちゃんぽん|チャンポン/],
];

// 味・系統。上から順に当てる。店名も手がかりに含める（「ラーメン豚山」「博多一幸舎」等）。
// 「二郎系」を先に置くのは、二郎系の本文に「ニンニク・ヤサイ」が必ず出るのと、
// 醤油豚骨でもあるため後ろの規則に取られないようにするため。
const TASTE_RULES = [
  ["家系", /家系/],
  ["二郎系", /二郎|豚山|ヤサイ|ニンニク(?:マシ|アリ|入)|マシマシ|小ラーメン|大ラーメン/],
  ["煮干し・魚介", /煮干|にぼし|ニボ|魚介|鯖|さば|鰹|カツオ|あさり|しじみ|貝出汁|ほたて|帆立/],
  ["豚骨", /豚骨|とんこつ|博多|熊本|長浜|久留米/],
  ["鶏", /鶏白湯|鶏|鴨/],
  ["味噌", /味噌|みそ/],
  ["塩", /塩/],
  ["醤油", /醤油|しょうゆ|正油/],
  ["辛", /辛|痺|麻辣|激辛/],
];

function firstMatch(rules, text) {
  for (const [label, re] of rules) if (re.test(text)) return label;
  return null;
}

/**
 * 形態。手入力 → 本文のキーワード → 店ジャンル → 「ラーメン」。
 * @param {{bowl_style?:string|null, menu?:string|null, title?:string|null, memo?:string|null, excerpt?:string|null, genre?:string|null}} row
 * @returns {string} BOWL_STYLES のいずれか
 */
export function bowlStyleOf(row) {
  if (row.bowl_style && BOWL_STYLES.includes(row.bowl_style)) return row.bowl_style;
  // menu は「食べたもの」そのものなので、書いてあればそこで決め切る。
  // 本文まで見に行くと「隣の人のつけ麺」を拾って間違える。
  if (typeof row.menu === "string" && row.menu.trim() !== "") {
    return firstMatch(STYLE_RULES, row.menu) ?? "ラーメン";
  }
  for (const t of [row.title, row.memo, row.excerpt]) {
    if (typeof t !== "string" || t.trim() === "") continue;
    const s = firstMatch(STYLE_RULES, t);
    if (s) return s;
  }
  // 店ジャンル（食べログ）は「その店の主力」なので、本文に何も無いときだけ使う。
  // 先頭のジャンルだけ見る（「ラーメン、つけ麺」の店で食べたのは普通ラーメン）。
  const g = (row.genre ?? "").split(/[、,]/)[0]?.trim() ?? "";
  if (/^つけ麺/.test(g)) return "つけ麺";
  if (/^(油そば|まぜそば)/.test(g)) return "まぜそば・油そば";
  if (/^担々麺|^汁なし担々麺/.test(g)) return "担々麺";
  if (/^ちゃんぽん/.test(g)) return "ちゃんぽん";
  return "ラーメン";
}

/**
 * 味・系統。手入力 → 本文＋店名のキーワード。決められなければ null。
 * @param {{bowl_taste?:string|null, shop?:string|null, menu?:string|null, title?:string|null, memo?:string|null, excerpt?:string|null}} row
 * @returns {string|null} BOWL_TASTES のいずれか、または null
 */
export function bowlTasteOf(row) {
  if (row.bowl_taste && BOWL_TASTES.includes(row.bowl_taste)) return row.bowl_taste;
  // menu に味が書いてあればそれを信じる（「特製塩中華そば」なら塩）。
  // 先に本文まで混ぜると、メモの「まぜ家系という限定もある」を拾って家系になる
  if (typeof row.menu === "string" && row.menu.trim() !== "") {
    const fromMenu = firstMatch(TASTE_RULES, row.menu);
    if (fromMenu) return fromMenu;
  }
  const all = [row.shop, row.title, row.memo, row.excerpt].filter(Boolean).join(" ");
  return firstMatch(TASTE_RULES, all);
}

/**
 * 集計。{ styles: [{label, count}], tastes: [{label, count}], tasteUnknown } を返す。
 * 味・系統は決められた杯だけ数え、決められなかった杯数を tasteUnknown に別置きする
 * （「不明」を最大勢力として棒に混ぜない）。
 *
 * 行に style / taste が既に付いていれば（APIが判定済み）それを数える。
 * 一覧（view=list）の行には判定に使った本文が無いので、ここで判定し直すと数が変わる。
 * 付いていない行（テストの合成データ等）だけ、その場で判定する。
 */
export function summarizeBowlTypes(rows) {
  const styles = new Map();
  const tastes = new Map();
  let tasteUnknown = 0;
  for (const r of rows) {
    const s = typeof r.style === "string" && r.style ? r.style : bowlStyleOf(r);
    styles.set(s, (styles.get(s) ?? 0) + 1);
    const t = "taste" in r ? (r.taste ?? null) : bowlTasteOf(r);
    if (t) tastes.set(t, (tastes.get(t) ?? 0) + 1);
    else tasteUnknown += 1;
  }
  const sortDesc = (m) =>
    Array.from(m.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja"));
  return { styles: sortDesc(styles), tastes: sortDesc(tastes), tasteUnknown };
}

/**
 * 食べログの店URLから店IDを取り出す（百名店との突き合わせ鍵）。
 * "https://tabelog.com/tokyo/A1322/A132204/13200351/" → "13200351"
 */
export function tabelogShopId(url) {
  const m = String(url ?? "").match(/tabelog\.com\/[^?#]*?\/(\d{6,})\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

/**
 * 店名の照合用に表記ゆれを落とす（空白・全角半角の差だけ吸収。それ以上は寄せない）。
 */
export function normalizeShopName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}
