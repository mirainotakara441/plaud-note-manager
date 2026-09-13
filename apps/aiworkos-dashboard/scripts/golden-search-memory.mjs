#!/usr/bin/env node
// search-memory（本番の読み口）の Golden 採取。
//
// ■ 何のためか
//   ハイブリッド検索（v3）へ切り替える前に、**今の実経路の応答**を固定しておく。
//   切替後に同じ入力で再取得して突合し、差分が「意図した改善」だけであることを
//   確かめる（production-change-protocol §5）。切替の意思決定より先に採る——
//   切り替えてから「前はどうだったか」は二度と採れない。
//
// ■ 形式
//   ~/.claude/skills/production-change-protocol/golden-compare.mjs が読める形:
//   { case, payload, status, count, keys, rows:[{id, source_id, title, similarity, content_md5}] }
//
// 使い方:
//   node scripts/golden-search-memory.mjs > tests/golden/search-memory-YYYYMMDD.json

import { createHash } from "node:crypto";
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
const ANON = env.SUPABASE_ANON_KEY;
if (!URL_ || !ANON) {
  console.error("SUPABASE_URL / SUPABASE_ANON_KEY が .env.local に必要");
  process.exit(2);
}

// ケースは search-memory の契約の面を押さえる:
//   素のクエリ / source_type 絞り / organization 絞り / person / theme / match_count
// 固有名詞・意味系の両方を含める（shadow-hybrid-search.mjs のセットと重ねてある）。
const CASES = [
  { case: "素-固有名詞", payload: { query: "アイフル", match_count: 8 } },
  { case: "素-固有名詞2", payload: { query: "内本部長", match_count: 8 } },
  { case: "素-複合語", payload: { query: "書かない窓口", match_count: 8 } },
  { case: "素-制度", payload: { query: "定額小為替", match_count: 8 } },
  { case: "素-意味1", payload: { query: "決裁が通らない理由", match_count: 8 } },
  { case: "素-意味2", payload: { query: "自治体への提案がうまくいった要因", match_count: 8 } },
  { case: "素-意味3", payload: { query: "議員への訴求の仕方", match_count: 8 } },
  { case: "type-会議", payload: { query: "東洋紙業 懸念", source_type: "会議", match_count: 8 } },
  { case: "type-成果物", payload: { query: "横浜市 提案 骨子", source_type: "成果物", match_count: 8 } },
  { case: "type-日記", payload: { query: "睡眠 回復", source_type: "日記", match_count: 8 } },
  { case: "org-熊本市", payload: { query: "熊本市 論点", organization: "熊本市", match_count: 8 } },
  { case: "org-堺市", payload: { query: "堺市 申込", organization: "堺市", match_count: 8 } },
  { case: "count-20", payload: { query: "郵便料金 値上げ", match_count: 20 } },
  { case: "person", payload: { query: "リーダーシップ", person: "伊藤羊一", match_count: 8 } },
  { case: "theme", payload: { query: "組織", theme: "マネジメント・組織", match_count: 8 } },
];

const md5 = (s) => createHash("md5").update(s ?? "", "utf8").digest("hex");

const out = [];
for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(`${URL_}/functions/v1/search-memory`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(c.payload),
  });
  const body = res.ok ? await res.json() : { results: [] };
  const rows = (body.results ?? []).map((r) => ({
    id: r.id,
    source_id: r.source_id,
    title: r.title,
    similarity: typeof r.similarity === "number" ? Number(r.similarity.toFixed(6)) : null,
    content_md5: md5(r.content),
  }));
  out.push({
    case: c.case,
    payload: c.payload,
    status: res.status,
    count: rows.length,
    keys: rows.map((r) => r.id),
    rows,
    ms: Date.now() - t0,
  });
  process.stderr.write(".");
}
process.stderr.write("\n");
// golden-compare.mjs はトップレベルが「ケースの配列」であることを期待する。
// 採取時刻はファイル名（YYYYMMDD）と tests/golden/README.md に記録する。
console.log(JSON.stringify(out, null, 1));
