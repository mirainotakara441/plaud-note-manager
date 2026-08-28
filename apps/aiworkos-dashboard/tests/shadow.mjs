#!/usr/bin/env node
// Memory 2.0 Shadow Mode の純粋ロジックのテスト。
//
// サーバーもDBも要らない。node が lib/memoryShadow.mjs を直接読んで動かす。
//
// いちばん大事なのは最後のケース（1実体 × 複数版 × 複数チャンク）。
// 2026-08-28 時点の実データには存在しないが、同じ録音から
// PLAUD版3チャンクと Notion版3チャンクが入った瞬間に、
// 「版ではなく実体で番号を振る」実装は6チャンクを0〜5の一列に混ぜて壊れる。
// 実データで踏めない条件だからこそ、ここで踏んでおく。

import {
  summarizeShadow,
  findMultiVariantCanonicals,
  auditShadowColumns,
  compareWithOld,
} from "../lib/memoryShadow.mjs";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`\x1b[31m✗ ${label}\x1b[0m`);
    console.error(`    期待: ${e}`);
    console.error(`    実際: ${a}`);
  }
}

/** テスト行を作る小さな道具。 */
function row(canonical, sourceDoc, chunkIndex, extra = {}) {
  return {
    source_type: "会議",
    canonical_document_id: canonical,
    source_document_id: sourceDoc,
    chunk_index: chunkIndex,
    ingest_scheme: "plaud",
    title: `${sourceDoc}｜${chunkIndex + 1}`,
    organization: null,
    event_date: "2026-08-28",
    ...extra,
  };
}

// ── ケース1: 1実体 = 1版 = 1チャンク（いちばん普通の形） ──────────────
{
  const rows = [row("plaud:AAA", "plaud:AAA", 0)];
  const s = summarizeShadow(rows);
  check("1実体1版: chunk数", s.chunks, 1);
  check("1実体1版: 実体数", s.canonicalDocuments, 1);
  check("1実体1版: 取り込み文書数", s.sourceDocuments, 1);
  check("1実体1版: 別version無し", findMultiVariantCanonicals(rows).length, 0);
  check("1実体1版: 健全", auditShadowColumns(rows).healthy, true);
}

// ── ケース2: 1版 = 複数チャンク ────────────────────────────────
{
  const rows = [
    row("plaud:BBB", "plaud:BBB", 0),
    row("plaud:BBB", "plaud:BBB", 1),
    row("plaud:BBB", "plaud:BBB", 2),
  ];
  const s = summarizeShadow(rows);
  check("1版複数チャンク: chunk数", s.chunks, 3);
  check("1版複数チャンク: 実体は1つ", s.canonicalDocuments, 1);
  check("1版複数チャンク: 取り込み文書も1つ", s.sourceDocuments, 1);
  check("1版複数チャンク: 別version無し", findMultiVariantCanonicals(rows).length, 0);
  check("1版複数チャンク: 衝突なし", auditShadowColumns(rows).collisions.length, 0);
}

// ── ケース3: 1実体 = 2版（実データにある既知の3録音の形） ──────────
{
  const rows = [
    row("plaud:CCC", "ccc-bare-hash", 0, { organization: "北九州市" }),
    row("plaud:CCC", "https://app.notion.com/ccc", 0, { organization: "北九州市" }),
  ];
  const s = summarizeShadow(rows);
  check("1実体2版: chunk数", s.chunks, 2);
  check("1実体2版: 実体は1つ", s.canonicalDocuments, 1);
  check("1実体2版: 取り込み文書は2つ", s.sourceDocuments, 2);

  const multi = findMultiVariantCanonicals(rows);
  check("1実体2版: 別versionとして1件挙がる", multi.length, 1);
  check("1実体2版: version数", multi[0].variantCount, 2);
  check("1実体2版: 実体ID", multi[0].canonicalDocumentId, "plaud:CCC");

  const a = auditShadowColumns(rows);
  // 版どうしの衝突は無い。実体で見ると同じ番号が並ぶが、それは設計どおり。
  check("1実体2版: 版の中では衝突しない", a.collisions.length, 0);
  check("1実体2版: 実体で見ると同番が並ぶ", a.canonicalIndexCollisions, 1);
  check("1実体2版: それでも健全", a.healthy, true);
}

// ── ケース4: 1実体 = 複数版 × 複数チャンク ★将来壊れる条件 ──────────
//   同じ録音Aについて、PLAUD経由の要約版が3チャンク、Notion経由の別版が3チャンク。
//   実体で番号を振る実装だと 0..5 の一列になり、版の境界が消える。
{
  const rows = [
    row("plaud:DDD", "plaud:DDD", 0),
    row("plaud:DDD", "plaud:DDD", 1),
    row("plaud:DDD", "plaud:DDD", 2),
    row("plaud:DDD", "https://app.notion.com/ddd", 0),
    row("plaud:DDD", "https://app.notion.com/ddd", 1),
    row("plaud:DDD", "https://app.notion.com/ddd", 2),
  ];
  const s = summarizeShadow(rows);
  check("複数版×複数チャンク: chunk数", s.chunks, 6);
  check("複数版×複数チャンク: 実体は1つ", s.canonicalDocuments, 1);
  check("複数版×複数チャンク: 取り込み文書は2つ", s.sourceDocuments, 2);

  const multi = findMultiVariantCanonicals(rows);
  check("複数版×複数チャンク: 別version1件", multi.length, 1);
  check("複数版×複数チャンク: version数", multi[0].variantCount, 2);
  check("複数版×複数チャンク: 各versionが3チャンク",
    multi[0].variants.map((v) => v.chunks), [3, 3]);

  const a = auditShadowColumns(rows);
  // ここが要。版ごとに 0,1,2 が独立しているので、版の中での衝突はゼロ。
  check("複数版×複数チャンク: 版の中では衝突ゼロ", a.collisions.length, 0);
  // 実体で見ると 0,1,2 が2組ぶん並ぶ＝3組。これは異常ではない。
  check("複数版×複数チャンク: 実体で見ると3組が同番", a.canonicalIndexCollisions, 3);
  check("複数版×複数チャンク: 健全", a.healthy, true);
  check("複数版×複数チャンク: 親子関係は壊れていない",
    a.variantsSpanningCanonicals.length, 0);
}

// ── 異常系: 版の中で番号が重複したら検知する ────────────────────
{
  const rows = [
    row("plaud:EEE", "plaud:EEE", 0),
    row("plaud:EEE", "plaud:EEE", 0),
  ];
  const a = auditShadowColumns(rows);
  check("異常系: 版の中の重複を検知", a.collisions.length, 1);
  check("異常系: 重複の行数", a.collisions[0].rows, 2);
  check("異常系: 健全でない", a.healthy, false);
}

// ── 異常系: 1つの取り込み文書が複数の実体にまたがる（親子関係の破壊） ──
{
  const rows = [
    row("plaud:FFF", "shared-doc", 0),
    row("plaud:GGG", "shared-doc", 1),
  ];
  const a = auditShadowColumns(rows);
  check("異常系: 実体をまたぐ取り込み文書を検知", a.variantsSpanningCanonicals.length, 1);
  check("異常系: またいだ実体の数",
    a.variantsSpanningCanonicals[0].canonicalDocumentIds.length, 2);
  check("異常系: 健全でない", a.healthy, false);
}

// ── 異常系: 列の欠損を数える（0をハードコードせず実データから数える） ──
{
  const rows = [
    row("plaud:HHH", "plaud:HHH", 0),
    { source_type: "会議", canonical_document_id: null, source_document_id: null,
      chunk_index: null, ingest_scheme: null },
  ];
  const a = auditShadowColumns(rows);
  check("欠損: canonical", a.canonicalNull, 1);
  check("欠損: source_document", a.sourceDocumentNull, 1);
  check("欠損: chunk_index", a.chunkIndexNull, 1);
  check("欠損: ingest_scheme", a.ingestSchemeNull, 1);
  check("欠損: 健全でない", a.healthy, false);
  // chunk_index が 0 は「欠損」ではない
  check("欠損: 0は欠損として数えない", auditShadowColumns([row("x", "x", 0)]).chunkIndexNull, 0);
}

// ── source_type ごとの内訳 ────────────────────────────────────
{
  const rows = [
    row("plaud:III", "plaud:III", 0, { source_type: "会議" }),
    row("deliverable:A", "deliverable:A", 0, { source_type: "成果物" }),
    row("deliverable:A", "deliverable:A", 1, { source_type: "成果物" }),
  ];
  const s = summarizeShadow(rows);
  check("内訳: chunk数の多い順", s.bySourceType.map((b) => b.sourceType), ["成果物", "会議"]);
  check("内訳: 成果物のchunk数", s.bySourceType[0].chunks, 2);
  check("内訳: 成果物の実体数", s.bySourceType[0].canonicalDocuments, 1);
}

// ── 旧方式との突き合わせ ──────────────────────────────────────
{
  const shadow = [
    { sourceType: "会議", chunks: 287, canonicalDocuments: 104, sourceDocuments: 108 },
    { sourceType: "週報", chunks: 93, canonicalDocuments: 93, sourceDocuments: 93 },
    { sourceType: "未知", chunks: 1, canonicalDocuments: 1, sourceDocuments: 1 },
  ];
  const c = compareWithOld(shadow, { 会議: 105, 週報: 87 });
  check("突き合わせ: 会議の差分", c[0].diff, -1);
  check("突き合わせ: 週報の差分", c[1].diff, 6);
  check("突き合わせ: 旧方式に無い型は null", [c[2].oldDocuments, c[2].diff], [null, null]);
}

console.log(`\n合格 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`\x1b[31m✗ Shadow Mode の純粋ロジックが ${failed} 件落ちました\x1b[0m`);
  process.exit(1);
}
