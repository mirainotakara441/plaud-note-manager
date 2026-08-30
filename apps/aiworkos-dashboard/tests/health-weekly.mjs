#!/usr/bin/env node
// 健康習慣レポート（週次）の下書き（lib/healthWeekly.mjs）のテスト。
//
// いちばん守りたいのは「記録が無い日を埋めないこと」。
// 歩数が平均値で潰れていた件（2026-08）と同じ事故を、レポート側で繰り返さない。

import { weekRange, fmtMd, summarize, buildReport } from "../lib/healthWeekly.mjs";

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

// ── 週の範囲は土曜始まり（これまでのレポートの形） ──────────────
check("土曜を選ぶとその日が週頭", weekRange("2026-08-15"), { start: "2026-08-15", end: "2026-08-21" });
check("週の途中を選んでも同じ週", weekRange("2026-08-19"), { start: "2026-08-15", end: "2026-08-21" });
check("金曜は週の最終日", weekRange("2026-08-21"), { start: "2026-08-15", end: "2026-08-21" });
check("次の土曜は次の週", weekRange("2026-08-22"), { start: "2026-08-22", end: "2026-08-28" });
check("曜日つきの表示", fmtMd("2026-08-15"), "8/15(土)");

// ── 実データ（8/15〜8/21）に近い形 ───────────────────────────
const rows = [
  { day: "2026-08-15", weight_kg: 90.05, body_fat_pct: 29.3, muscle_kg: 60.35, steps: 2797, kcal: null, protein_g: null, fat_g: null, carbs_g: null, salt_g: null, sleep_h: 8 },
  { day: "2026-08-16", weight_kg: 91.55, body_fat_pct: 30.2, muscle_kg: 60.55, steps: 2491, kcal: 1858, protein_g: 85.1, fat_g: 66.8, carbs_g: 240.4, salt_g: 11.02, sleep_h: 5 },
  { day: "2026-08-17", weight_kg: 91.75, body_fat_pct: 30.9, muscle_kg: 60.15, steps: 4425, kcal: null, protein_g: null, fat_g: null, carbs_g: null, salt_g: null, sleep_h: 8 },
  { day: "2026-08-18", weight_kg: 92.0, body_fat_pct: 30.8, muscle_kg: 60.35, steps: 1561, kcal: null, protein_g: null, fat_g: null, carbs_g: null, salt_g: null, sleep_h: 7.5 },
  { day: "2026-08-19", weight_kg: 91.4, body_fat_pct: 31.2, muscle_kg: 59.65, steps: 7154, kcal: 1652, protein_g: 90.9, fat_g: 55.0, carbs_g: 198.8, salt_g: 10.92, sleep_h: 4.5 },
  { day: "2026-08-20", weight_kg: 90.6, body_fat_pct: 33.2, muscle_kg: 57.4, steps: 2985, kcal: 1836, protein_g: 85.2, fat_g: 41.4, carbs_g: 278.3, salt_g: 11.72, sleep_h: 7 },
  { day: "2026-08-21", weight_kg: 91.85, body_fat_pct: 31.9, muscle_kg: 59.3, steps: 7009, kcal: 1852, protein_g: 114.1, fat_g: 71.5, carbs_g: 202.3, salt_g: 10.3, sleep_h: 7 },
];

// ── 集計。**記録がある日数を必ず一緒に返す** ────────────────────
{
  const s = summarize(rows);
  check("歩数の合計", s.steps.sum, 28422);
  check("歩数の平均", Math.round(s.steps.avg), 4060);
  check("歩数は7日ぶん", s.steps.days, 7);
  check("食事は4日ぶんしかない", s.kcal.days, 4);
  check("食事の平均は記録がある4日で割る", Math.round(s.kcal.avg), 1800);
  check("体重の最小・最大", [s.weight.min, s.weight.max], [90.05, 92.0]);
  check("筋肉量も集計される", s.muscle.days, 7);
  check("睡眠も集計される", s.sleep.days, 7);
}

// ── 記録が無い日を埋めない ★いちばん大事 ──────────────────────
{
  const s = summarize(rows);
  // 4日ぶんの合計 ÷ 7 ではなく ÷ 4。欠測を0扱いすると平均が1029kcalになる。
  check("欠測日を0で埋めない", Math.round(s.kcal.avg) !== Math.round(7198 / 7), true);

  const body = buildReport({ start: "2026-08-15", end: "2026-08-21" }, rows);
  check("欠測日は「記録なし」と書く", body.includes("記録なし"), true);
  check("どの日が欠測かを名指しする", body.includes("8/15(土)・8/17(月)・8/18(火)"), true);
  check("記録があった日数を書く", body.includes("記録があったのは 4日"), true);
  check("歩数も日数を添える", body.includes("（7日ぶん）"), true);
}

// ── 本文の形 ────────────────────────────────────────────
{
  const body = buildReport({ start: "2026-08-15", end: "2026-08-21" }, rows);
  check("見出し", body.startsWith("健康週間レポート（2026/08/15〜2026/08/21）"), true);
  for (const sec of ["① 体組成", "② 食事", "③ 歩数", "④ 睡眠"]) {
    check(`区画がある: ${sec}`, body.includes(sec), true);
  }
  check("週間総歩数", body.includes("週間総歩数 28,422歩"), true);
  check("筋肉量が表に出る", body.includes("60.35kg"), true);
  check("★は勝手に付けない", body.includes("総合評価"), false);
}

// ── 総合評価は人が入れたぶんだけ出す ──────────────────────────
{
  const body = buildReport({ start: "2026-08-15", end: "2026-08-21" }, rows, {
    ratings: {
      体重: { stars: 4, comment: "90〜92kg台で推移" },
      体脂肪率: { stars: 5, comment: "今年最良" },
      歩数: { comment: "回復週として許容範囲" },
    },
    notes: "8/18 大木眼科受診。緑内障・HbA1c共に良好。",
  });
  check("総合評価が出る", body.includes("総合評価"), true);
  check("★4", body.includes("★★★★☆"), true);
  check("★5", body.includes("★★★★★"), true);
  check("★が無くてもコメントは出す", body.includes("回復週として許容範囲"), true);
  check("備考も出る", body.includes("大木眼科"), true);
}

// ── 睡眠の記録が無い週 ────────────────────────────────────
{
  const noSleep = rows.map((r) => ({ ...r, sleep_h: null }));
  const body = buildReport({ start: "2026-08-15", end: "2026-08-21" }, noSleep);
  check("睡眠が無ければそう書く", body.includes("④ 睡眠\n\n記録がありません。"), true);
}

// ── 何も無い週でも落ちない ────────────────────────────────
{
  const empty = rows.map((r) => ({
    day: r.day, weight_kg: null, body_fat_pct: null, muscle_kg: null,
    steps: null, kcal: null, protein_g: null, fat_g: null, carbs_g: null, salt_g: null, sleep_h: null,
  }));
  const body = buildReport({ start: "2026-08-15", end: "2026-08-21" }, empty);
  check("空の週でも本文は組める", body.length > 100, true);
  check("空の週は平均を—にする", body.includes("体重 —kg（0日）"), true);
}

console.log(`\n合格 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`\x1b[31m✗ 健康週次レポートが ${failed} 件落ちました\x1b[0m`);
  process.exit(1);
}
