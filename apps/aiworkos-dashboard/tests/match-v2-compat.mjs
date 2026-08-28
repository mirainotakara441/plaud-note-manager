#!/usr/bin/env node
// match_memory_chunks_v2 が「旧RAGに列を4本足しただけ」であることを本番データで固定する。
//
// ■ なぜ本番DBを見るテストなのか
// v2 の目的は「旧と1行も違わないこと」。純粋ロジックに切り出せる部分が無く、
// 確かめたい性質そのものがDBの中にある。smoke.mjs も同じくSupabaseに届く。
//
// ■ v2 は service_role でしか実行できない
// まだユーザー向けの経路に出さないため anon から実行できないようにしてある。
// このテストは .env.local の SUPABASE_SERVICE_ROLE_KEY を使う。
//
// ■ 検索ベクトルの作り方（重要）
// gte-small は Edge Function の中でしか動かせないので、クエリ文字列から
// 埋め込みを作れない。代わりに**そのテーマの実在行の embedding をそのまま
// 検索ベクトルとして使う**。v1 と v2 に同じベクトルを渡すことが目的なので、
// 互換性の検証としてはこれで十分（埋め込み生成は両者の外側にあり、変えていない）。
//
// ■ fixture について
// 上位の id を丸ごと固定すると、記憶が1行増えるだけで落ちる。
// 固定するのは「シード行が実在すること」と「v1とv2が一致すること」、そして
// dedupしていないこと・match_countがchunk件数のままであること。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadEnv() {
  const out = { ...process.env };
  const f = path.join(ROOT, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      if (!out[k]) out[k] = t.slice(i + 1).trim();
    }
  }
  return out;
}

const env = loadEnv();
const BASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`\x1b[31m✗ ${label}\x1b[0m`);
    if (detail !== undefined) console.error(`    ${detail}`);
  }
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rpc(fn, params) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function embeddingOf(id) {
  const res = await fetch(`${BASE}/rest/v1/memory_chunks?id=eq.${id}&select=embedding`, { headers });
  if (!res.ok) throw new Error(`embedding取得: HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0]?.embedding ?? null;
}

// 代表検索。行idは実在する固定の種（fixture）。
const CASES = [
  { label: "北九州市", id: "4899ba17-a8b7-4884-ab2b-7e55f9203b78", n: 20 },
  { label: "ソフトバンク", id: "382f4982-43d8-4a31-8bc8-8f400200d9f7", n: 20 },
  { label: "定額小為替", id: "18e7b189-56cf-4cd1-92c2-735367bf72af", n: 20 },
  { label: "八王子市", id: "75685fe0-5ae2-4fc6-9e5a-f16cdd35d5af", n: 20 },
  { label: "練馬区", id: "ff454bb1-f8cc-40e6-a97a-15eb40631dad", n: 20 },
  { label: "週報の一般語", id: "1fb83043-28ea-467c-a6ea-d4fdb0d14772", n: 20 },
  { label: "北九州市+成果物", id: "4899ba17-a8b7-4884-ab2b-7e55f9203b78", n: 20, st: "成果物" },
  { label: "既定件数8", id: "4899ba17-a8b7-4884-ab2b-7e55f9203b78", n: 8 },
];

const V1_COLUMNS = [
  "id", "source_type", "source_id", "organization",
  "title", "content", "event_date", "metadata", "similarity",
];
const IDENTITY_COLUMNS = [
  "canonical_document_id", "source_document_id", "chunk_index", "ingest_scheme",
];

if (!BASE || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません（.env.local）");
  process.exit(1);
}

let anyMultiChunkDoc = false;
let anySharedCanonical = false;

for (const c of CASES) {
  const emb = await embeddingOf(c.id);
  check(`${c.label}: シード行が実在する`, emb !== null, `id=${c.id}`);
  if (!emb) continue;

  const params = {
    query_embedding: emb,
    match_count: c.n,
    filter_source_type: c.st ?? null,
    filter_organization: c.org ?? null,
  };
  const [a, b] = await Promise.all([
    rpc("match_memory_chunks", params),
    rpc("match_memory_chunks_v2", params),
  ]);

  // --- v1/v2 の一致 -------------------------------------------------
  check(`${c.label}: 返却件数が一致`, a.length === b.length, `v1=${a.length} v2=${b.length}`);
  check(
    `${c.label}: 並び順（id）が一致`,
    JSON.stringify(a.map((r) => r.id)) === JSON.stringify(b.map((r) => r.id))
  );
  check(
    `${c.label}: similarity が一致`,
    JSON.stringify(a.map((r) => r.similarity)) === JSON.stringify(b.map((r) => r.similarity))
  );
  check(
    `${c.label}: 旧9列の中身が一致`,
    JSON.stringify(a.map((r) => V1_COLUMNS.map((k) => r[k]))) ===
      JSON.stringify(b.map((r) => V1_COLUMNS.map((k) => r[k])))
  );

  if (b.length === 0) continue;

  // --- v2 が足した4列 ------------------------------------------------
  check(
    `${c.label}: v2 が13列を返す`,
    Object.keys(b[0]).length === 13,
    `列=${Object.keys(b[0]).join(",")}`
  );
  for (const col of IDENTITY_COLUMNS) {
    check(
      `${c.label}: ${col} が全行で未設定でない`,
      b.every((r) => r[col] !== null && r[col] !== undefined)
    );
  }
  check(
    `${c.label}: chunk_index が整数`,
    b.every((r) => Number.isInteger(r.chunk_index))
  );

  // --- match_count は chunk 件数のまま（documentに畳んでいない）--------
  check(`${c.label}: 要求件数を超えない`, b.length <= c.n, `${b.length} > ${c.n}`);
  const docs = new Set(b.map((r) => r.source_document_id));
  const canons = new Set(b.map((r) => r.canonical_document_id));
  if (docs.size < b.length) anyMultiChunkDoc = true;
  if (canons.size < b.length) anySharedCanonical = true;
}

// 同じ取り込み文書の複数チャンクが結果に並ぶこと＝documentで畳んでいない証拠。
// ここが false になったら、どこかで dedup が入ったということ。
check(
  "同じ取り込み文書の複数チャンクが結果に並ぶ（dedupしていない）",
  anyMultiChunkDoc,
  "全ケースで source_document_id が一意だった＝畳まれている可能性"
);
check(
  "同じ実体の複数チャンクが結果に並ぶ（canonicalでも畳んでいない）",
  anySharedCanonical
);

// 同一 canonical に複数の取り込み文書がある実体（本番に3件）を v2 が素通しすること。
// 畳む実装を入れたらここが落ちる。
{
  const res = await fetch(
    `${BASE}/rest/v1/memory_chunks?select=canonical_document_id,source_document_id&canonical_document_id=eq.plaud:b08f952edde1234412b51c23b51af665`,
    { headers }
  );
  const rows = await res.json();
  const docs = new Set(rows.map((r) => r.source_document_id));
  check(
    "同一実体に複数の取り込み文書がある例が残っている（plaud:b08f952e…）",
    rows.length === 3 && docs.size === 3,
    `行=${rows.length} 取込文書=${docs.size}`
  );
}

// v2 は service_role 専用。anon から実行できてはいけない。
// 「anonで叩いたら失敗した」だけでは、鍵が悪いのか権限が無いのか区別が付かない。
// 同じ鍵で v1 が通ることを先に確かめてから、v2 が弾かれることを見る。
{
  const anon = env.SUPABASE_ANON_KEY;
  if (anon) {
    const emb = await embeddingOf(CASES[0].id);
    const callAsAnon = (fn) =>
      fetch(`${BASE}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query_embedding: emb, match_count: 1 }),
      });

    const v1 = await callAsAnon("match_memory_chunks");
    check("anonキー自体は有効（v1は実行できる）", v1.status === 200, `HTTP ${v1.status}`);

    const v2 = await callAsAnon("match_memory_chunks_v2");
    check(
      "v2 は anon から実行できない",
      [401, 403, 404].includes(v2.status),
      `HTTP ${v2.status}（200なら権限が緩んでいる）`
    );
  }
}

console.log(`\n合格 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
