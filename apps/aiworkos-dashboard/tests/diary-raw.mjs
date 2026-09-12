#!/usr/bin/env node
// 一行日記の「原文」検証（lib/diaryRaw.mjs）のテスト。
//
// ここで守りたいのは「通してはいけないものを通さないこと」。
// Claudeが整形・要約したものを原文として保存すると、
// 「原文」と名乗る別物が残る。それは原文を残さないより悪い。

import { normalizeForCompare, verifyRawSpan, splitForNotionBlocks } from "../lib/diaryRaw.mjs";

let passed = 0, failed = 0;
function check(label, ok, detail) {
  if (ok) passed += 1;
  else { failed += 1; console.error(`\x1b[31m✗ ${label}\x1b[0m`); if (detail !== undefined) console.error(`    ${detail}`); }
}

const PASTED = `9/10
◇印象的だったこと
8:00〜ワークスタイリングで業務、8:30〜熊本市ユニット会議で3点決定。
石田本部長から「見るべきは自分たちの頑張りでなく相手側の反応」とのコメント。
◇そうか
尾崎議員・井下田議員・犬山市の反応もすべて相手側の反応だという気づき。
◇やってみよう
管理資料に「お客様のネガティブな意見一覧」の欄を作る

9/11
◇印象的だったこと
板橋事業所での戦略会議で、石田本部長から11月5,000件の確実な実行を指摘された。
◇そうか
意志が濁れば意地になる。`;

// ── 通すべきもの ────────────────────────────────────────────
{
  const day10 = `9/10
◇印象的だったこと
8:00〜ワークスタイリングで業務、8:30〜熊本市ユニット会議で3点決定。
石田本部長から「見るべきは自分たちの頑張りでなく相手側の反応」とのコメント。
◇そうか
尾崎議員・井下田議員・犬山市の反応もすべて相手側の反応だという気づき。
◇やってみよう
管理資料に「お客様のネガティブな意見一覧」の欄を作る`;
  const r = verifyRawSpan(PASTED, day10);
  check("そのまま切り出したものは通る", r.ok, r.reason);
  check("通ったら raw が返る", r.raw === day10);

  // 行頭行末の空白・改行コードの揺れは許す（貼り付けやAPI往復で普通に起きる）
  const wobbly = day10.replace(/\n/g, " \r\n ");
  check("行頭行末の空白と改行コードの揺れは許す", verifyRawSpan(PASTED, wobbly).ok,
    verifyRawSpan(PASTED, wobbly).reason);

  // ただし**行の途中**にスペースを入れるのは「文字が変わった」ので通さない。
  // 日本語の文中スペースは意味を持ちうるし、ここを緩めるとClaudeの整形を
  // 原文として受け入れてしまう。
  const midLine = day10.replace("8:00〜ワークスタイリング", "8:00〜 ワークスタイリング");
  check("行の途中へのスペース挿入は通さない", !verifyRawSpan(PASTED, midLine).ok);

  const day11 = `9/11
◇印象的だったこと
板橋事業所での戦略会議で、石田本部長から11月5,000件の確実な実行を指摘された。
◇そうか
意志が濁れば意地になる。`;
  check("2日目も通る", verifyRawSpan(PASTED, day11).ok);
}

// ── 通してはいけないもの ─────────────────────────────────────
{
  const summarized = "9/10 熊本市ユニット会議で3点決定し、石田本部長から相手側の反応を見よとの指摘を受けた。";
  check("要約は通さない", !verifyRawSpan(PASTED, summarized).ok);

  const reworded = PASTED.replace("見るべきは", "大切なのは");
  check("語を差し替えたものは通さない", !verifyRawSpan(PASTED, reworded).ok);

  const reordered = `◇そうか
尾崎議員・井下田議員・犬山市の反応もすべて相手側の反応だという気づき。
◇印象的だったこと
8:00〜ワークスタイリングで業務、8:30〜熊本市ユニット会議で3点決定。`;
  check("順序を入れ替えたものは通さない", !verifyRawSpan(PASTED, reordered).ok);

  const fabricated = PASTED + "\nそして新しい事実を付け足した。";
  check("付け足したものは通さない", !verifyRawSpan(PASTED, fabricated).ok);

  check("空は通さない", !verifyRawSpan(PASTED, "").ok);
  check("nullは通さない", !verifyRawSpan(PASTED, null).ok);
  check("undefinedは通さない", !verifyRawSpan(PASTED, undefined).ok);
  check("短すぎるものは通さない", !verifyRawSpan(PASTED, "9/10").ok);
  check("数字だけは通さない", !verifyRawSpan(PASTED, "3点決定").ok);
  // 「部分文字列ではあるが短い」ケース。20字の下限が効いていること
  check("短い部分文字列も通さない", !verifyRawSpan(PASTED, "石田本部長から").ok);
}

// ── 落ちた理由が返ること ───────────────────────────────────
{
  const r = verifyRawSpan(PASTED, "まったく別の文章をここに入れてみる。十分な長さがある。");
  check("落ちたら理由が入る", typeof r.reason === "string" && r.reason.length > 0, JSON.stringify(r));
  check("落ちたら raw は null", r.raw === null);
}

// ── normalizeForCompare は文字を変えない ────────────────────
{
  check("固有名詞は変えない", normalizeForCompare("石田本部長　と　幾野さん").includes("石田本部長"));
  check("数字は変えない", normalizeForCompare("11月5,000件").includes("5,000"));
  check("改行コードを畳む", normalizeForCompare("a\r\nb") === "a\nb");
  check("全角スペースを畳む", normalizeForCompare("a　　b") === "a b");
}

// ── Notion ブロック分割 ─────────────────────────────────────
{
  check("短ければ1ブロック", splitForNotionBlocks("短い").length === 1);
  check("空なら0ブロック", splitForNotionBlocks("").length === 0);
  const long = Array.from({ length: 60 }, (_, i) => `${i}行目の内容をここに書く。`).join("\n");
  const parts = splitForNotionBlocks(long, 200);
  check("長ければ分割される", parts.length > 1);
  check("各ブロックが上限以内", parts.every((p) => p.length <= 200), parts.map((p) => p.length).join(","));
  // ★分割しても文字が失われないこと。ここが壊れると原文が欠ける
  check("結合すると元に戻る（空白の揺れを除く）",
    normalizeForCompare(parts.join("\n")) === normalizeForCompare(long));
  const noNewline = "あ".repeat(500);
  const p2 = splitForNotionBlocks(noNewline, 200);
  check("改行が無くても分割できる", p2.every((p) => p.length <= 200) && p2.join("") === noNewline);
}

console.log(`\n合格 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
