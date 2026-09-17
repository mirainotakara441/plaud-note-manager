#!/usr/bin/env node
// 法人請求 営業実戦QA表（Markdown）→ /hojin-qa が読む JSON を作る。
//
// 唯一の正は Desktop/JOB/議員説明会/QA票/QA表_確定版_20260823.md。
// このスクリプトは中身を一字一句そのまま JSON へ移すだけで、要約も書き換えもしない。
//
// 使い方（MDを直したら毎回これ）:
//   node scripts/build-hojin-qa.mjs            # 既定のMDから lib/hojinQa/data.json を作る
//   node scripts/build-hojin-qa.mjs <md path>  # 別の場所のMDを指定
//
// 出力の lib/hojinQa/data.json は git に含める（Vercel のビルド機にはDesktopが無いため）。
// 記憶層への再登録（register_qa.py）とは別。両方やること。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SRC =
  "/Users/YOSHII/Desktop/JOB/議員説明会/QA票/QA表_確定版_20260823.md";
const OUT = join(ROOT, "lib", "hojinQa", "data.json");

const src = process.argv[2] ?? DEFAULT_SRC;
const md = readFileSync(src, "utf8").replace(/\r\n/g, "\n");
const lines = md.split("\n");

// ---------- 前段（使い方・全件ルール・数字） ----------

function sectionLines(headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) throw new Error(`見出しが見つからない: ${headingRe}`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

// 番号付きリスト（継続行は先頭の空白でくっつける）
function numberedList(ls) {
  const items = [];
  for (const l of ls) {
    const m = /^(\d+)\.\s+(.*)$/.exec(l);
    if (m) items.push(m[2]);
    else if (/^\s+\S/.test(l) && items.length) items[items.length - 1] += "\n" + l.trim();
  }
  return items;
}

const usage = numberedList(sectionLines(/^## この表の使い方/));
const rules = numberedList(sectionLines(/^## 全件に効くルール/));

const numbersLines = sectionLines(/^## 数字の唯一の正/);
const numbersHeading = lines.find((l) => /^## 数字の唯一の正/.test(l)).replace(/^## /, "");
const numbers = [];
for (const l of numbersLines) {
  const m = /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/.exec(l);
  if (!m) continue;
  if (/^-+$/.test(m[1]) || m[1] === "項目") continue;
  numbers.push({ item: m[1], value: m[2] });
}
const numbersNote = numbersLines.map((l) => l.trim()).find((l) => /^\*\*.*\*\*$/.test(l)) ?? "";

// ---------- 見出し（版情報） ----------
const title = lines[0].replace(/^# /, "");
const intro = lines.slice(1).find((l) => l.trim() !== "") ?? "";

// ---------- カテゴリ本体 ----------

const CAT_RE = /^# カテゴリ([A-D])[　 ]+(.+?)（(\d+)件）$/;
const ITEM_RE = /^### ([A-D])-(\d{2}) (.+)$/;
const FIELD_RE = /^- \*\*(カテゴリ|場面|相手の発言|本文|根拠|注意|タグ)\*\*：(.*)$/;

const categories = {};
const items = [];
let cat = null;
let i = 0;
// カテゴリ A の見出しから、セルフチェックの見出しまでが本体。
const bodyStart = lines.findIndex((l) => CAT_RE.test(l));
const bodyEnd = lines.findIndex((l, idx) => idx > bodyStart && /^# セルフチェック/.test(l));
if (bodyStart < 0 || bodyEnd < 0) throw new Error("カテゴリ本体の範囲が取れない");

for (i = bodyStart; i < bodyEnd; i++) {
  const l = lines[i];
  const cm = CAT_RE.exec(l);
  if (cm) {
    cat = cm[1];
    // 「**全体方針**」の次行から空行 or --- まで
    let policy = [];
    let j = i + 1;
    while (j < bodyEnd && !/^\*\*全体方針\*\*/.test(lines[j]) && !ITEM_RE.test(lines[j])) j++;
    if (/^\*\*全体方針\*\*/.test(lines[j])) {
      for (j = j + 1; j < bodyEnd; j++) {
        if (lines[j].trim() === "" || lines[j].trim() === "---") break;
        policy.push(lines[j]);
      }
    }
    categories[cat] = { name: cm[2], declared: Number(cm[3]), policy: policy.join("\n") };
    continue;
  }
  const im = ITEM_RE.exec(l);
  if (!im) continue;

  // 1件の範囲: 次の ### か # か --- まで
  let end = i + 1;
  while (end < bodyEnd && !ITEM_RE.test(lines[end]) && !CAT_RE.test(lines[end])) end++;
  const block = lines.slice(i + 1, end);

  // 見出し: タイトルと【】の制約
  const rawTitle = im[3].trim();
  let constraintLabel = null;
  let constraint = null;
  let titleText = rawTitle;
  const tm = /^(.*?)[　 ]*【(.+?)】\s*$/.exec(rawTitle);
  if (tm) {
    titleText = tm[1].trim();
    constraintLabel = tm[2];
    // 前方一致で正規化（「委託限定で特に有効」も委託限定へ寄せる。Codex仕様と同じ）
    if (constraintLabel.startsWith("委託限定")) constraint = "委託限定";
    else if (constraintLabel.startsWith("規模限定")) constraint = "規模限定";
    else if (constraintLabel.startsWith("会計・出納")) constraint = "会計・出納部門向け";
    else constraint = constraintLabel;
  }

  // 項目: `- **名前**：` で始まり、次の `- **` までの継続行（先頭2空白）を含む
  const fields = {};
  let cur = null;
  for (const bl of block) {
    const fm = FIELD_RE.exec(bl);
    if (fm) {
      cur = fm[1];
      fields[cur] = fm[2] === "" ? [] : [fm[2]];
      continue;
    }
    // 継続行は先頭2空白。D群の本文には「  　その処理に…」のように全角スペースで
    // 始まる行があるので、\S ではなく「空でない」で判定する（全角スペースは JS では空白扱い）。
    if (cur && bl.startsWith("  ") && bl.trim() !== "") {
      fields[cur].push(bl.slice(2));
      continue;
    }
    if (cur && bl.trim() === "") {
      // 本文中の空行は保持（段落区切り）。ただし末尾は後で刈る
      fields[cur].push("");
      continue;
    }
    if (bl.trim() === "---") cur = null;
  }
  const text = (name) => (fields[name] ?? []).join("\n").replace(/\n+$/, "").trim();
  const bodyText = (fields["本文"] ?? []).join("\n").replace(/\n+$/, "");

  const id = `${im[1]}-${im[2]}`;
  const required = ["カテゴリ", "場面", "相手の発言", "本文", "根拠", "注意", "タグ"];
  for (const r of required) {
    if (!(r in fields)) throw new Error(`${id}: 項目「${r}」が無い`);
  }
  if (text("カテゴリ") !== im[1]) throw new Error(`${id}: カテゴリ欄が見出しと違う`);

  const saidRaw = text("相手の発言");
  const said = saidRaw === "―" || saidRaw === "" ? null : saidRaw;
  const tags = text("タグ")
    .split("、")
    .map((t) => t.trim())
    .filter(Boolean);

  items.push({
    id,
    cat: im[1],
    num: Number(im[2]),
    title: titleText,
    constraint,
    constraintLabel,
    scene: text("場面"),
    said,
    body: bodyText,
    evidence: text("根拠"),
    caution: text("注意"),
    tags,
  });
}

// ---------- 検証 ----------
const counts = {};
for (const it of items) counts[it.cat] = (counts[it.cat] ?? 0) + 1;
for (const [c, meta] of Object.entries(categories)) {
  if (meta.declared !== (counts[c] ?? 0)) {
    throw new Error(`カテゴリ${c}: 見出しの件数 ${meta.declared} と実件数 ${counts[c] ?? 0} が合わない`);
  }
}
const ids = new Set();
for (const it of items) {
  if (ids.has(it.id)) throw new Error(`ID重複: ${it.id}`);
  ids.add(it.id);
  if (!it.body) throw new Error(`${it.id}: 本文が空`);
  if (it.cat === "D") {
    for (const mark of ["【議員の問い】", "【職員の答弁例】", "【議員の再質問】"]) {
      if (!it.body.includes(mark)) throw new Error(`${it.id}: Dなのに ${mark} が無い`);
    }
  }
}

const out = {
  title,
  intro,
  sourceFile: src.split("/").pop(),
  generatedAt: new Date().toISOString(),
  total: items.length,
  counts,
  categories,
  usage,
  rules,
  numbersHeading,
  numbers,
  numbersNote,
  items,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

const byConstraint = {};
for (const it of items) if (it.constraint) (byConstraint[it.constraint] ??= []).push(it.id);
console.log(`書き出し: ${OUT}`);
console.log(`件数: ${items.length}`, counts);
console.log("制約:", byConstraint);
console.log(`使い方 ${usage.length}項目 / 全件ルール ${rules.length}項目 / 数字 ${numbers.length}行`);
