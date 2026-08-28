#!/usr/bin/env node
// タイトル末尾のチャンク接尾辞を落とす規則のテスト。
//
// この規則は2026-08-26〜08-29のあいだ、Edge Function（org-history）と
// アプリ（lib/organizations.ts）で食い違っていた。実装を _shared に1本化した
// ので、ここでは「1本化された規則が何を落として何を残すか」を固定する。
//
// 特に大事なのは2つ。
//   ・実データにいちばん多い ｜N（裸の数字・621件）を落とすこと
//     ——ここが落ちていなかったのが件数バグの正体
//   ・チャンク番号でない末尾（｜全体 ｜報告書）は残すこと
//     ——消しすぎると別々の文書を1つに潰してしまう

import { hasChunkSuffix, stripChunkSuffix } from "../lib/chunkTitle.mjs";

let passed = 0;
let failed = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`\x1b[31m✗ ${label}\x1b[0m`);
    console.error(`    期待: ${JSON.stringify(expected)}`);
    console.error(`    実際: ${JSON.stringify(actual)}`);
  }
}

// --- 落とす形式（監査で実在を数えたもの） ---------------------------
eq("｜n/m を落とす", stripChunkSuffix("八王子市 定例会｜1/16"), "八王子市 定例会");
eq("｜textN を落とす", stripChunkSuffix("提案書｜text1"), "提案書");
eq("｜slideN を落とす", stripChunkSuffix("提案書｜slide12"), "提案書");
eq("｜imgN を落とす", stripChunkSuffix("提案書｜img3"), "提案書");
eq("｜pN を落とす", stripChunkSuffix("報告書｜p1"), "報告書");
eq("｜pN-N を落とす", stripChunkSuffix("報告書｜p10-1"), "報告書");
// 実データで最多（621件）。org-history はこれを落とせておらず件数が膨らんでいた。
eq("｜N（裸の数字）を落とす", stripChunkSuffix("札幌市 打合せ｜2"), "札幌市 打合せ");

// --- 残す形式 -------------------------------------------------------
eq("｜全体 は残す", stripChunkSuffix("2026-07-06週｜全体"), "2026-07-06週｜全体");
eq("｜報告書 は残す", stripChunkSuffix("横浜市｜報告書"), "横浜市｜報告書");
eq("接尾辞なしはそのまま", stripChunkSuffix("新宿区との面談戦略"), "新宿区との面談戦略");
eq("数字を含むが接尾辞でない", stripChunkSuffix("7/23商談の最終戦略"), "7/23商談の最終戦略");

// 「2026-07-06週｜全体」は ｜全体 を落とさないので親のまま。
// もし ｜全体 まで落とすと、別カテゴリーの週報どうしが1つに潰れる。
eq("週報のカテゴリーを潰さない", stripChunkSuffix("2026-07-20週｜全体"), "2026-07-20週｜全体");

// --- 積み重なった接尾辞 ---------------------------------------------
eq("2段", stripChunkSuffix("提案書｜slide1｜1"), "提案書");
eq("3段", stripChunkSuffix("提案書｜報告書｜slide1｜1"), "提案書｜報告書");
eq("｜n/m のうえに ｜N", stripChunkSuffix("議事録｜1/7｜8"), "議事録");

// --- 消しすぎない安全弁 ---------------------------------------------
// 全部消えて空になるなら、束ねずに元を返す。取り違えより残すほうが安全。
eq("全部が接尾辞なら元を返す", stripChunkSuffix("｜1"), "｜1");
eq("空文字", stripChunkSuffix(""), "");
eq("前後の空白は落とす", stripChunkSuffix("  提案書｜text1  "), "提案書");

// --- hasChunkSuffix -------------------------------------------------
eq("残っていれば true", hasChunkSuffix("提案書｜text1"), true);
eq("剥がし切れば false", hasChunkSuffix(stripChunkSuffix("提案書｜slide1｜1")), false);
eq("｜全体 は接尾辞でない", hasChunkSuffix("2026-07-06週｜全体"), false);

// --- 実装が1本であること（食い違いの再発防止） ----------------------
// lib/chunkTitle.mjs は _shared/chunkTitle.mjs を再輸出するだけの薄い層。
// 別実装を置くとここが落ちる。
const shared = await import("../supabase/functions/_shared/chunkTitle.mjs");
eq("薄い層と実体が同じ関数", shared.stripChunkSuffix === stripChunkSuffix, true);
eq("hasChunkSuffix も同じ関数", shared.hasChunkSuffix === hasChunkSuffix, true);

console.log(`\n合格 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
