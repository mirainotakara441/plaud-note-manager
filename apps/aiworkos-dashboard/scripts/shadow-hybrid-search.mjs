#!/usr/bin/env node
// ハイブリッド検索 Shadow 比較（v2: ベクトルのみ vs v3: ベクトル+pgroonga全文のRRF）
//
// 目的:
//   「v3 に切り替えてよいか」を勘でなく実測で判断する材料を作る。
//   本番の読み口（search-memory）は v2 のまま。このスクリプトは読むだけ。
//
// 見るもの:
//   1. v3 が v2 に無い行を上位8に入れたか（新規獲得）。その行は本当に
//      クエリ語を含むか（＝全文側が意味のある仕事をしたか、ノイズか）
//   2. v2 の上位が v3 で消えたか（失うものの大きさ）
//   3. 応答時間の差
//
// 使い方: node scripts/shadow-hybrid-search.mjs
//   .env.local の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY を使う。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const URL_ = env.SUPABASE_URL;
const SVC = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.SUPABASE_ANON_KEY;
if (!URL_ || !SVC || !ANON) {
  console.error("SUPABASE_URL / SERVICE_ROLE / ANON が .env.local に必要");
  process.exit(2);
}

// クエリセット。2系統を混ぜる:
//   [kw] 固有名詞・数字 … ベクトルが苦手なはずの領域。全文の価値が出るならここ
//   [sem] 意味検索 … ベクトルが得意な領域。v3 がここを壊していないかを見る
// keyword: 「新規獲得行がこの語を含んでいれば意味のある獲得」と判定する語
const QUERIES = [
  { q: "アイフル", kind: "kw", keyword: "アイフル" },
  { q: "内本部長", kind: "kw", keyword: "内本" },
  { q: "書かない窓口", kind: "kw", keyword: "書かない窓口" },
  { q: "定額小為替", kind: "kw", keyword: "定額小為替" },
  { q: "尾崎議員", kind: "kw", keyword: "尾崎" },
  { q: "岸和田市", kind: "kw", keyword: "岸和田" },
  { q: "人口カバー率 15%", kind: "kw", keyword: "カバー" },
  { q: "郵便料金 値上げ", kind: "kw", keyword: "郵便" },
  { q: "決裁が通らない理由", kind: "sem", keyword: null },
  { q: "自治体への提案がうまくいった要因", kind: "sem", keyword: null },
  { q: "体調と仕事の両立", kind: "sem", keyword: null },
  { q: "議員への訴求の仕方", kind: "sem", keyword: null },
];

const MATCH = 8;

async function embed(text) {
  const res = await fetch(`${URL_}/functions/v1/embed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  return (await res.json()).embedding;
}

async function rpc(fn, body) {
  const t0 = Date.now();
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { rows: await res.json(), ms: Date.now() - t0 };
}

const report = [];
let v2ms = 0, v3ms = 0;

for (const t of QUERIES) {
  const emb = await embed(t.q);
  const v2 = await rpc("match_memory_chunks_v2", {
    query_embedding: emb, match_count: MATCH,
  });
  const v3 = await rpc("match_memory_chunks_v3", {
    query_embedding: emb, query_text: t.q, match_count: MATCH,
  });
  v2ms += v2.ms; v3ms += v3.ms;

  const v2ids = new Set(v2.rows.map((r) => r.id));
  const v3ids = new Set(v3.rows.map((r) => r.id));
  const gained = v3.rows.filter((r) => !v2ids.has(r.id));
  const lost = v2.rows.filter((r) => !v3ids.has(r.id));
  const hasKw = (r) =>
    t.keyword ? (r.title + " " + r.content).includes(t.keyword) : null;

  report.push({
    query: t.q, kind: t.kind,
    overlap: MATCH - gained.length,
    gained: gained.map((r) => ({
      title: r.title.slice(0, 45), st: r.source_type,
      text_rank: r.text_rank, vec_rank: r.vec_rank, kw: hasKw(r),
    })),
    lost: lost.map((r) => ({
      title: r.title.slice(0, 45), st: r.source_type,
      sim: Number(r.similarity?.toFixed(3)), kw: hasKw(r),
    })),
    v2kw: t.keyword ? v2.rows.filter(hasKw).length : null,
    v3kw: t.keyword ? v3.rows.filter(hasKw).length : null,
    v2ms: v2.ms, v3ms: v3.ms,
  });
  process.stderr.write(".");
}
process.stderr.write("\n");

// ---- 集計 ----
let kwQueries = 0, kwImproved = 0, kwSame = 0, kwWorse = 0;
let gainedTotal = 0, gainedWithKw = 0, gainedNoise = 0;
for (const r of report) {
  if (r.v2kw !== null) {
    kwQueries++;
    if (r.v3kw > r.v2kw) kwImproved++;
    else if (r.v3kw === r.v2kw) kwSame++;
    else kwWorse++;
    for (const g of r.gained) {
      gainedTotal++;
      if (g.kw === true) gainedWithKw++;
      if (g.kw === false) gainedNoise++;
    }
  }
}

console.log(JSON.stringify({
  summary: {
    queries: QUERIES.length,
    kw: { total: kwQueries, v3の方がキーワード行が多い: kwImproved, 同数: kwSame, v3の方が少ない: kwWorse },
    gained: { 合計: gainedTotal, クエリ語を含む: gainedWithKw, 含まないノイズ: gainedNoise },
    avgMs: { v2: Math.round(v2ms / QUERIES.length), v3: Math.round(v3ms / QUERIES.length) },
  },
  detail: report,
}, null, 1));
