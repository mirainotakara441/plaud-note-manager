#!/usr/bin/env node
// Memory 2.0 の健全性監視（lib/memoryHealthFindings.mjs）のテスト。
//
// サーバもDBも要らない。合成データで判定と通知の作法を固定する。
//
// ここで守りたいのは主に2つ。
//   ・正常なときに鳴らさないこと（鳴りすぎる通知は無視されるようになる）
//   ・同じ異常で毎朝鳴らさないが、直って再発したらまた鳴ること

import { buildMemoryFindings } from "../lib/memoryHealthFindings.mjs";

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

/** 正常な1行。 */
function row(over = {}) {
  return {
    canonical_document_id: "plaud:aaa",
    source_document_id: "plaud:aaa",
    chunk_index: 0,
    ingest_scheme: "plaud",
    source_type: "会議",
    created_at: "2026-08-20T01:00:00+00:00",
    ...over,
  };
}

const ids = (f) => f.map((x) => x.id);

// ── 正常時は1件も鳴らさない ──────────────────────────────
{
  const rows = [
    row(),
    row({ source_document_id: "plaud:aaa", chunk_index: 1 }),
    row({ canonical_document_id: "notion:bbb", source_document_id: "notion:bbb", ingest_scheme: "notion" }),
  ];
  check("正常: 気づきは0件（通知しない）", buildMemoryFindings(rows).length, 0);
  check("行が無いときも黙る", buildMemoryFindings([]).length, 0);
}

// ── A. 4列の未設定 ──────────────────────────────────────
{
  // 番号は散らす。同じ番号にすると「未設定」と「衝突」の両方が立ってしまう。
  const rows = [
    row(),
    row({ canonical_document_id: null, chunk_index: 1, created_at: "2026-08-25T03:00:00+00:00" }),
    row({ ingest_scheme: null, chunk_index: 2, source_type: "成果物", created_at: "2026-08-26T03:00:00+00:00" }),
  ];
  const f = buildMemoryFindings(rows);
  check("未設定: 1件だけ鳴る", f.length, 1);
  check("未設定: id", f[0].id, "memory2:null:2026-08-25T03:00");
  check("未設定: 重さは alert", f[0].severity, "alert");
  check("未設定: 分野", f[0].area, "取り込み");
  check("未設定: 件数が題に出る", f[0].title.includes("2行"), true);
  check("未設定: 内訳が根拠に出る", f[0].facts[0].includes("実体ID 1行"), true);
  check("未設定: ingest_scheme も内訳に出る", f[0].facts[0].includes("ingest_scheme 1行"), true);
  check("未設定: 確かめに行く先", f[0].href, "/status");

  // chunk_index が 0 は「未設定」ではない
  check("0 は未設定として数えない", buildMemoryFindings([row({ chunk_index: 0 })]).length, 0);
}

// ── B. 版の中での番号の衝突 ──────────────────────────────
{
  const rows = [
    row({ source_document_id: "deliverable:X:a.pdf", canonical_document_id: "deliverable:X:a.pdf", ingest_scheme: "deliverable", chunk_index: 0, created_at: "2026-08-21T00:00:00+00:00" }),
    row({ source_document_id: "deliverable:X:a.pdf", canonical_document_id: "deliverable:X:a.pdf", ingest_scheme: "deliverable", chunk_index: 0, created_at: "2026-08-22T00:00:00+00:00" }),
  ];
  const f = buildMemoryFindings(rows);
  check("衝突: 1件鳴る", f.length, 1);
  check("衝突: id", f[0].id, "memory2:collision:2026-08-21T00:00");
  check("衝突: 組数が題に出る", f[0].title.includes("1組"), true);
  check("衝突: 行数が根拠に出る", f[0].facts[0].includes("2行"), true);
}

// ── C. 1つの取り込み文書が複数の実体にまたがる ──────────────
{
  const rows = [
    row({ canonical_document_id: "plaud:aaa", source_document_id: "shared", chunk_index: 0, created_at: "2026-08-23T00:00:00+00:00" }),
    row({ canonical_document_id: "plaud:bbb", source_document_id: "shared", chunk_index: 1, created_at: "2026-08-24T00:00:00+00:00" }),
  ];
  const f = buildMemoryFindings(rows);
  check("実体またぎ: 1件鳴る", f.length, 1);
  check("実体またぎ: id", f[0].id, "memory2:spanning:2026-08-23T00:00");
  check("実体またぎ: 件数が題に出る", f[0].title.includes("1件"), true);
}

// ── 実体で見たときの同番（別version）は鳴らさない ────────────
{
  // 同じ録音から作られた別々の要約。canonical は同じで chunk_index も同じだが、
  // 取り込み文書が違う。これは設計どおりの姿なので異常ではない。
  const rows = [
    row({ canonical_document_id: "plaud:aaa", source_document_id: "aaa-bare", chunk_index: 0 }),
    row({ canonical_document_id: "plaud:aaa", source_document_id: "https://notion/aaa", chunk_index: 0 }),
  ];
  check("別version は鳴らさない", buildMemoryFindings(rows).length, 0);
}

// ── 複数の異常が同時に出たら、それぞれ鳴る ────────────────────
{
  const rows = [
    row({ canonical_document_id: null, created_at: "2026-08-25T00:00:00+00:00" }),
    row({ source_document_id: "d", canonical_document_id: "d", chunk_index: 3, created_at: "2026-08-26T00:00:00+00:00" }),
    row({ source_document_id: "d", canonical_document_id: "d", chunk_index: 3, created_at: "2026-08-27T00:00:00+00:00" }),
  ];
  const f = buildMemoryFindings(rows);
  check("複数異常: 2件鳴る", f.length, 2);
  check("複数異常: 種類", ids(f).map((x) => x.split(":")[1]), ["null", "collision"]);
}

// ── 重複通知しない／復旧後の再発では鳴る ★ここが要 ──────────────
{
  const day1 = [row(), row({ canonical_document_id: null, chunk_index: 1, created_at: "2026-08-25T03:00:00+00:00" })];
  // 翌日、同じ異常が続いている（行が1つ増えても、いちばん古い行は変わらない）
  const day2 = [...day1, row({ canonical_document_id: null, chunk_index: 2, created_at: "2026-08-26T03:00:00+00:00" })];
  const a = buildMemoryFindings(day1)[0];
  const b = buildMemoryFindings(day2)[0];
  check("継続中: id が変わらない（既読が効く＝毎朝鳴らさない）", a.id, b.id);
  check("継続中: 件数は題に反映される", [a.title.includes("1行"), b.title.includes("2行")], [true, true]);

  // 直った
  check("復旧: 鳴らない", buildMemoryFindings([row()]).length, 0);

  // あとで再発（別の行）
  const relapse = [row(), row({ canonical_document_id: null, chunk_index: 1, created_at: "2026-09-10T03:00:00+00:00" })];
  const c = buildMemoryFindings(relapse)[0];
  check("再発: id が変わる（もう一度鳴る）", c.id !== a.id, true);
  check("再発: id", c.id, "memory2:null:2026-09-10T03:00");
}

// ── 取り切れていないときは題に断りを入れる ────────────────────
{
  const rows = [row(), row({ chunk_index: null, source_document_id: "other", created_at: "2026-08-25T03:00:00+00:00" })];
  const f = buildMemoryFindings(rows, true);
  check("切れているときは断りを入れる", f[0].title.includes("これ以上ある可能性"), true);
}

// ── 検知器が既存の登録に入っていること ────────────────────────
{
  const src = (await import("node:fs")).readFileSync(
    new URL("../lib/advisor/index.ts", import.meta.url),
    "utf8"
  );
  check("検知器が DETECTORS に登録されている", src.includes("memoryDetector,"), true);
  const det = (await import("node:fs")).readFileSync(
    new URL("../lib/advisor/detectors/memory.ts", import.meta.url),
    "utf8"
  );
  check("検知器はページングしている（1000行で切られない）", det.includes('"Range-Unit": "items"'), true);
  check("検知器は判定を持たず共有モジュールを呼ぶ", det.includes("memoryHealthFindings.mjs"), true);
}

console.log(`\n合格 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`\x1b[31m✗ Memory 2.0 の監視が ${failed} 件落ちました\x1b[0m`);
  process.exit(1);
}
