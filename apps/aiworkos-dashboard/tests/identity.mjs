#!/usr/bin/env node
// Identity 導出（lib/memoryIdentity.mjs）のテスト。
//
// サーバもDBも要らない。node が直接動かす。
//
// Identity の入力は source_type / source_id / metadata / chunkIndex だけ。
// title は第7.2弾の実測（有無による差 0/1458）を経て引数から外した。
//
// ここで固定しているのは「本番1458行に実際に入っている形」だけではなく、
// **まだ実データに存在しない形**も含む。特に最後の
// 「1実体 × 複数の取り込み文書 × 複数チャンク」は、同じ録音から
// PLAUD版とNotion版がそれぞれ複数チャンクで入った瞬間に効いてくる。
// 実体で番号を振る実装だと、そこで版の境界が消える。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CALLER_FORBIDDEN_KEYS,
  deriveIdentity,
  identityColumns,
} from "../lib/memoryIdentity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/** 4列だけを取り出して比べる。 */
function id4(input) {
  const r = deriveIdentity(input);
  return [r.canonical_document_id, r.source_document_id, r.chunk_index, r.ingest_scheme];
}

// ── 1. PLAUD 大文字 ID（Notion経由の会議に付いている表記） ──────────
check(
  "PLAUD 大文字ID",
  id4({
    source_type: "会議",
    source_id: "36dba3aa883b02b799a6a9e4e6b8bd43",
    metadata: { PLAUD_ID: "36DBA3AA883B02B799A6A9E4E6B8BD43" },
  }),
  ["plaud:36dba3aa883b02b799a6a9e4e6b8bd43", "36dba3aa883b02b799a6a9e4e6b8bd43", 0, "plaud"]
);

// ── 2. plaud 小文字 ID（plaud-meeting-daily-sync スキルが書く表記） ──
check(
  "plaud 小文字ID",
  id4({
    source_type: "会議",
    source_id: "plaud:0163e091cb2e6076054442cf31a619c8",
    metadata: { plaud_id: "0163e091cb2e6076054442cf31a619c8", category: "自治体" },
  }),
  [
    "plaud:0163e091cb2e6076054442cf31a619c8",
    "plaud:0163e091cb2e6076054442cf31a619c8",
    0,
    "plaud",
  ]
);

// ── 3. Notion URL（日記。スラッグ付きでも末尾32桁を取る） ──────────
check(
  "Notion URL",
  id4({
    source_type: "日記",
    source_id: "https://app.notion.com/p/8-9-39-3b99363cfff8813194d6e2bf66369ccb",
    metadata: { タグ: ["家族"] },
  }),
  [
    "notion:3b99363cfff8813194d6e2bf66369ccb",
    "https://app.notion.com/p/8-9-39-3b99363cfff8813194d6e2bf66369ccb",
    0,
    "notion",
  ]
);

// ── 4. 録音ID付きのNotion ★実体は録音に寄せる ────────────────
//   同じ録音から作られたNotionページは、ページIDではなく録音IDで束ねる。
//   scheme も notion ではなく plaud になる（バックフィルがそうしている）。
check(
  "録音ID付きNotion",
  id4({
    source_type: "会議",
    source_id: "https://app.notion.com/39a9363cfff881158ba4e020cb0170fb",
    metadata: { PLAUD_ID: "36dba3aa883b02b799a6a9e4e6b8bd43" },
  }),
  [
    "plaud:36dba3aa883b02b799a6a9e4e6b8bd43",
    "https://app.notion.com/39a9363cfff881158ba4e020cb0170fb",
    0,
    "plaud",
  ]
);

// ── 5. meeting の複数チャンク（ファイル名にコロンが入る実データ形） ──
{
  const base = "meeting:ソフトバンク:text:統括部長挨拶：トライアル申込書のお礼:2026-08-24";
  check(
    "meeting 1チャンク目",
    id4({ source_type: "会議", source_id: `${base}:1`, metadata: { 位置: "1/3" } }),
    [base, base, 0, "meeting"]
  );
  check(
    "meeting 3チャンク目",
    id4({ source_type: "会議", source_id: `${base}:3`, metadata: { 位置: "3/3" } }),
    [base, base, 2, "meeting"]
  );
}

// ── 6. deliverable の複数チャンク ★caller の index が要る唯一の経路 ──
{
  const base = "deliverable:経済同友会提言:本文.pdf";
  // 位置は `p8-1` のような札で、順番はその行だけでは決まらない
  const r = deriveIdentity({
    source_type: "成果物",
    source_id: `${base}:p8-1`,
    metadata: { 位置: "p8-1", ファイル名: "本文.pdf" },
  });
  check("deliverable: 版のIDは位置を文字列一致で外す", r.source_document_id, base);
  check("deliverable: caller の index が要ると申告する", r.needsCallerChunkIndex, true);
  check("deliverable: index が無ければ0に固定（通し番号で埋めない）", r.chunk_index, 0);

  check(
    "deliverable: caller の index を渡せば確定",
    id4({
      source_type: "成果物",
      source_id: `${base}:p8-2`,
      metadata: { 位置: "p8-2", ファイル名: "本文.pdf" },
      chunkIndex: 17,
    }),
    [base, base, 17, "deliverable"]
  );

  // ファイル名にコロンと数字が入る形でも削り過ぎない
  const untitled = "deliverable:ソフトバンク:text:無題:2026-08-26";
  check(
    "deliverable: ファイル名のコロンで削り過ぎない",
    deriveIdentity({
      source_type: "成果物",
      source_id: `${untitled}:text10`,
      metadata: { 位置: "text10" },
    }).source_document_id,
    untitled
  );

  // 復元スクリプト由来はタイトル末尾の ｜N から番号が決まり、caller は要らない
  const restored = deriveIdentity({
    source_type: "成果物",
    source_id: "deliverable:共通:法人請求オンラインサービス_初回提案資料.pptx#6",
    title: "法人請求オンラインサービス 初回提案資料｜提案書｜slide1｜6",
    metadata: { 位置: "slide1", 生成元: "documents-final" },
  });
  check("deliverable(復元): #N から番号が決まる", restored.chunk_index, 5);
  check("deliverable(復元): caller は不要", restored.needsCallerChunkIndex, false);
}

// ── 7. internal（週報・振り返り・壁打ち系） ──────────────────
check(
  "internal 週報",
  id4({
    source_type: "週報",
    source_id: "weekly_report:01275a86-cde7-4087-a1d6-2a5563545602:1",
    metadata: { 種別: "週報", カテゴリ: "全体" },
  }),
  [
    "weekly_report:01275a86-cde7-4087-a1d6-2a5563545602",
    "weekly_report:01275a86-cde7-4087-a1d6-2a5563545602",
    0,
    "internal",
  ]
);
check(
  "internal slide-refine（refine と取り違えない）",
  id4({ source_type: "成果物", source_id: "slide-refine:4a844003-410a-4627-b1e4-0fba0de58586:3" }),
  [
    "slide-refine:4a844003-410a-4627-b1e4-0fba0de58586",
    "slide-refine:4a844003-410a-4627-b1e4-0fba0de58586",
    2,
    "internal",
  ]
);

// ── 8. catalog（QA・武器・学会・実績） ──────────────────────
check(
  "catalog qa",
  id4({ source_type: "成果物", source_id: "qa:法人請求:A-01:2" }),
  ["qa:法人請求:A-01", "qa:法人請求:A-01", 1, "catalog"]
);
check(
  "catalog gakkai（末尾に番号が無い）",
  id4({ source_type: "学会", source_id: "gakkai:創価池田本部会合2026-07-19" }),
  ["gakkai:創価池田本部会合2026-07-19", "gakkai:創価池田本部会合2026-07-19", 0, "catalog"]
);

// ── 9. source_id 欠損 ★埋めずに null を返す ──────────────────
check("source_id なし", id4({ source_type: "会議", metadata: {} }), [null, null, null, null]);
check("source_id 空文字", id4({ source_type: "会議", source_id: "   " }), [null, null, null, null]);

// ── 10. 未知の書式 ★黙って埋めない ──────────────────────────
//   埋めてしまうと「知らない writer が増えた」ことに気づけなくなる。
check(
  "未知の書式は null（接頭辞の無い裸UUID）",
  id4({ source_type: "月次報告", source_id: "3f2a9c10-1b2c-4d5e-8f90-abcdef123456" }),
  [null, null, null, null]
);
check(
  "未知の接頭辞も null",
  id4({ source_type: "その他", source_id: "somethingnew:abc:1" }),
  [null, null, null, null]
);

// ── 11. monthly（月次報告） ────────────────────────────────
//   裸のUUIDだと分類できないので、writer 側で `monthly_briefing:` を付ける。
//   実データ0件のうちに書式を決めた（第7.0弾）。
{
  const uuid = "3f2a9c10-1b2c-4d5e-8f90-abcdef123456";
  check(
    "monthly",
    id4({
      source_type: "月次報告",
      source_id: `monthly_briefing:${uuid}`,
      metadata: { month: "2026-08", audience: "石田本部長" },
    }),
    [`monthly_briefing:${uuid}`, `monthly_briefing:${uuid}`, 0, "monthly"]
  );
  check(
    "monthly: 接頭辞が無い裸UUIDは未知として弾く",
    id4({ source_type: "月次報告", source_id: uuid }),
    [null, null, null, null]
  );
}

// ── 12. 1実体 × 複数の取り込み文書 × 複数チャンク ★将来壊れる条件 ──
{
  const rec = "b08f952edde1234412b51c23b51af665";
  const rows = [
    // PLAUD版 3チャンク
    { source_id: `plaud:${rec}`, metadata: { plaud_id: rec }, title: "録音A｜1" },
    { source_id: `plaud:${rec}#2`, metadata: { plaud_id: rec }, title: "録音A｜2" },
    { source_id: `plaud:${rec}#3`, metadata: { plaud_id: rec }, title: "録音A｜3" },
    // Notion版 3チャンク（同じ録音から作られた別版）
    { source_id: "https://app.notion.com/39a9363cfff8818bb1b6f3bcc2fafc6b", metadata: { PLAUD_ID: rec }, title: "録音A要約｜1" },
    { source_id: "https://app.notion.com/39a9363cfff8818bb1b6f3bcc2fafc6b#2", metadata: { PLAUD_ID: rec }, title: "録音A要約｜2" },
    { source_id: "https://app.notion.com/39a9363cfff8818bb1b6f3bcc2fafc6b#3", metadata: { PLAUD_ID: rec }, title: "録音A要約｜3" },
  ].map((x) => deriveIdentity({ source_type: "会議", ...x }));

  check(
    "複数版×複数チャンク: 実体は1つに束なる",
    [...new Set(rows.map((r) => r.canonical_document_id))],
    [`plaud:${rec}`]
  );
  check(
    "複数版×複数チャンク: 取り込み文書は2つに分かれる",
    [...new Set(rows.map((r) => r.source_document_id))].length,
    2
  );
  check(
    "複数版×複数チャンク: 番号は版ごとに 0,1,2 で独立する",
    rows.map((r) => r.chunk_index),
    [0, 1, 2, 0, 1, 2]
  );
  // 版の中では一意。実体で見ると同じ番号が並ぶが、それが正しい姿。
  const perDoc = new Set(rows.map((r) => `${r.source_document_id}␟${r.chunk_index}`));
  check("複数版×複数チャンク: 版の中では衝突しない", perDoc.size, 6);
  const perCanonical = new Set(rows.map((r) => `${r.canonical_document_id}␟${r.chunk_index}`));
  check("複数版×複数チャンク: 実体で見ると3組が重なる", perCanonical.size, 3);
}

// ── 番号の優先順：明示があれば caller より優先する ────────────────
check(
  "明示番号は caller の値に上書きされない",
  deriveIdentity({
    source_type: "会議",
    source_id: "meeting:横浜市:text:面談:2026-08-01:3",
    metadata: { 位置: "3/5" },
    chunkIndex: 99,
  }).chunk_index,
  2
);

// ── Gateway の契約：DBへ書く4列 ────────────────────────────
{
  const ident = deriveIdentity({
    source_type: "会議",
    source_id: "meeting:横浜市:text:面談:2026-08-01:2",
    metadata: { 位置: "2/4" },
  });
  check(
    "書き込む列は4つだけ",
    Object.keys(identityColumns(ident)).sort(),
    ["canonical_document_id", "chunk_index", "ingest_scheme", "source_document_id"]
  );
  check("書き込む値", identityColumns(ident), {
    canonical_document_id: "meeting:横浜市:text:面談:2026-08-01",
    source_document_id: "meeting:横浜市:text:面談:2026-08-01",
    chunk_index: 1,
    ingest_scheme: "meeting",
  });
  check(
    "caller が指定してはいけないキー",
    [...CALLER_FORBIDDEN_KEYS].sort(),
    ["canonical_document_id", "embedding", "ingest_scheme", "source_document_id"]
  );
}

// ── store-memory が INSERT と UPDATE の両方で4列を書くこと ──────────
//   UPDATE 側に入れ忘れると、入れ直しのたびに古い同一性が残り続ける。
//   これは実際に起こしやすい抜けなので、コードの形として固定しておく。
{
  const src = readFileSync(join(ROOT, "supabase/functions/store-memory/index.ts"), "utf8");
  const insertBlock = src.slice(src.indexOf(".insert({"), src.indexOf(".insert({") + 400);
  const updateBlock = src.slice(src.indexOf(".update({"), src.indexOf(".update({") + 400);
  check("store-memory: INSERT に4列が入る", insertBlock.includes("...ident"), true);
  check("store-memory: UPDATE にも4列が入る", updateBlock.includes("...ident"), true);
  check("store-memory: 導出不能を422で落とす", /status:\s*422/.test(src), true);
  check(
    "store-memory: caller の chunk_index 不足も422で落とす（0を入れて成功させない）",
    src.includes("identity.needsCallerChunkIndex"),
    true
  );
  check("store-memory: caller 指定を400で弾く", src.includes("CALLER_FORBIDDEN_KEYS"), true);
  check(
    "store-memory: 実装を共有モジュールから読む（二重実装しない）",
    src.includes('from "../_shared/identity.mjs"'),
    true
  );
}

// ── スキル deliverable-to-supabase が送る形（chunk_index つき） ──────
//   位置ラベルは slideN / pN / chunkN の3種。どれも並び順ではないので
//   caller の index が要る。index を渡せば422にならないことを固定する。
{
  for (const [pos, i] of [["slide1", 0], ["slide2", 1], ["p12", 11], ["chunk3", 2]]) {
    const r = deriveIdentity({
      source_type: "成果物",
      source_id: `deliverable:北九州市:提案書.pptx:${pos}`,
      metadata: { 種別: "提案書", カテゴリ: "自治体", ファイル名: "提案書.pptx", 位置: pos, 資料名: "提案書" },
      chunkIndex: i,
    });
    check(`スキル形状(${pos}): caller index で解消`, r.needsCallerChunkIndex, false);
    check(`スキル形状(${pos}): chunk_index`, r.chunk_index, i);
    check(`スキル形状(${pos}): 版のID`, r.source_document_id, "deliverable:北九州市:提案書.pptx");
  }
  // index を送らなければ 422 相当（Gateway が弾く）ままであること
  check(
    "スキル形状: index を送らなければ弾かれる",
    deriveIdentity({
      source_type: "成果物",
      source_id: "deliverable:北九州市:提案書.pptx:slide1",
      metadata: { 位置: "slide1" },
    }).needsCallerChunkIndex,
    true
  );
}

// ── deliverables が0起点indexを渡すこと ────────────────────────
{
  const src = readFileSync(join(ROOT, "app/api/deliverables/route.ts"), "utf8");
  check("deliverables: chunk_index を渡す", src.includes("chunk_index: i"), true);
}

// ── monthly-report が store-memory / purge-memory を通ること ──────
{
  const src = readFileSync(join(ROOT, "app/api/monthly-report/briefings/route.ts"), "utf8");
  check("monthly: store-memory 経由", src.includes("functions/v1/store-memory"), true);
  check("monthly: purge-memory 経由", src.includes("functions/v1/purge-memory"), true);
  check("monthly: source_id に接頭辞", src.includes("`monthly_briefing:${id}`"), true);
  check(
    "monthly: memory_chunks を直に叩かない",
    src.includes("rest/v1/memory_chunks") || src.includes("MEMORY_TABLE"),
    false
  );
}

// ── title は同一性に影響しない ────────────────────────────────
check(
  "title を渡しても結果が変わらない",
  id4({ source_type: "会議", source_id: "plaud:abc123", metadata: { plaud_id: "ABC123" }, title: "｜9" }),
  id4({ source_type: "会議", source_id: "plaud:abc123", metadata: { plaud_id: "ABC123" } })
);

console.log(`\n合格 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`\x1b[31m✗ Identity 導出が ${failed} 件落ちました\x1b[0m`);
  process.exit(1);
}
