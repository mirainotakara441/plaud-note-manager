#!/usr/bin/env node
// ラーメンの種別判定（lib/ramenBowlType.mjs）のテスト。
//
// いちばん守りたいのは「本人の手入力が自動判定に負けないこと」と
// 「分からない味を無理に当てないこと」。集計が静かに間違うのを防ぐ。

import {
  BOWL_STYLES,
  BOWL_TASTES,
  bowlStyleOf,
  bowlTasteOf,
  summarizeBowlTypes,
  tabelogShopId,
  normalizeShopName,
} from "../lib/ramenBowlType.mjs";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else {
    failed += 1;
    console.error(`\x1b[31m✗ ${label}\x1b[0m`);
    console.error(`    期待: ${e}`);
    console.error(`    実際: ${a}`);
  }
}

// ── 形態 ────────────────────────────────────────────────────────
check("menu の「つけ麺」", bowlStyleOf({ menu: "特製つけ麺 M" }), "つけ麺");
check("menu の「つけそば」もつけ麺", bowlStyleOf({ menu: "つけそば（カツオ）" }), "つけ麺");
check("まぜそば", bowlStyleOf({ menu: "味玉まぜそばジャック 大盛" }), "まぜそば・油そば");
check("汁なし担々麺は担々麺より先にまぜそば扱いにしない", bowlStyleOf({ menu: "汁なし担々麺一辛大盛" }), "まぜそば・油そば");
check("冷やし中華", bowlStyleOf({ menu: "冷やし中華1180円" }), "冷やし");
check("冷やしラーメンも冷やし", bowlStyleOf({ menu: "厳選鶏出汁の冷やしラーメン" }), "冷やし");
check("ちゃんぽん", bowlStyleOf({ title: "【109杯目】 ちゃんぽん 旨いっ！！！" }), "ちゃんぽん");
check("何も無ければラーメン", bowlStyleOf({ title: "【112杯目】 久々だが旨すぎた！！" }), "ラーメン");
check("menu が無くても excerpt から拾う", bowlStyleOf({ title: "旨い", excerpt: "今日はつけ麺を大盛で。" }), "つけ麺");
check("menu があれば excerpt より menu を信じる", bowlStyleOf({ menu: "塩ラーメン中盛", excerpt: "隣の人のつけ麺も旨そう" }), "ラーメン");
check("店ジャンルは本文に何も無いときだけ", bowlStyleOf({ title: "美味", genre: "つけ麺、ラーメン" }), "つけ麺");
check("店ジャンルは先頭だけ見る", bowlStyleOf({ title: "美味", genre: "ラーメン、つけ麺" }), "ラーメン");

// 手入力が勝つ
check("bowl_style があれば自動判定より優先", bowlStyleOf({ bowl_style: "担々麺", menu: "特製つけ麺" }), "担々麺");
check("語彙に無い手入力は無視して自動判定", bowlStyleOf({ bowl_style: "うどん", menu: "特製つけ麺" }), "つけ麺");

// ── 味・系統 ────────────────────────────────────────────────────
check("塩", bowlTasteOf({ menu: "塩ラーメン中盛" }), "塩");
check("味噌", bowlTasteOf({ menu: "味玉辛味噌ラーメン" }), "味噌");
check("辛味噌は味噌が勝つ（辛は最後）", bowlTasteOf({ menu: "旨辛赤味噌つけ麺" }), "味噌");
check("家系は最優先", bowlTasteOf({ title: "長崎市で家系ラーメン", excerpt: "醤油豚骨のスープ" }), "家系");
check("店名から二郎系", bowlTasteOf({ shop: "ラーメン豚山 池袋西口店", menu: "小ラーメン" }), "二郎系");
check("煮干し", bowlTasteOf({ shop: "煮干しつけ麺 宮元", menu: "つけ麺" }), "煮干し・魚介");
check("店名の博多で豚骨", bowlTasteOf({ shop: "博多一幸舎 総本店", title: "スープの旨味が半端ない" }), "豚骨");
check("手がかりが無ければ null（無理に当てない）", bowlTasteOf({ shop: "中華そば べんてん", title: "台風でもすごい行列！" }), null);
check("menu に味があれば本文より menu を信じる", bowlTasteOf({ menu: "特製塩中華そば 大盛", memo: "限定でまぜ家系もある" }), "塩");
check("menu に味が無ければ店名・本文から拾う", bowlTasteOf({ shop: "煮干しつけ麺 宮元", menu: "つけ麺 大盛" }), "煮干し・魚介");
check("bowl_taste があれば優先", bowlTasteOf({ bowl_taste: "醤油", menu: "塩ラーメン" }), "醤油");
check("語彙に無い手入力は無視", bowlTasteOf({ bowl_taste: "カレー", menu: "塩ラーメン" }), "塩");

// ── 集計 ────────────────────────────────────────────────────────
const rows = [
  { menu: "特製つけ麺" },
  { menu: "塩ラーメン" },
  { menu: "つけ麺 大盛り" },
  { title: "旨い" },
  { bowl_style: "担々麺", bowl_taste: "辛" },
];
const sum = summarizeBowlTypes(rows);
check("形態は全杯を数える", sum.styles, [
  { label: "つけ麺", count: 2 },
  { label: "ラーメン", count: 2 },
  { label: "担々麺", count: 1 },
]);
check("味は分かった杯だけ数える", sum.tastes, [
  { label: "塩", count: 1 },
  { label: "辛", count: 1 },
]);
check("味が分からなかった杯数は別置き", sum.tasteUnknown, 3);
// APIが判定済みの行（style/taste が付いている＝本文は無い）はそのまま数える
const pre = summarizeBowlTypes([
  { style: "つけ麺", taste: "煮干し・魚介" },
  { style: "つけ麺", taste: null },
  { style: "ラーメン", taste: "塩" },
]);
check("判定済みの style はそのまま数える（本文が無くても）", pre.styles, [
  { label: "つけ麺", count: 2 },
  { label: "ラーメン", count: 1 },
]);
check("判定済みの taste=null は不明として数える（判定し直さない）", pre.tasteUnknown, 1);
check("判定済みの taste はそのまま数える", pre.tastes, [
  { label: "塩", count: 1 },
  { label: "煮干し・魚介", count: 1 },
]);
check("同数は五十音順", summarizeBowlTypes([{ menu: "味噌ラーメン" }, { menu: "塩ラーメン" }]).tastes, [
  { label: "塩", count: 1 },
  { label: "味噌", count: 1 },
]);

// ── 語彙 ────────────────────────────────────────────────────────
check("形態の語彙は6つ", BOWL_STYLES.length, 6);
check("味の語彙は9つ", BOWL_TASTES.length, 9);
check("判定結果は必ず語彙の中", BOWL_STYLES.includes(bowlStyleOf({ menu: "なんでもいい" })), true);

// ── 食べログ店ID ────────────────────────────────────────────────
check("店URLから店ID", tabelogShopId("https://tabelog.com/tokyo/A1322/A132204/13200351/"), "13200351");
check("末尾スラッシュ無しでも", tabelogShopId("https://tabelog.com/tokyo/A1322/A132204/13200351"), "13200351");
check("クエリ付きでも", tabelogShopId("https://tabelog.com/tokyo/A1322/A132204/13200351/?ref=x"), "13200351");
check("口コミURL（末尾が口コミID）は店IDにしない", tabelogShopId("https://tabelog.com/tokyo/A1322/A132204/13200351/dtlrvwlst/B123/"), null);
check("null は null", tabelogShopId(null), null);
check("店名の照合は空白と全角半角だけ吸収", normalizeShopName("中華そば　べんてん"), normalizeShopName("中華そば べんてん"));
check("店名の照合は表記の違いまでは寄せない", normalizeShopName("べんてん") === normalizeShopName("弁天"), false);

console.log(`\nラーメン種別判定: ${passed} 合格 / ${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
