#!/usr/bin/env node
// 法人請求 営業実戦QA → 外部公開用（/qa-open）の JSON を作る。
//
// 入力は lib/hojinQa/data.json（scripts/build-hojin-qa.mjs の出力）。
// 出力は lib/hojinQa/data.public.json。
//
// やること：
//   1. 特定の自治体名・議員名・政党名・事件名・社内資料名を伏せる（MASK 表）
//   2. 社内向けの欄（注意・使い方・全件ルール）は出さない
//   3. 伏せ漏れが無いか最後に検査し、残っていたら失敗させる（FORBIDDEN）
//
// 使い方（QA表を直したら build-hojin-qa.mjs → これ の順）:
//   node scripts/build-hojin-qa.mjs && node scripts/build-hojin-qa-public.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "lib", "hojinQa", "data.json");
const OUT = join(ROOT, "lib", "hojinQa", "data.public.json");

// 長い語を先に置く（「横須賀市」を「須賀市」で拾わないように、置換は配列順）
const MASK = [
  // 議員名（実名＋議員）
  ["信貴良太議員", "C議員"],
  ["並川雄一議員", "D議員"],
  ["長島強議員", "E議員"],
  ["兼城剛議員", "F議員"],
  ["森田守議員", "G議員"],
  ["井下田議員", "B議員"],
  ["尾崎議員", "A議員"],
  // 事件名・社内資料名
  ["プライム総合法務事務所事件", "職務上請求書の偽造事件"],
  ["プライム事件", "職務上請求書の偽造事件"],
  ["委託先反転プレイブック", "社内資料"],
  ["標準化タイミング訴求", "社内資料"],
  ["効果算定シート", "効果算定の社内シート"],
  // 政党
  ["自民党と公明党の議員", "複数会派の議員"],
  ["自民・公明の議員", "複数会派の議員"],
  ["自民党の議員", "ある会派の議員"],
  ["公明党の議員", "ある会派の議員"],
  ["公明党の代表質問", "ある会派の代表質問"],
  ["自民党議員", "ある会派の議員"],
  ["政令市_自民公明_一般質問事例", "社内調査"],
  ["・自民／", "／"],
  ["・公明／", "／"],
  ["・自民、", "、"],
  ["・公明）", "）"],
  ["・自民）", "）"],
  ["・公明・", "・"],
  // 自治体名（政令市）
  ["千葉市様", "政令市A様"],
  ["千葉市", "政令市A"],
  ["横浜市会", "政令市B議会"],
  ["横浜市", "政令市B"],
  ["大阪市", "政令市C"],
  ["堺市議会", "政令市D議会"],
  ["堺市", "政令市D"],
  ["広島市議会", "政令市E議会"],
  ["広島市", "政令市E"],
  ["熊本市", "政令市F"],
  ["静岡市議会", "政令市G議会"],
  ["静岡市", "政令市G"],
  ["京都市会", "政令市H議会"],
  ["京都市", "政令市H"],
  // 特別区
  ["新宿区", "特別区A"],
  ["豊島区", "特別区B"],
  // その他の市町
  ["八王子市", "中核市A"],
  ["横須賀市", "中核市B"],
  ["つくば市様", "X市"],
  ["つくば市", "X市"],
  ["犬山市", "Y市"],
  ["南区で", "ある区で"],
  // 県
  ["導入ゼロの県は長崎県のみ", "導入ゼロの県は1県のみ"],
  ["長崎県のみ", "1県のみ"],
  ["長崎県", "ある県"],
  ["沖縄県内", "ある県内"],
  ["沖縄県", "ある県"],
  ["堺1件", "政令市D 1件"],
  ["京都242件", "政令市H 242件"],
];

// タグは1語だけのことがあるので、タグ全体が一致したときの置換表を別に持つ
const TAG_MASK = {
  "堺": "政令市D", "京都": "政令市H", "広島": "政令市E", "静岡": "政令市G", "横浜": "政令市B",
  "新宿": "特別区A", "豊島": "特別区B", "千葉": "政令市A", "熊本": "政令市F", "沖縄": "ある県",
  "つくば": "X市", "犬山": "Y市", "八王子": "中核市A", "横須賀": "中核市B",
};

// 伏せ残しの検査語。1つでも残っていたら失敗にする
const FORBIDDEN = [
  "千葉市", "横浜", "大阪市", "堺市", "広島", "熊本", "静岡市", "京都市", "新宿", "豊島", "八王子",
  "横須賀", "つくば", "犬山", "長崎", "沖縄", "相模原", "練馬", "品川", "大田区", "墨田", "北九州",
  "福岡市", "札幌", "仙台", "名古屋", "さいたま", "新潟", "中野区", "三鷹", "厚木", "名取",
  "尾崎", "井下田", "信貴", "並川", "長島", "兼城", "森田", "柴山", "自民", "公明", "プライム",
  "プレイブック", "エイジェック", "キャリアリンク", "東洋紙業", "アコム", "アイフル", "ソフトバンク",
  "調査/",
];

function mask(s) {
  if (typeof s !== "string") return s;
  let out = s;
  for (const [from, to] of MASK) out = out.split(from).join(to);
  // 社内ファイルへのパス表記（`調査/...md`）は丸ごと落とす
  out = out.replace(/`[^`]*\.md`/g, "社内調査");
  out = out.replace(/。詳細は\s*社内調査/g, "");
  return out;
}

const src = JSON.parse(readFileSync(IN, "utf8"));

const items = src.items.map((it) => ({
  id: it.id,
  cat: it.cat,
  num: it.num,
  title: mask(it.title),
  constraint: it.constraint,
  constraintLabel: it.constraintLabel,
  scene: mask(it.scene),
  said: it.said ? mask(it.said) : null,
  body: mask(it.body),
  evidence: mask(it.evidence),
  tags: it.tags.map((t) => TAG_MASK[t] ?? mask(t)),
}));

const categories = {};
for (const [k, v] of Object.entries(src.categories)) {
  categories[k] = { name: v.name, declared: v.declared };
}

const out = {
  title: "法人請求オンラインサービス｜想定問答集（公開版）",
  sourceFile: src.sourceFile,
  generatedAt: new Date().toISOString(),
  total: items.length,
  counts: src.counts,
  categories,
  numbersHeading: mask(src.numbersHeading),
  numbers: src.numbers.map((n) => ({ item: mask(n.item), value: mask(n.value) })),
  numbersNote: mask(src.numbersNote),
  items,
};

const dump = JSON.stringify(out, null, 2);
const leaks = FORBIDDEN.filter((w) => dump.includes(w));
if (leaks.length) {
  for (const w of leaks) {
    const i = dump.indexOf(w);
    console.error(`伏せ漏れ: ${w} … ${dump.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, " ")}`);
  }
  process.exit(1);
}

writeFileSync(OUT, dump + "\n", "utf8");
console.log(`書き出し: ${OUT}`);
console.log(`件数: ${items.length}`, src.counts, `/ 数字 ${out.numbers.length}行`);
