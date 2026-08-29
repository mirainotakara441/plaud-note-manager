#!/usr/bin/env node
// AIキャッシュ署名（lib/cacheSignature.mjs）のテスト。
//
// この署名は「Claudeを呼ばずに古い回答を返してよいか」を決める唯一の判定なので、
// **変化を取りこぼす方向の間違い**が一番痛い。旧版は件数と content.length の
// 合計しか見ておらず、並べ替えても誤字を直しても署名が変わらなかった。
// ここで固定するのは主に「変わるべきときに変わること」。

import {
  SIGNATURE_VERSION,
  rowFingerprint,
  proposalSignature,
  monthlyReportSignature,
} from "../lib/cacheSignature.mjs";

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`\x1b[31m✗ ${label}\x1b[0m`);
    if (detail !== undefined) console.error(`    ${detail}`);
  }
}

const row = (id, content, similarity) => ({ id, content, similarity });
const meeting = (id, content, event_date) => ({ id, content, event_date });

// ── 1. 同じ入力なら同じ署名（決定的） ─────────────────────────────
{
  const m = [meeting("m1", "会議の本文", "2026-08-01")];
  const d = [row("d1", "成果物A", 0.91), row("d2", "成果物B", 0.88)];
  const c = [row("c1", "共通1", 0.85)];
  check("1. 決定的（同じ入力→同じ署名）", proposalSignature(m, d, c) === proposalSignature(m, d, c));
  check("1. 決定的（月報）", monthlyReportSignature([{ id: "w1", summary: "あ", created_at: "2026-08-01" }])
    === monthlyReportSignature([{ id: "w1", summary: "あ", created_at: "2026-08-01" }]));
}

// ── 2. 順序だけ変えたら署名が変わる（★今回の主題） ────────────────
{
  const a = [row("d1", "AAA", 0.91), row("d2", "BBB", 0.88), row("d3", "CCC", 0.80)];
  const b = [a[1], a[0], a[2]];                       // 集合は同じ・順序だけ違う
  check("2. 成果物の順序を入れ替えたら署名が変わる", proposalSignature([], a, []) !== proposalSignature([], b, []));
  check("2. 共通資料の順序を入れ替えたら署名が変わる", proposalSignature([], [], a) !== proposalSignature([], [], b));
  const m1 = [meeting("m1", "X", "2026-08-01"), meeting("m2", "Y", "2026-08-02")];
  check("2. 会議の順序を入れ替えたら署名が変わる",
    proposalSignature(m1, [], []) !== proposalSignature([m1[1], m1[0]], [], []));
  const w = [{ id: "w1", summary: "A", created_at: "2026-08-01" },
             { id: "w2", summary: "B", created_at: "2026-08-02" }];
  check("2. 月報も順序で変わる", monthlyReportSignature(w) !== monthlyReportSignature([w[1], w[0]]));
  // 旧実装なら一致していたことを、旧ロジックを再現して示す
  const oldSig = (rows) => `d${rows.length}:${rows.reduce((s, r) => s + r.content.length, 0)}`;
  check("2. 旧方式なら順序を変えても同じだった（回帰の証拠）", oldSig(a) === oldSig(b));
}

// ── 3. 文字数が同じまま本文だけ変わったら署名が変わる ──────────────
//    誤字辞書140語のうち40語が同じ文字数の置換。実在の語で試す。
{
  for (const [wrong, correct] of [["精霊市", "政令市"], ["富士フィルム", "富士フイルム"],
                                  ["東洋資料", "東洋紙業"], ["有勝化", "有償化"]]) {
    check(`3. ${wrong}→${correct}（同じ文字数）で署名が変わる`,
      wrong.length === correct.length &&
      proposalSignature([], [row("d1", `${wrong}の件`, 0.9)], []) !==
      proposalSignature([], [row("d1", `${correct}の件`, 0.9)], []),
      `長さ ${wrong.length} vs ${correct.length}`);
  }
  check("3. 月報も同じ文字数の書き直しで変わる",
    monthlyReportSignature([{ id: "w1", summary: "精霊市の件", created_at: "2026-08-01" }]) !==
    monthlyReportSignature([{ id: "w1", summary: "政令市の件", created_at: "2026-08-01" }]));
  check("3. insight だけ直しても変わる",
    monthlyReportSignature([{ id: "w1", summary: "A", insight: "精霊市", created_at: "2026-08-01" }]) !==
    monthlyReportSignature([{ id: "w1", summary: "A", insight: "政令市", created_at: "2026-08-01" }]));
  check("3. tactic だけ直しても変わる",
    monthlyReportSignature([{ id: "w1", summary: "A", tactic: "精霊市", created_at: "2026-08-01" }]) !==
    monthlyReportSignature([{ id: "w1", summary: "A", tactic: "政令市", created_at: "2026-08-01" }]));
}

// ── 4. 件数も文字数も同じで別文書なら署名が変わる ────────────────
{
  const a = [row("d1", "AAA", 0.9), row("d2", "BBB", 0.8)];
  const b = [row("d3", "CCC", 0.9), row("d4", "DDD", 0.8)];   // 件数2・各3文字で同じ
  const oldSig = (rows) => `d${rows.length}:${rows.reduce((s, r) => s + r.content.length, 0)}`;
  check("4. 旧方式なら別文書でも同じ署名だった（回帰の証拠）", oldSig(a) === oldSig(b));
  check("4. 別文書なら署名が変わる", proposalSignature([], a, []) !== proposalSignature([], b, []));
  // id だけ違って本文が同じでも変わること
  check("4. idだけ違っても変わる",
    proposalSignature([], [row("d1", "AAA", 0.9)], []) !== proposalSignature([], [row("dX", "AAA", 0.9)], []));
}

// ── 5. v2: 接頭辞 ───────────────────────────────────────────────
{
  check("5. 版が v2", SIGNATURE_VERSION === "v2");
  check("5. 提案署名が v2: で始まる", proposalSignature([], [], []).startsWith("v2:"));
  check("5. 月報署名が v2: で始まる", monthlyReportSignature([]).startsWith("v2:"));
  check("5. 先頭に読める件数が残る（障害調査用）",
    /^v2:m0:d1:c2:/.test(proposalSignature([], [row("d1", "x", 0.5)],
      [row("c1", "y", 0.5), row("c2", "z", 0.5)])),
    proposalSignature([], [row("d1", "x", 0.5)], [row("c1", "y", 0.5), row("c2", "z", 0.5)]));
}

// ── 6. similarity が無くても安定する ────────────────────────────
{
  const m = [meeting("m1", "本文", "2026-08-01")];   // 会議は similarity を持たない
  check("6. similarityなしでも落ちない", typeof proposalSignature(m, [], []) === "string");
  check("6. similarityなしでも決定的", proposalSignature(m, [], []) === proposalSignature(m, [], []));
  check("6. similarityがnull/undefinedでも落ちない",
    typeof proposalSignature([], [{ id: "d1", content: "x" }, { id: "d2", content: "y", similarity: null }], []) === "string");
  check("6. 空配列でも落ちない", typeof proposalSignature([], [], []) === "string");
  check("6. null を渡しても落ちない", typeof proposalSignature(null, null, null) === "string");
  check("6. content が無くても落ちない", typeof rowFingerprint({ id: "a" }) === "string");
  check("6. NaN の similarity は - になる", rowFingerprint({ id: "a", similarity: NaN }).includes("#-#"));
}

// ── 7. agent と月報が同じ実装を使っている ───────────────────────
{
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
  for (const [name, file, fn] of [
    ["agent", "app/api/agent/route.ts", "proposalSignature"],
    ["月報", "app/api/monthly-report/route.ts", "monthlyReportSignature"],
  ]) {
    const src = readFileSync(join(ROOT, file), "utf8");
    check(`7. ${name}: 共有モジュールから読む`, src.includes(`from "@/lib/cacheSignature.mjs"`));
    check(`7. ${name}: ${fn} を使う`, src.includes(`const computeSignature = ${fn};`));
    check(`7. ${name}: 自前で署名を組み立てていない`,
      !/function computeSignature\s*\(/.test(src), "route内に旧実装が残っている");
  }
}

// ── 8. 本番にあった旧署名5件と、新形式が一致しないこと ────────────
//    形式を変えたのに古いキャッシュが生き残る事故を防ぐ。
{
  const OLD = [
    "14:2026-06-18:2789:d21:4920:c20:7409",   // 北九州市（手直し済み）
    "16:2026-07-16:2818:d0:0:c20:4986",       // 横浜市（手直し済み）
    "2:2025-11-19:432:d0:0:c20:4449",         // 広島市
    "0::0:d40:16817:c20:5440",                // 政令市
    "1:2026-07-31:434:d0:0:c20:7078",         // 辻義隆(大阪市議会議員)
  ];
  for (const old of OLD) {
    check(`8. 旧署名は v2: で始まらない（${old.slice(0, 18)}…）`, !old.startsWith("v2:"));
  }
  // どんな入力でも旧署名と一致しない（接頭辞が違うので原理的に不可能）
  const samples = [
    proposalSignature([], [], []),
    proposalSignature([meeting("m1", "x", "2026-06-18")], [row("d1", "y", 0.9)], []),
    monthlyReportSignature([{ id: "w1", summary: "z", created_at: "2026-07-16" }]),
  ];
  check("8. 新署名が旧5件のどれとも一致しない", samples.every((s) => !OLD.includes(s)));
}

console.log(`\n合格 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
